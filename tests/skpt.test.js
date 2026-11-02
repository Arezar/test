'use strict';

/*
 * Смоук-тесты для Skpt.js. Зависимостей нет: плагин исполняется в vm-песочнице
 * с минимальными заглушками браузерного окружения и Lampa.
 * Запуск: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Skpt.js'), 'utf8');

function makeListener() {
    const map = {};
    return {
        follow(type, fn) { (map[type] || (map[type] = [])).push(fn); return this; },
        remove(type, fn) {
            const list = map[type] || [];
            const i = list.indexOf(fn);
            if (i > -1) list.splice(i, 1);
            return this;
        },
        has(type, fn) { return (map[type] || []).indexOf(fn) > -1; },
        send(type, event) { (map[type] || []).slice().forEach(fn => fn.call(this, event)); return this; }
    };
}

function makeElement(tag) {
    return {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        className: '',
        children: [],
        parentNode: null,
        style: { setProperty(key, value) { this[key] = value; } },
        setAttribute() {},
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i > -1) this.children.splice(i, 1);
            child.parentNode = null;
            return child;
        },
        matches() { return false; },
        querySelectorAll() { return []; }
    };
}

function boot(options) {
    options = options || {};
    const calls = { nativeSend: 0, fetch: 0, scripts: [], toggles: [], noty: [] };
    const storage = Object.create(null);
    Object.assign(storage, options.storage || {});

    function FakeXHR() {
        this._listeners = {};
        this.onload = null;
        this.onerror = null;
        this.onabort = null;
        this.onloadend = null;
        this.onreadystatechange = null;
        this.responseType = '';
        this._readyState = 0;
        this._status = 0;
        this._responseText = '';
        this._response = null;
        this._url = '';
    }
    FakeXHR.prototype.addEventListener = function (type, fn) {
        (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    };
    FakeXHR.prototype.dispatchEvent = function (ev) {
        calls.events = calls.events || [];
        calls.events.push(ev.type);
        (this._listeners[ev.type] || []).slice().forEach(fn => fn.call(this, ev));
        const handler = this['on' + ev.type];
        if (typeof handler === 'function') handler.call(this, ev);
        return true;
    };
    FakeXHR.prototype.open = function (method, url) {
        this._method = method;
        this._url = url;
        this._readyState = 1;
    };
    FakeXHR.prototype.send = function () {
        calls.nativeSend++;
        this._readyState = 4;
        this._status = 200;
        this._responseText = '{"real":true}';
        this._response = this._responseText;
    };
    FakeXHR.prototype.abort = function () { this._status = 0; };
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.getAllResponseHeaders = function () { return ''; };
    FakeXHR.prototype.getResponseHeader = function () { return null; };
    Object.defineProperties(FakeXHR.prototype, {
        readyState: { get() { return this._readyState; }, configurable: true },
        status: { get() { return this._status; }, configurable: true },
        statusText: { get() { return 'OK'; }, configurable: true },
        responseText: { get() { return this._responseText; }, configurable: true },
        response: { get() { return this._response; }, configurable: true },
        responseURL: { get() { return this._url; }, configurable: true }
    });

    const document = {
        body: makeElement('body'),
        head: makeElement('head'),
        createElement(tag) {
            if (tag === 'a') {
                return {
                    set href(v) { this._href = v; },
                    get href() { return this._href; },
                    hostname: '',
                    pathname: ''
                };
            }
            return makeElement(tag);
        },
        createTextNode(text) { return { nodeType: 3, text }; },
        createEvent() { return { initEvent(type) { this.type = type; } }; }
    };

    class FakeMutationObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
    }
    const observers = [];

    const originalPutScriptAsync = function (items, complete, error, success) {
        (items || []).forEach(url => {
            calls.scripts.push(url);
            if (typeof success === 'function') success(url);
        });
        if (typeof complete === 'function') complete();
    };

    // Заглушка SettingsApi повторяет контракт Lampa: addComponent/addParam +
    // removeComponent/removeParams для корректного uninstall().
    const SettingsApi = {
        components: [],
        params: [],
        addComponent(data) { this.components.push(data); },
        addParam(data) { this.params.push(data); },
        removeComponent(name) { this.components = this.components.filter(d => d.component !== name); },
        removeParams(name) { this.params = this.params.filter(d => d.component !== name); },
        getComponent(name) { return this.components.find(d => d.component === name); },
        getParam(name) { return this.params.filter(d => d.component === name); },
        allComponents() { return this.components; },
        allParams() { return this.params; }
    };

    const Lampa = {
        Listener: makeListener(),
        Player: {
            listener: makeListener(),
            play(data) { calls.play = data; return data; },
            iptv(data) { calls.iptv = data; return data; }
        },
        Controller: {
            enabled() { return { name: options.controller || 'content' }; },
            toggle(name) { calls.toggles.push(name); }
        },
        SettingsApi,
        Noty: { show(text, params) { calls.noty.push({ text, params }); } },
        Storage: {
            get(name, dflt) { return Object.prototype.hasOwnProperty.call(storage, name) ? storage[name] : dflt; },
            set(name, value) { storage[name] = String(value); }
        },
        Utils: { putScriptAsync: originalPutScriptAsync }
    };
    if (options.noLampa) Lampa.Player = undefined;
    if (options.noSettings) delete Lampa.SettingsApi;

    const logs = [];
    const originalFetch = function (input) {
        calls.fetch++;
        calls.lastFetch = input;
        return Promise.resolve(new Response('{"real":true}', { status: 200 }));
    };

    const sandbox = {
        console: { log(...args) { logs.push(args.join(' ')); }, warn(...args) { logs.push(args.join(' ')); } },
        document,
        location: { href: 'https://lampa.local/' },
        localStorage: {
            getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
            setItem(key, value) { storage[key] = String(value); },
            removeItem(key) { delete storage[key]; }
        },
        Lampa,
        XMLHttpRequest: FakeXHR,
        fetch: originalFetch,
        Response,
        URL,
        Event: globalThis.Event,
        ProgressEvent: globalThis.ProgressEvent || globalThis.Event,
        Blob: globalThis.Blob,
        MutationObserver: FakeMutationObserver,
        setTimeout,
        clearTimeout
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(CODE, sandbox, { filename: 'Skpt.js' });

    return { sandbox, api: sandbox.SkptAdBlock, Lampa, SettingsApi, calls, storage, observers, logs,
             document, FakeXHR, originalFetch, originalPutScriptAsync };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('загружается без исключений и публикует API', () => {
    const { api } = boot();
    assert.ok(api, 'window.SkptAdBlock должен существовать');
    assert.equal(api.version, '2.1.0');
    assert.equal(typeof api.classify, 'function');
    assert.equal(typeof api.uninstall, 'function');
    api.uninstall();
});

test('classification: конфиг -> fake, SDK -> block, обычные URL не трогаем', () => {
    const { api } = boot();
    assert.equal(api.classify('https://cub.best/api/ad/get/preroll').action, 'fake');
    assert.equal(api.classify('https://cub.black/api/ad/get/banner?x=1').action, 'fake');
    assert.equal(api.classify('https://durex.monster/api/ad/get/preroll').name, 'lampa-ad-config');
    assert.equal(api.classify('/api/ad/get/banner').action, 'fake');
    assert.equal(api.classify('https://imasdk.googleapis.com/js/sdkloader/ima3.js').action, 'block');
    assert.equal(api.classify('https://yumata.github.io/lampa//vender/vast/vast.js').action, 'block');
    assert.equal(api.classify('https://ad.cub.red/creative.xml').action, 'block');
    assert.equal(api.classify('https://cub.best/api/movie/123'), null);
    assert.equal(api.classify('https://api.themoviedb.org/3/movie/550'), null);
    assert.equal(api.classify('https://example.com/loading/ad-free.mp4'), null);
    assert.equal(api.classify(null), null);
    api.uninstall();
});

test('пользовательские правила и белый список', () => {
    const { api } = boot({
        storage: {
            skpt_rules: JSON.stringify(['ad\\.newmirror\\.', { pattern: 'my-vast-endpoint', action: 'fake' }]),
            skpt_allow_hosts: JSON.stringify(['trusted.example'])
        }
    });
    assert.equal(api.classify('https://ad.newmirror.tv/tag.xml').action, 'block');
    assert.equal(api.classify('https://cdn.example/my-vast-endpoint').action, 'fake');
    assert.equal(api.classify('https://ads.trusted.example/api/ad/get/preroll'), null);
    assert.equal(api.classify('https://cub.best/api/ad/get/preroll').action, 'fake');
    assert.equal(api.addRule('another\\.ad\\.', 'block'), true);
    assert.equal(api.classify('https://another.ad.net/x').action, 'block');
    api.uninstall();
});

test('kill-switch: плагин установлен, но хуки прозрачны (без перезапуска)', () => {
    const { sandbox, api, calls, document: doc } = boot({ storage: { skpt_disabled: '1' } });
    assert.ok(api, 'экземпляр нужен, чтобы включать плагин с пульта');
    assert.equal(api.isEnabled(), false);
    assert.equal(api.classify('https://cub.best/api/ad/get/preroll'), null);
    assert.equal(doc.head.children.length, 0, 'CSS при выключении не внедряется');

    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', 'https://cub.best/api/ad/get/preroll');
    xhr.send();
    assert.equal(calls.nativeSend, 1, 'запросы идут в сеть');

    api.setEnabled(true); // очищает устаревший skpt_disabled и включает защиту
    assert.equal(api.isEnabled(), true);
    assert.equal(api.classify('https://cub.best/api/ad/get/preroll').action, 'fake');
    assert.equal(doc.head.children.length, 1, 'CSS снова добавлен');
    api.uninstall();
});

test('XHR: /api/ad/get подменяется пустым конфигом, сеть не дёргается', async () => {
    const { sandbox, calls, api } = boot();
    const xhr = new sandbox.XMLHttpRequest();
    const loaded = [];
    xhr.onload = () => loaded.push('load');
    xhr.onloadend = () => loaded.push('loadend');
    xhr.onreadystatechange = () => loaded.push('readystatechange');

    xhr.open('GET', 'https://cub.best/api/ad/get/preroll');
    xhr.setRequestHeader('X-Test', '1');
    xhr.send();
    await tick();

    assert.equal(calls.nativeSend, 0, 'нативный send не должен вызываться');
    assert.equal(xhr.readyState, 4);
    assert.equal(xhr.status, 200);
    assert.equal(xhr.statusText, 'OK');
    assert.equal(xhr.responseText, '{"ad":[],"settings":{},"ab":{}}');
    assert.equal(xhr.response, '{"ad":[],"settings":{},"ab":{}}');
    assert.equal(xhr.responseURL, 'https://cub.best/api/ad/get/preroll');
    assert.match(xhr.getAllResponseHeaders(), /application\/json/);
    assert.equal(xhr.getResponseHeader('Content-Type'), 'application/json');
    assert.equal(xhr.getResponseHeader('X-Other'), null);
    assert.deepEqual(loaded, ['readystatechange', 'load', 'loadend']);
    assert.equal(api.stats.xhr, 1);
    api.uninstall();
});

test('XHR: responseType=json и 204 для заблокированного хоста', async () => {
    const { sandbox, api } = boot();
    const jsonXhr = new sandbox.XMLHttpRequest();
    jsonXhr.responseType = 'json';
    jsonXhr.open('GET', 'https://cub.black/api/ad/get/banner');
    jsonXhr.send();
    await tick();
    // объект создан внутри vm (другой realm), сравниваем через JSON, а не по прототипу
    assert.equal(JSON.stringify(jsonXhr.response), '{"ad":[],"settings":{},"ab":{}}');
    assert.equal(typeof jsonXhr.responseText, 'string', 'jQuery читает responseText даже при json');

    const blocked = new sandbox.XMLHttpRequest();
    blocked.open('GET', 'https://ad.cub.red/creative.xml');
    blocked.send();
    await tick();
    assert.equal(blocked.status, 204);
    assert.equal(blocked.responseText, '');
    assert.equal(blocked.response, null);
    assert.equal(blocked.getAllResponseHeaders(), '');
    assert.equal(api.stats.xhr, 2);
    api.uninstall();
});

test('XHR: повторный open() того же объекта сбрасывает поддельные свойства', async () => {
    const { sandbox, calls } = boot();
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', 'https://cub.best/api/ad/get/preroll');
    xhr.send();
    await tick();
    assert.equal(xhr.status, 200);

    xhr.open('GET', 'https://api.example.com/movie/1');
    assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'status'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'responseText'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'getAllResponseHeaders'), false);
    xhr.send();
    assert.equal(calls.nativeSend, 1, 'обычный запрос должен уйти в сеть');
    assert.equal(xhr.status, 200);
    assert.equal(xhr.responseText, '{"real":true}');
    assert.equal(xhr.getAllResponseHeaders(), '');
    api_uninstall(sandbox);
});

function api_uninstall(sandbox) {
    if (sandbox.SkptAdBlock) sandbox.SkptAdBlock.uninstall();
}

test('XHR: abort() до срабатывания таймера не вешает запрос', async () => {
    const { sandbox, calls } = boot();
    const xhr = new sandbox.XMLHttpRequest();
    const events = [];
    xhr.onabort = () => events.push('abort');
    xhr.onload = () => events.push('load');
    xhr.onloadend = () => events.push('loadend');
    xhr.open('GET', 'https://cub.best/api/ad/get/preroll');
    xhr.send();
    xhr.abort();
    await tick();
    assert.deepEqual(events, ['abort', 'loadend']);
    assert.equal(xhr.status, 0);
    assert.equal(calls.nativeSend, 0);
    api_uninstall(sandbox);
});

test('fetch: поддельный ответ для конфига и 204 для SDK', async () => {
    const { sandbox, calls, api } = boot();
    const res = await sandbox.fetch('https://cub.best/api/ad/get/banner');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ad: [], settings: {}, ab: {} });
    assert.equal(res.headers.get('Content-Type'), 'application/json');

    const sdk = await sandbox.fetch('https://imasdk.googleapis.com/js/sdkloader/ima3.js');
    assert.equal(sdk.status, 204);
    assert.equal(await sdk.text(), '');
    assert.equal(calls.fetch, 0, 'оригинальный fetch не вызывался');
    assert.equal(api.stats.fetch, 2);

    await sandbox.fetch('https://api.example.com/movie');
    assert.equal(calls.fetch, 1, 'обычные запросы проходят насквозь');
    api.uninstall();
});

test('playdata: create/play/iptv вычищают vast_url и vast_banner', () => {
    const { Lampa, calls, api } = boot();
    const data = {
        url: 'https://cdn.example/movie.m3u8',
        vast_url: 'https://ad.example/vast?a=1',
        vast_banner: 'https://ad.example/banner',
        playlist: [{ url: 'https://cdn.example/2.m3u8', vast_url: 'https://ad.example/vast2' }]
    };
    Lampa.Player.listener.send('create', { data });
    assert.equal('vast_url' in data, false);
    assert.equal('vast_banner' in data, false);
    assert.equal('vast_url' in data.playlist[0], false);
    assert.equal(data.url, 'https://cdn.example/movie.m3u8', 'полезные поля не трогаем');
    assert.equal(api.stats.data, 1);

    Lampa.Player.play({ vast_url: 'x', url: 'y' });
    assert.equal('vast_url' in calls.play, false);
    Lampa.Player.iptv({ vast_banner: 'x' });
    assert.equal('vast_banner' in calls.iptv, false);
    api.uninstall();
});

test('putScriptAsync: SDK отфильтрован, complete/error не теряются', () => {
    const { Lampa, calls, api } = boot();
    let completed = 0;
    const errors = [];
    Lampa.Utils.putScriptAsync(
        ['https://imasdk.googleapis.com/js/sdkloader/ima3.js', 'https://cdn.example/plugin.js'],
        () => completed++,
        url => errors.push(url),
        () => {}
    );
    assert.equal(completed, 1);
    assert.equal(calls.scripts.length, 1, 'загружен только обычный скрипт');
    assert.equal(calls.scripts[0], 'https://cdn.example/plugin.js');
    assert.equal(errors.length, 1);
    assert.equal(api.stats.scripts, 1);

    // Если заблокировано всё — complete всё равно должен вызваться.
    Lampa.Utils.putScriptAsync(['https://imasdk.googleapis.com/js/sdkloader/ima3.js'],
        () => completed++, () => errors.push('only'));
    assert.equal(completed, 2, 'иначе Promise IMA.loadSDK зависнет');
    api.uninstall();
});

test('DOM-страж: скрывает оверлей, глушит видео и возвращает сохранённый контроллер', () => {
    const { sandbox, observers, calls, api } = boot({ controller: 'full_start' });
    assert.equal(observers.length, 1);
    const video = { pause() { this.paused = true; }, removeAttribute() {}, load() {} };
    const node = makeElement('div');
    node.className = 'ad-preroll';
    node.matches = () => true;
    node.querySelectorAll = () => [video];

    // На 'create' запоминаем реальный контроллер, затем преролл его перехватывает.
    sandbox.Lampa.Player.listener.send('create', { data: { url: 'x' } });
    sandbox.Lampa.Controller.enabled = () => ({ name: 'ad_preroll' });
    observers[0].callback([{ addedNodes: [node] }]);

    assert.equal(node.style.display, 'none');
    assert.equal(video.paused, true);
    assert.deepEqual(calls.toggles, ['full_start']);
    assert.equal(api.stats.dom, 1);
    api.uninstall();
    assert.equal(observers[0].disconnected, true);
});

test('ТВ-настройки: компонент «Без рекламы» добавлен в меню Lampa', () => {
    const { Lampa, SettingsApi, api } = boot();
    const component = SettingsApi.getComponent('skpt');
    assert.ok(component, 'SettingsApi.addComponent должен быть вызван');
    assert.match(component.icon, /<svg/);
    assert.equal(component.name, 'Без рекламы');

    const names = SettingsApi.getParam('skpt').map(p => p.param.name || p.param.type);
    assert.deepEqual(names, [
        'title', 'skpt_enabled', 'skpt_debug', 'skpt_hosts', 'title', 'skpt_stats'
    ]);
    assert.equal(typeof Lampa.SettingsApi.getParam('skpt')[1].onChange, 'function');
    api.uninstall();
});

test('ТВ-настройки: переключатель с пульта включает/выключает без перезапуска', async () => {
    const { sandbox, api, SettingsApi, storage, calls, document: doc } = boot();
    const params = SettingsApi.getParam('skpt');
    const enabledParam = params.find(p => p.param.name === 'skpt_enabled');

    // Эмулируем Params.bind(): сначала Storage.set, затем onChange(value).
    function toggle(value) {
        LampaStorageSet(storage, 'skpt_enabled', value);
        enabledParam.onChange(value);
    }

    toggle('false');
    assert.equal(api.isEnabled(), false);
    assert.equal(storage.skpt_enabled, 'false');
    assert.equal(doc.head.children.length, 0, 'CSS снят');

    const xhrDisabled = new sandbox.XMLHttpRequest();
    xhrDisabled.open('GET', 'https://cub.best/api/ad/get/preroll');
    xhrDisabled.send();
    assert.equal(calls.nativeSend, 1, 'при выключении запрос уходит в сеть');

    toggle('true');
    assert.equal(api.isEnabled(), true);
    assert.equal(doc.head.children.length, 1, 'CSS вернулся');
    const xhrEnabled = new sandbox.XMLHttpRequest();
    xhrEnabled.open('GET', 'https://cub.best/api/ad/get/banner');
    xhrEnabled.send();
    await tick();
    assert.equal(calls.nativeSend, 1, 'при включении запрос снова подделывается');
    assert.equal(xhrEnabled.status, 200);
    api.uninstall();
});

function LampaStorageSet(storage, name, value) { storage[name] = String(value); }

test('ТВ-настройки: доп. домены вводятся строкой и статистика видна на экране', () => {
    const { api, SettingsApi, calls, storage } = boot();
    const params = SettingsApi.getParam('skpt');
    const hostsParam = params.find(p => p.param.name === 'skpt_hosts');
    const statsParam = params.find(p => p.param.name === 'skpt_stats');

    LampaStorageSet(storage, 'skpt_hosts', 'ad.newmirror.tv, ads.second.net');
    hostsParam.onChange('ad.newmirror.tv, ads.second.net');
    assert.equal(api.classify('https://ad.newmirror.tv/vast?x=1').action, 'block');
    assert.equal(api.classify('https://cdn.ads.second.net/tag.xml').action, 'block');
    assert.equal(api.classify('https://example.com/movie.m3u8'), null);

    statsParam.onChange();
    assert.equal(calls.noty.length, 1);
    assert.match(calls.noty[0].text, /Skpt v2\.1\.0/);
    assert.match(calls.noty[0].text, /XHR/);
    assert.equal(calls.noty[0].params.time, 8000);
    api.uninstall();
});

test('uninstall(): снимает все хуки без перезагрузки', async () => {
    const { sandbox, api, Lampa, SettingsApi, FakeXHR, originalFetch, originalPutScriptAsync, calls } = boot();
    const patchedFetch = sandbox.fetch;
    const patchedOpen = FakeXHR.prototype.open;
    const patchedPlay = Lampa.Player.play;

    api.uninstall();

    assert.equal(sandbox.SkptAdBlock, undefined);
    assert.equal(sandbox.__skpt_adblock__, undefined);
    assert.notEqual(sandbox.fetch, patchedFetch);
    assert.equal(sandbox.fetch, originalFetch);
    assert.notEqual(FakeXHR.prototype.open, patchedOpen);
    assert.notEqual(Lampa.Player.play, patchedPlay);
    assert.equal(Lampa.Utils.putScriptAsync, originalPutScriptAsync);
    assert.equal(SettingsApi.getComponent('skpt'), undefined, 'пункт меню удалён');
    assert.equal(SettingsApi.getParam('skpt').length, 0, 'параметры удалены');

    const xhr = new FakeXHR();
    xhr.open('GET', 'https://cub.best/api/ad/get/preroll');
    xhr.send();
    assert.equal(calls.nativeSend, 1, 'после uninstall запросы идут в сеть');
    assert.equal((await sandbox.fetch('https://cub.best/api/ad/get/preroll')).status, 200);
    assert.equal(calls.fetch, 1);
});

test('повторная загрузка той же версии не дублирует хуки', () => {
    const { sandbox, api, FakeXHR, calls } = boot();
    const patchedOpen = FakeXHR.prototype.open;
    vm.runInContext(CODE, sandbox, { filename: 'Skpt.js (second load)' });
    assert.equal(FakeXHR.prototype.open, patchedOpen);
    assert.equal(sandbox.SkptAdBlock, api);
    api.uninstall();
    assert.equal(calls.nativeSend, 0);
});
