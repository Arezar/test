/*
 * Skpt.js — блокировщик рекламы для ТВ-клиента Lampa, v2.1.0
 *
 * Обычный JS-плагин Lampa: Настройки → Расширения → Добавить плагин (URL) →
 * перезапустить приложение. Никакого manifest.json / расширения браузера не нужно.
 *
 * Рассчитан на ТВ (webOS/Tizen/Android TV): только ES5, без Proxy/Reflect,
 * без let/const/startsWith, без обязательных fetch/Response. Все настройки и
 * диагностика доступны с пульта через экран «Без рекламы» в настройках Lampa —
 * консоль на телевизоре не нужна.
 *
 * Слои защиты (от самого надёжного к страховочному):
 *   1. Player 'create' -> удаление vast_url / vast_banner (реклама из playdata плагинов)
 *   2. /api/ad/get/*  -> поддельный ответ {"ad":[]}      (VastManager не получает рекламу)
 *   3. putScriptAsync  -> не даём загрузиться IMA/VAST SDK
 *   4. fetch/XHR       -> блокировка известных ad-хостов и VAST-эндпоинтов
 *   5. DOM             -> скрытие/остановка рекламных оверлеев, если они всё же появились
 *
 * Ключи localStorage (те же, что использует экран настроек):
 *   skpt_enabled        — 'true'/'false', главный выключатель (по умолчанию включён)
 *   skpt_debug          — 'true'/'false', подробные логи
 *   skpt_hosts          — доп. рекламные домены через запятую (экранная клавиатура)
 *   skpt_rules          — JSON-массив RegExp / {pattern, action} для продвинутых правил
 *   skpt_allow_hosts    — JSON-массив хостов-исключений
 *   skpt_disabled       — устаревший kill-switch ('1'/'true'), оставлен для совместимости
 *
 * Публичный API: window.SkptAdBlock { version, stats, classify, addRule, setHosts,
 *                                     isEnabled, setEnabled, uninstall }
 */
(function (root) {
    'use strict';

    var VERSION = '2.1.0';
    var FLAG = '__skpt_adblock__';

    var con = root.console || { log: function () {}, warn: function () {} };
    var installed = true;
    var cleanups = [];
    var stats = { fetch: 0, xhr: 0, data: 0, scripts: 0, dom: 0 };
    var savedController = '';
    var settingsInstalled = false;
    var adStyle = null;
    var handledNodes = [];   // оверлеи, которым выставили inline display:none

    // ------------------------------------------------------------------
    // Хранилище, логи, главный выключатель
    // ------------------------------------------------------------------
    function storeGet(key, dflt) {
        try {
            var v = root.localStorage.getItem('skpt_' + key);
            return v === null || v === undefined ? dflt : v;
        } catch (e) { return dflt; }
    }

    function storeSet(key, value) {
        var full = 'skpt_' + key;
        try {
            // Пишем через Lampa.Storage, чтобы не рассогласовать его внутренний кэш
            // readed[name] с localStorage (важно для триггеров в настройках).
            var L = root.Lampa;
            if (L && L.Storage && typeof L.Storage.set === 'function') {
                L.Storage.set(full, value, true); // nolisten: без лишних событий синхронизации
            } else {
                root.localStorage.setItem(full, value);
            }
        } catch (e) {
            try { root.localStorage.setItem(full, value); } catch (e2) {}
        }
    }

    function isTrue(v) { return v === '1' || v === 'true' || v === true; }
    function isFalse(v) { return v === '0' || v === 'false' || v === false; }

    function isEnabledFlag() {
        // Старый kill-switch имеет приоритет, но новый экран настроек его очищает.
        if (isTrue(storeGet('disabled', 'false'))) return false;
        var v = storeGet('enabled', 'true');
        return !isFalse(v);
    }

    // Хуки остаются на месте даже при выключении: переключатель с пульта
    // просто делает их «прозрачными», без перезапуска приложения.
    function isActive() { return installed && isEnabledFlag(); }

    function isDebug() {
        return isTrue(storeGet('debug', 'false'));
    }

    function log() {
        if (!isDebug() || !con.log) return;
        try { con.log.apply(con, ['[Skpt]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }

    function warn() {
        if (!con.warn) return;
        try { con.warn.apply(con, ['[Skpt]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }

    // Повторная загрузка: не дублируем хуки, более старую версию сначала снимаем.
    var previous = root[FLAG];
    if (previous) {
        if (previous.version === VERSION) return;
        if (typeof previous.uninstall === 'function') {
            try { previous.uninstall(); } catch (e) {}
        }
    }
    if (root.plugin_ad_skipper_webos_v16) {
        warn('обнаружена старая v16 — удалите её из списка плагинов, иначе хуки будут дублироваться');
    }
    if (!isEnabledFlag()) warn('установлен, но выключен в настройках (skpt_enabled)');

    var FAKE_JSON = '{"ad":[],"settings":{},"ab":{}}';

    // ------------------------------------------------------------------
    // Правила классификации URL
    // ------------------------------------------------------------------
    var defaultRules = [
        // Конфиг рекламы Lampa: путь одинаковый у всех зеркал (cub.best, cub.black,
        // durex.monster, cubnotrip.top и пользовательских из localStorage).
        { name: 'lampa-ad-config', action: 'fake', pathOnly: true,
          re: /(?:^|\/)api\/ad\/get(?:\/|\?|$)/i },
        // SDK, которые грузит IMA.loadSDK2/loadSDK3
        { name: 'ima-sdk', action: 'block',
          re: /imasdk\.googleapis\.com\/js\/sdkloader\/ima3\.js/i },
        { name: 'vast-sdk', action: 'block',
          re: /\/(?:vender\/)?vast\/vast\.js|\/vast\.js(?:\?|$)/i },
        // Старые зеркала вида ad.cub.red / ads.cub.black (для совместимости)
        { name: 'cub-ad-host', action: 'block',
          re: /^(?:https?:)?\/\/(?:ad|ads|vast)\.cub\.[a-z0-9.-]+/i },
        // Типовые сети VAST/IMA
        { name: 'google-ads', action: 'block',
          re: /^(?:https?:)?\/\/(?:[^/]*\.)?(?:pagead2\.googlesyndication\.com|googleads\.g\.doubleclick\.net)\//i }
    ];

    var userRules = [];    // skpt_rules + SkptAdBlock.addRule()
    var hostRules = [];    // skpt_hosts (домены через запятую, для ввода с пульта)
    var allowHosts = [];
    var MAX_RULES = 200;   // защита от бесконтрольного роста списка правил

    function loadJsonArray(key) {
        try {
            var parsed = JSON.parse(storeGet(key, '[]'));
            return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
        } catch (e) { return []; }
    }

    function makeRule(name, re, action) {
        return { name: name, action: action === 'fake' ? 'fake' : 'block', pathOnly: false, re: re };
    }

    function addRule(pattern, action) {
        if (userRules.length >= MAX_RULES) {
            warn('достигнут лимит пользовательских правил:', MAX_RULES);
            return false;
        }
        var re;
        try {
            // Проверка по наличию .test() работает и для RegExp из другого realm'а.
            re = (pattern && typeof pattern.test === 'function') ? pattern : new RegExp(String(pattern), 'i');
        } catch (e) { warn('некорректное правило', pattern); return false; }
        userRules.push(makeRule('custom-' + userRules.length, re, action));
        return true;
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function parseHosts(text) {
        var parts = String(text || '').split(/[\s,;]+/), out = [], i, h;
        for (i = 0; i < parts.length; i++) {
            if (out.length >= MAX_RULES) break;
            h = parts[i].replace(/^https?:\/\//i, '').split('/')[0].replace(/^\*\./, '').toLowerCase();
            if (!h) continue;
            // Хост может быть началом URL, поддоменом или стоять после порта.
            out.push(makeRule('host-' + h,
                new RegExp('(?:^|\\/\\/|\\.)' + escapeRegex(h) + '(?:[\\/?:]|$)', 'i'), 'block'));
        }
        return out;
    }

    function setHosts(text) {
        storeSet('hosts', String(text || ''));
        hostRules = parseHosts(text);
        log('обновлены доп. домены:', hostRules.length);
        return hostRules.length;
    }

    (function initRules() {
        var custom = loadJsonArray('rules');
        for (var i = 0; i < custom.length; i++) {
            var item = custom[i];
            if (typeof item === 'string') addRule(item, 'block');
            else if (item && item.pattern) addRule(item.pattern, item.action);
        }
        hostRules = parseHosts(storeGet('hosts', ''));
        allowHosts = loadJsonArray('allow_hosts');
    })();

    function parseUrl(url) {
        try {
            if (typeof root.URL === 'function') {
                var u = new root.URL(url, root.location.href);
                return { href: u.href, hostname: u.hostname, pathname: u.pathname };
            }
        } catch (e) {}

        // Фолбэк для старых ТВ-движков: парсинг через <a href>
        try {
            var a = document.createElement('a');
            a.href = url;
            return { href: a.href, hostname: a.hostname || '', pathname: a.pathname || a.href };
        } catch (e2) { return null; }
    }

    function isAllowed(host, href) {
        for (var i = 0; i < allowHosts.length; i++) {
            var a = String(allowHosts[i] || '');
            if (!a) continue;
            if (a.indexOf('://') > -1) {
                if (href.indexOf(a) === 0) return true;
            } else if (host === a ||
                       (host.length > a.length && host.slice(host.length - a.length - 1) === '.' + a)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Вернуть {action:'fake'|'block', name, url} или null, если URL не рекламный
     * (или плагин выключен с пульта).
     */
    function classify(url) {
        if (!isActive() || !url || typeof url !== 'string') return null;
        var p = parseUrl(url);
        var href = p ? p.href : url;
        var path = p ? p.pathname : url;
        var host = p ? p.hostname : '';

        if (isAllowed(host, href)) return null;

        var lists = [defaultRules, userRules, hostRules], l, i, r;
        for (l = 0; l < lists.length; l++) {
            for (i = 0; i < lists[l].length; i++) {
                r = lists[l][i];
                try {
                    if (r.re.test(r.pathOnly ? path : href)) {
                        return { action: r.action, name: r.name, url: href };
                    }
                } catch (e) {}
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Вспомогательные функции для подделки ответов
    // ------------------------------------------------------------------
    function defineVal(obj, key, value) {
        try { Object.defineProperty(obj, key, { value: value, writable: true, configurable: true }); }
        catch (e) { try { obj[key] = value; } catch (e2) {} }
    }

    function makeEvent(type) {
        try { if (typeof root.ProgressEvent === 'function') return new root.ProgressEvent(type); } catch (e) {}
        try { if (typeof root.Event === 'function') return new root.Event(type); } catch (e) {}
        try {
            var ev = document.createEvent('Event');
            ev.initEvent(type, false, false);
            return ev;
        } catch (e2) {}
        return { type: type };
    }

    function dispatch(target, type) {
        if (!target || typeof target.dispatchEvent !== 'function') return;
        try { target.dispatchEvent(makeEvent(type)); } catch (e) {}
    }

    function toArrayBuffer(str) {
        var bytes = [], i, c;
        for (i = 0; i < str.length; i++) {
            c = str.charCodeAt(i);
            if (c < 128) bytes.push(c);
            else if (c < 2048) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
            else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return new Uint8Array(bytes).buffer;
    }

    function responseValue(xhr, mode, text) {
        if (mode.action !== 'fake') return null; // у 204 нет тела
        var rt = xhr.responseType || '';
        if (rt === 'json') { try { return JSON.parse(text); } catch (e) { return null; } }
        if (rt === 'document') return null;
        if (rt === 'blob') { try { return new root.Blob([text], { type: 'application/json' }); } catch (e) { return null; } }
        if (rt === 'arraybuffer') { try { return toArrayBuffer(text); } catch (e) { return null; } }
        return text;
    }

    function resolved(value) {
        if (typeof root.Promise === 'function' && root.Promise.resolve) return root.Promise.resolve(value);
        var thenable = {
            then: function (ok) { ok(value); return thenable; },
            'catch': function () { return thenable; }
        };
        return thenable;
    }

    function fakeFetchResponse(mode) {
        var status = mode.action === 'fake' ? 200 : 204;
        var body = mode.action === 'fake' ? FAKE_JSON : null;
        try {
            if (typeof root.Response === 'function') {
                return new root.Response(body, {
                    status: status,
                    statusText: status === 200 ? 'OK' : 'No Content',
                    headers: status === 200 ? { 'Content-Type': 'application/json' } : {}
                });
            }
        } catch (e) {}

        // Минимальный Response-подобный объект для окружений без fetch/Response.
        return {
            ok: true, status: status, statusText: status === 200 ? 'OK' : 'No Content',
            headers: { get: function (n) {
                return status === 200 && /^content-type$/i.test(n || '') ? 'application/json' : null;
            } },
            text: function () { return resolved(body || ''); },
            json: function () { return resolved(mode.action === 'fake' ? JSON.parse(FAKE_JSON) : null); },
            clone: function () { return fakeFetchResponse(mode); }
        };
    }

    // ------------------------------------------------------------------
    // 1. fetch
    // ------------------------------------------------------------------
    function installFetch() {
        if (typeof root.fetch !== 'function') return;
        var original = root.fetch;

        function patchedFetch(input, init) {
            var url = typeof input === 'string' ? input : (input && input.url);
            var mode = classify(url);
            if (!mode) return original.apply(this, arguments);
            stats.fetch++;
            log('fetch', mode.action, mode.name, url);
            return resolved(fakeFetchResponse(mode));
        }

        root.fetch = patchedFetch;
        cleanups.push(function () { if (root.fetch === patchedFetch) root.fetch = original; });
    }

    // ------------------------------------------------------------------
    // 2. XMLHttpRequest — патчим прототип (без Proxy, работает и на старом webOS)
    // ------------------------------------------------------------------
    var XHR_PROPS = ['readyState', 'status', 'statusText', 'responseURL', 'response',
                     'responseText', 'responseXML'];
    var XHR_METHODS = ['getAllResponseHeaders', 'getResponseHeader'];

    function stateFor(xhr) {
        var st = xhr.__skpt_state;
        if (!st) {
            st = { gen: 0, url: '', href: '', mode: null, blocked: false,
                   cancelled: false, done: false, spoofed: false };
            try { Object.defineProperty(xhr, '__skpt_state', { value: st, writable: true, configurable: true }); }
            catch (e) { xhr.__skpt_state = st; }
        }
        return st;
    }

    function restoreXhr(xhr) {
        var i;
        for (i = 0; i < XHR_PROPS.length; i++) { try { delete xhr[XHR_PROPS[i]]; } catch (e) {} }
        for (i = 0; i < XHR_METHODS.length; i++) { try { delete xhr[XHR_METHODS[i]]; } catch (e) {} }
    }

    function installXHR() {
        var Ctor = root.XMLHttpRequest;
        if (!Ctor || !Ctor.prototype || !Ctor.prototype.open || !Ctor.prototype.send) return;

        var P = Ctor.prototype;
        var nativeOpen = P.open;
        var nativeSend = P.send;
        var nativeAbort = P.abort;

        function finishFake(xhr, st, gen) {
            // Не проверяем uninstall: если хуки сняли между send() и таймером,
            // подделку всё равно надо довести до конца, иначе XHR зависнет
            // в readyState: 1 без load/loadend.
            if (!st || st.done || st.cancelled || st.gen !== gen || !st.mode) return;
            st.done = true;

            var isFake = st.mode.action === 'fake';
            var status = isFake ? 200 : 204;
            var text = isFake ? FAKE_JSON : '';

            defineVal(xhr, 'readyState', 4);
            defineVal(xhr, 'status', status);
            defineVal(xhr, 'statusText', isFake ? 'OK' : 'No Content');
            defineVal(xhr, 'responseURL', st.href || st.url);
            // responseText определяем ВСЕГДА: jQuery 3 читает его даже при responseType != 'text'
            defineVal(xhr, 'responseText', text);
            defineVal(xhr, 'response', responseValue(xhr, st.mode, text));
            defineVal(xhr, 'responseXML', null);
            defineVal(xhr, 'getAllResponseHeaders', function () {
                return isFake ? 'content-type: application/json\r\n' : '';
            });
            defineVal(xhr, 'getResponseHeader', function (name) {
                return isFake && /^content-type$/i.test(name || '') ? 'application/json' : null;
            });

            st.spoofed = true;
            stats.xhr++;
            log('xhr', st.mode.action, st.mode.name, st.url);

            dispatch(xhr, 'readystatechange');
            dispatch(xhr, 'load');
            dispatch(xhr, 'loadend');
        }

        function patchedOpen(method, url) {
            var st = stateFor(this);
            if (st.spoofed) { restoreXhr(this); st.spoofed = false; }

            var raw = typeof url === 'string' ? url : String(url || '');
            var parsed = parseUrl(raw);
            st.url = raw;
            st.href = parsed ? parsed.href : raw;
            st.mode = classify(raw);
            st.gen++;
            st.blocked = false;
            st.cancelled = false;
            st.done = false;

            // open() сам по себе не отправляет запрос, поэтому безопасно вызвать нативный.
            return nativeOpen.apply(this, arguments);
        }

        function patchedSend(body) {
            var st = stateFor(this);
            if (!isActive() || !st.mode) return nativeSend.apply(this, arguments);
            if (st.blocked) return; // повторный send() на уже подделанном запросе

            st.blocked = true;
            var self = this;
            var gen = st.gen;
            root.setTimeout(function () { finishFake(self, st, gen); }, 0);
            return;
        }

        function patchedAbort() {
            var st = stateFor(this);
            if (st && st.blocked && !st.done) {
                st.cancelled = true;
                st.blocked = false;
                st.spoofed = true;
                defineVal(this, 'readyState', 4);
                defineVal(this, 'status', 0);
                defineVal(this, 'statusText', '');
                dispatch(this, 'readystatechange');
                dispatch(this, 'abort');
                dispatch(this, 'loadend');
                return;
            }
            return nativeAbort.apply(this, arguments);
        }

        P.open = patchedOpen;
        P.send = patchedSend;
        if (typeof nativeAbort === 'function') P.abort = patchedAbort;

        cleanups.push(function () {
            if (P.open === patchedOpen) P.open = nativeOpen;
            if (P.send === patchedSend) P.send = nativeSend;
            if (P.abort === patchedAbort) P.abort = nativeAbort;
        });
    }

    // ------------------------------------------------------------------
    // 3. Данные плеера: убираем рекламу, которую добавляют плагины-источники
    // ------------------------------------------------------------------
    var VAST_KEYS = ['vast_url', 'vast_banner'];

    function sanitizeItem(d) {
        if (!d || typeof d !== 'object') return 0;
        var n = 0;
        for (var i = 0; i < VAST_KEYS.length; i++) {
            if (VAST_KEYS[i] in d) { try { delete d[VAST_KEYS[i]]; n++; } catch (e) {} }
        }
        return n;
    }

    function sanitizeData(d) {
        if (!isActive() || !d || typeof d !== 'object') return 0;
        var n = sanitizeItem(d);
        if (d.playlist && typeof d.playlist.length === 'number') {
            for (var i = 0; i < d.playlist.length; i++) n += sanitizeItem(d.playlist[i]);
        }
        if (n) { stats.data++; log('playdata: удалено VAST-полей:', n); }
        return n;
    }

    function wrapMethod(obj, name) {
        var original = obj[name];
        if (typeof original !== 'function') return;
        function wrapped(data) {
            try { sanitizeData(data); } catch (e) {}
            return original.apply(this, arguments);
        }
        obj[name] = wrapped;
        cleanups.push(function () { if (obj[name] === wrapped) obj[name] = original; });
    }

    function installScriptFilter(L) {
        var U = L.Utils;
        if (!U || typeof U.putScriptAsync !== 'function') return;
        var original = U.putScriptAsync;

        function patchedPutScriptAsync(items, complete, error, success, showLogs) {
            if (!isActive() || !items || !items.length) return original.apply(this, arguments);

            var kept = [], blocked = [], i;
            for (i = 0; i < items.length; i++) {
                var mode = classify(String(items[i]));
                if (mode && mode.action === 'block') blocked.push(items[i]);
                else kept.push(items[i]);
            }
            if (!blocked.length) return original.apply(this, arguments);

            stats.scripts += blocked.length;
            log('script: заблокировано', blocked.length, blocked.join(', '));

            // Один вызов error() вместо одного на каждый URL: пользовательские
            // error-обработчики не засыпаются сообщениями, но Promise
            // IMA.loadSDK* всё равно получает reject (у него complete === false).
            if (typeof error === 'function') {
                try { error(blocked[0]); } catch (e) {}
            }
            if (!kept.length) {
                // putScriptAsync([]) никогда не вызовет complete — вызываем сами,
                // иначе Promise IMA.loadSDK*/загрузка плагинов повиснет.
                if (typeof complete === 'function') { try { complete(); } catch (e) {} }
                return;
            }
            return original.call(this, kept, complete, error, success, showLogs);
        }

        U.putScriptAsync = patchedPutScriptAsync;
        cleanups.push(function () {
            if (U.putScriptAsync === patchedPutScriptAsync) U.putScriptAsync = original;
        });
    }

    // ------------------------------------------------------------------
    // 4. Экран настроек для пульта (без консоли и без DevTools)
    // ------------------------------------------------------------------
    var SETTINGS_COMPONENT = 'skpt';
    var SHIELD_ICON = '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" ' +
        'xmlns="http://www.w3.org/2000/svg"><path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3z" ' +
        'stroke="white" stroke-width="2" stroke-linejoin="round"/><path d="m8.5 12 2.5 2.5 4.5-5" ' +
        'stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function tr(L, ru, en) {
        var code = 'ru';
        try { code = L.Storage.get('language', 'ru'); } catch (e) {}
        return code === 'ru' || code === 'uk' || code === 'be' ? ru : en;
    }

    function showStats(L) {
        var s = stats;
        var lines = [
            'Skpt v' + VERSION + ' — ' + (isActive() ? tr(L, 'включён', 'enabled') : tr(L, 'выключен', 'disabled')),
            tr(L, 'Подменено ответов', 'Spoofed responses') + ': ' + (s.fetch + s.xhr) +
                ' (fetch ' + s.fetch + ' / XHR ' + s.xhr + ')',
            tr(L, 'Очищено playdata', 'Playdata cleaned') + ': ' + s.data,
            tr(L, 'Заблокировано SDK', 'SDK blocked') + ': ' + s.scripts,
            tr(L, 'Рекламных оверлеев', 'Ad overlays') + ': ' + s.dom
        ];
        try { L.Noty.show(lines.join('<br>'), { time: 8000 }); } catch (e) {}
        log('статистика:', lines.join(' | '));
    }

    function installSettings(L) {
        var SA = L.SettingsApi;
        if (settingsInstalled || !SA || typeof SA.addComponent !== 'function' ||
            typeof SA.addParam !== 'function') return;
        settingsInstalled = true;

        SA.addComponent({
            component: SETTINGS_COMPONENT,
            icon: SHIELD_ICON,
            name: tr(L, 'Без рекламы', 'Ad blocker')
        });

        SA.addParam({
            component: SETTINGS_COMPONENT,
            param: { type: 'title' },
            field: { name: tr(L, 'Основное', 'General') }
        });

        // Триггер пишет 'true'/'false' прямо в localStorage['skpt_enabled'].
        SA.addParam({
            component: SETTINGS_COMPONENT,
            param: { name: 'skpt_enabled', type: 'trigger', default: true },
            field: {
                name: tr(L, 'Блокировать рекламу', 'Block ads'),
                description: tr(L, 'Применяется сразу, без перезапуска', 'Applies immediately, no restart')
            },
            onChange: function (value) {
                api.setEnabled(isTrue(value));
            }
        });

        SA.addParam({
            component: SETTINGS_COMPONENT,
            param: { name: 'skpt_debug', type: 'trigger', default: false },
            field: { name: tr(L, 'Подробный лог', 'Verbose log') }
        });

        SA.addParam({
            component: SETTINGS_COMPONENT,
            param: {
                name: 'skpt_hosts', type: 'input', values: '', default: '',
                placeholder: tr(L, 'Например: ad.example, ads.example2', 'e.g. ad.example, ads.example2')
            },
            field: {
                name: tr(L, 'Доп. рекламные домены', 'Extra ad domains'),
                description: tr(L, 'Через запятую, без http://', 'Comma separated, no http://')
            },
            onChange: function (value) { api.setHosts(value); }
        });

        SA.addParam({
            component: SETTINGS_COMPONENT,
            param: { type: 'title' },
            field: { name: tr(L, 'Диагностика', 'Diagnostics') }
        });

        SA.addParam({
            component: SETTINGS_COMPONENT,
            param: { name: 'skpt_stats', type: 'button' },
            field: { name: tr(L, 'Статистика и версия', 'Stats and version') },
            onChange: function () { showStats(L); }
        });

        cleanups.push(function () {
            try { if (SA.removeParams) SA.removeParams(SETTINGS_COMPONENT); } catch (e) {}
            try { if (SA.removeComponent) SA.removeComponent(SETTINGS_COMPONENT); } catch (e) {}
            settingsInstalled = false;
        });
        log('экран настроек «Без рекламы» добавлен');
    }

    function installLampaHooks(L) {
        try { installSettings(L); } catch (e) { warn('экран настроек:', e && e.message); }

        // Фолбэк для случая, когда рекламный оверлей появился раньше Player 'create':
        // запоминаем обычный контроллер, чтобы было куда вернуться.
        if (!savedController) {
            try {
                if (L.Controller && typeof L.Controller.enabled === 'function') {
                    var c = L.Controller.enabled();
                    if (c && c.name && c.name.indexOf('ad_') !== 0) savedController = c.name;
                }
            } catch (e) {}
        }

        var Player = L.Player;
        if (!Player) return;

        if (Player.listener && typeof Player.listener.follow === 'function') {
            function onCreate(e) {
                try {
                    if (L.Controller && typeof L.Controller.enabled === 'function') {
                        var cur = L.Controller.enabled();
                        savedController = cur && cur.name ? cur.name : '';
                    }
                } catch (e2) {}
                if (e && e.data) sanitizeData(e.data);
            }
            Player.listener.follow('create', onCreate);
            cleanups.push(function () {
                if (Player.listener && typeof Player.listener.remove === 'function') {
                    Player.listener.remove('create', onCreate);
                }
            });
            log("подписка на Player 'create' установлена");
        }

        // Плагины вызывают Lampa.Player.play()/iptv() напрямую — дублируем очистку.
        wrapMethod(Player, 'play');
        wrapMethod(Player, 'iptv');
        installScriptFilter(L);
    }

    function whenLampaReady() {
        var attempts = 0;
        (function check() {
            if (!installed) return;
            var L = root.Lampa;
            if (L && L.Player && L.Player.listener) {
                try { installLampaHooks(L); } catch (e) { warn('ошибка хуков Lampa:', e && e.message); }
                return;
            }
            if (attempts++ < 1200) root.setTimeout(check, 50); // до 60 секунд
            else warn('Lampa.Player не найден, сетевые хуки работают без playdata-фильтра');
        })();
    }

    // ------------------------------------------------------------------
    // 5. DOM-страховка: CSS + observer
    // ------------------------------------------------------------------
    var AD_SELECTORS = '.ad-preroll, .ad-video-block, .ad-countdown, .ad-server, .ad-bot, .vast-block';

    function matches(node, selector) {
        try {
            if (node.matches) return node.matches(selector);
            if (node.msMatchesSelector) return node.msMatchesSelector(selector);
            if (node.webkitMatchesSelector) return node.webkitMatchesSelector(selector);
        } catch (e) {}
        return false;
    }

    function restoreHandledNodes() {
        for (var i = 0; i < handledNodes.length; i++) {
            var node = handledNodes[i];
            try {
                node.__skpt_handled = false;
                // Снимаем именно inline-стиль; внешний CSS мы удаляем отдельно.
                if (node.style) {
                    if (typeof node.style.removeProperty === 'function') node.style.removeProperty('display');
                    else node.style.display = '';
                }
            } catch (e) {}
        }
        handledNodes = [];
    }

    function syncDomStyle() {
        if (isActive()) {
            if (adStyle || !document.body) return;
            try {
                adStyle = document.createElement('style');
                adStyle.setAttribute('type', 'text/css');
                adStyle.appendChild(document.createTextNode(
                    AD_SELECTORS + ' { display:none !important; visibility:hidden !important; }'
                ));
                (document.head || document.body).appendChild(adStyle);
            } catch (e) { adStyle = null; }
        } else {
            // При выключении/снятии плагина возвращаем узлы в исходный вид,
            // иначе скрытый оверлей останется с display:none навсегда.
            restoreHandledNodes();
            if (adStyle) {
                try { if (adStyle.parentNode) adStyle.parentNode.removeChild(adStyle); } catch (e) {}
                adStyle = null;
            }
        }
    }

    function handleAdNode(node) {
        if (!isActive() || !node || node.nodeType !== 1 || node.__skpt_handled) return;
        node.__skpt_handled = true;
        handledNodes.push(node);
        stats.dom++;

        try { node.style.setProperty('display', 'none', 'important'); }
        catch (e) { try { node.style.display = 'none'; } catch (e2) {} }

        // display:none не останавливает звук — гасим видео внутри оверлея.
        var videos = typeof node.querySelectorAll === 'function' ? node.querySelectorAll('video') : [];
        for (var i = 0; i < videos.length; i++) {
            try {
                videos[i].pause();
                videos[i].removeAttribute('src');
                videos[i].load();
            } catch (e) {}
        }

        // Если преролл всё же захватил контроллер — вернем тот, что был до запуска.
        try {
            var L = root.Lampa;
            if (savedController && L && L.Controller && L.Controller.enabled) {
                var cur = L.Controller.enabled();
                if (cur && (cur.name === 'ad_preroll' || cur.name === 'ad_video_block')) {
                    L.Controller.toggle(savedController);
                }
            }
        } catch (e) {}

        log('dom: рекламный оверлей', node.className);
    }

    function installDomGuard() {
        var attempts = 0;
        function start() {
            if (!installed) return;
            if (!document.body) {
                if (attempts++ < 300) root.setTimeout(start, 100); // не более 30 с ожидания
                return;
            }

            syncDomStyle();

            function inspect(node) {
                if (!node || node.nodeType !== 1) return;
                if (matches(node, AD_SELECTORS)) handleAdNode(node);
                if (typeof node.querySelectorAll === 'function') {
                    var found = node.querySelectorAll(AD_SELECTORS);
                    for (var i = 0; i < found.length; i++) handleAdNode(found[i]);
                }
            }

            // Узлы, уже добавленные до старта плагина.
            try {
                var existing = document.body.querySelectorAll(AD_SELECTORS);
                for (var j = 0; j < existing.length; j++) handleAdNode(existing[j]);
            } catch (e) {}

            if (typeof root.MutationObserver === 'function') {
                try {
                    var observer = new root.MutationObserver(function (mutations) {
                        if (!isActive()) return;
                        for (var m = 0; m < mutations.length; m++) {
                            var added = mutations[m].addedNodes || [];
                            for (var k = 0; k < added.length; k++) inspect(added[k]);
                        }
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                    cleanups.push(function () { observer.disconnect(); });
                } catch (e) {}
            }
        }
        start();
    }

    // ------------------------------------------------------------------
    // Публичный API / снятие хуков
    // ------------------------------------------------------------------
    var api = {
        version: VERSION,
        stats: stats,
        classify: classify,
        addRule: addRule,
        setHosts: setHosts,
        isEnabled: isActive,
        setEnabled: function (on) {
            storeSet('disabled', 'false');   // снимаем устаревший kill-switch
            storeSet('enabled', on ? 'true' : 'false');
            syncDomStyle();
            log(on ? 'включён' : 'выключен', 'через настройки');
            return isActive();
        },
        uninstall: function () {
            installed = false;
            for (var i = cleanups.length - 1; i >= 0; i--) {
                try { cleanups[i](); } catch (e) {}
            }
            cleanups = [];
            syncDomStyle();
            try { delete root[FLAG]; } catch (e) { root[FLAG] = undefined; }
            try { delete root.SkptAdBlock; } catch (e) { root.SkptAdBlock = undefined; }
            log('хуки сняты');
        }
    };

    root[FLAG] = api;
    root.SkptAdBlock = api;

    // Сетевые хуки ставим СРАЗУ: AdManager.init() (и первый /api/ad/get/) работает
    // ещё до события app:ready, на которое опиралась старая версия.
    try { installFetch(); } catch (e) { warn('fetch hook:', e && e.message); }
    try { installXHR(); } catch (e) { warn('xhr hook:', e && e.message); }
    try { installDomGuard(); } catch (e) { warn('dom guard:', e && e.message); }
    whenLampaReady();

    log('инициализирован', VERSION, 'active=' + isActive());
})(typeof window !== 'undefined' ? window : this);
