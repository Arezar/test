(function () {
    'use strict';

    // ========== Манифест ==========
    Lampa.Manifest.plugins = {
        type: 'other',
        version: '1.0.3',
        name: 'NoAds',
        description: 'Блокировка рекламы',
        component: 'noads_plugin'
    };

    // ========== Паттерны рекламных URL ==========
    var AD_URL = /\/ad[s]?[\/?]|vast[\/?&.]|\.vast|ad_request|advert|prebid|pagead|doubleclick|googlesyndication/i;

    function isAdUrl(url) {
        return typeof url === 'string' && AD_URL.test(url);
    }

    // ========== Основная функция ==========
    function start() {
        console.log('[NoAds] запущен');

        // ---- 1. Подмена подписки в Storage ----
        try {
            var acc = Lampa.Storage.get('account', '{}');
            if (typeof acc === 'string') acc = JSON.parse(acc);
            acc.premium = true;
            Lampa.Storage.set('account', acc);
        } catch (e) {}

        // Перехват Storage.get — при любом чтении account
        // всегда premium = true
        var origGet = Lampa.Storage.get.bind(Lampa.Storage);
        Lampa.Storage.get = function (key, def) {
            var val = origGet(key, def);
            if (key === 'account' || key === 'account_premium') {
                if (typeof val === 'object' && val !== null) {
                    val.premium = true;
                }
                if (key === 'account_premium') return true;
            }
            return val;
        };

        // ---- 2. Подмена рекламных объектов (безопасно) ----
        var noop = function () { return false; };
        var adNames = ['Ad', 'Ads', 'Advert', 'ADManager'];

        adNames.forEach(function (name) {
            if (Lampa[name] && typeof Lampa[name] === 'object') {
                Object.keys(Lampa[name]).forEach(function (fn) {
                    if (typeof Lampa[name][fn] === 'function') {
                        Lampa[name][fn] = noop;
                    }
                });
            }
        });

        // ---- 3. Перехват fetch ----
        var _fetch = window.fetch;
        window.fetch = function (input, init) {
            var url = typeof input === 'string'
                ? input
                : (input && input.url ? input.url : '');
            if (isAdUrl(url)) {
                console.log('[NoAds] fetch blocked:', url);
                return Promise.resolve(
                    new Response('{}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    })
                );
            }
            return _fetch.apply(this, arguments);
        };

        // ---- 4. Перехват XMLHttpRequest ----
        var _xhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            if (isAdUrl(url)) {
                console.log('[NoAds] XHR blocked:', url);
                this._blocked = true;
                return _xhrOpen.call(this, method, 'data:text/plain,');
            }
            this._blocked = false;
            return _xhrOpen.apply(this, arguments);
        };

        var _xhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
            if (this._blocked) {
                console.log('[NoAds] XHR send blocked');
                return;
            }
            return _xhrSend.apply(this, arguments);
        };

        // ---- 5. CSS — скрытие рекламных элементов ----
        // Только конкретные классы, чтобы не задеть меню
        var style = document.createElement('style');
        style.textContent = [
            '.ad-overlay,',
            '.ad-panel,',
            '.ad-video-wrapper,',
            '.card--ad,',
            '.ad-overlay__content,',
            '.ad-preroll,',
            '.vast-overlay,',
            '.vast-container {',
            '  display: none !important;',
            '  width: 0 !important;',
            '  height: 0 !important;',
            '  opacity: 0 !important;',
            '  pointer-events: none !important;',
            '  position: absolute !important;',
            '  left: -9999px !important;',
            '}'
        ].join('\n');
        document.head.appendChild(style);

        // ---- 6. MutationObserver — точечное удаление ----
        // Только элементы с конкретными рекламными классами
        var adClasses = [
            'ad-overlay', 'ad-panel', 'ad-video-wrapper',
            'card--ad', 'ad-preroll', 'vast-overlay',
            'vast-container', 'ad-overlay__content'
        ];

        function isAdElement(node) {
            if (!node.classList) return false;
            for (var i = 0; i < adClasses.length; i++) {
                if (node.classList.contains(adClasses[i])) return true;
            }
            return false;
        }

        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mut) {
                mut.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1 && isAdElement(node)) {
                        node.remove();
                        console.log('[NoAds] DOM element removed');
                    }
                });
            });
        });

        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        // ---- 7. Перехват создания video только для VAST ----
        // НЕ блокируем обычное видео, только рекламное
        var origAppend = Element.prototype.appendChild;
        Element.prototype.appendChild = function (child) {
            if (child && child.tagName === 'VIDEO' && child.src && isAdUrl(child.src)) {
                console.log('[NoAds] ad video blocked');
                return child; // не вставляем, возвращаем как есть
            }
            return origAppend.apply(this, arguments);
        };
    }

    // ========== Запуск ==========
    if (window.appready) {
        start();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
