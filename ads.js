(function () {
    'use strict';

    Lampa.Manifest.plugins = {
        type: 'other',
        version: '1.0.1',
        name: 'NoAds',
        description: 'Блокировка рекламы',
        component: 'noads'
    };

    function block() {
        console.log('[NoAds] Активирован');

        // 1. Подмена проверки премиума
        if (Lampa.Account) {
            var origHas = Lampa.Account.hasPremium;
            Lampa.Account.hasPremium = function () { return true; };
        }

        // 2. Нейтрализация модуля рекламы
        if (Lampa.Ad) {
            Lampa.Ad.show    = function () { console.log('[NoAds] Ad.show blocked'); return false; };
            Lampa.Ad.load    = function () { console.log('[NoAds] Ad.load blocked'); return false; };
            Lampa.Ad.request = function () { console.log('[NoAds] Ad.request blocked'); return false; };
            Lampa.Ad.close   = function () { return true; };
        }

        // 3. Блокировка VAST запросов через fetch
        var origFetch = window.fetch;
        window.fetch = function (input) {
            var url = typeof input === 'string' ? input : (input.url || '');
            if (/vast|\/ad\/|\/ads\/|ad_request|cub\.watch\/api\/ad/i.test(url)) {
                console.log('[NoAds] fetch заблокирован:', url);
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            return origFetch.apply(this, arguments);
        };

        // 4. Блокировка VAST через XHR
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            if (/vast|\/ad\/|\/ads\/|ad_request|cub\.watch\/api\/ad/i.test(url)) {
                console.log('[NoAds] XHR заблокирован:', url);
                arguments[1] = 'data:text/plain,';
            }
            return origOpen.apply(this, arguments);
        };

        // 5. Удаление рекламных шаблонов
        ['ad_overlay', 'ad_banner', 'ad_panel'].forEach(function (name) {
            try { Lampa.Template.add(name, '<div></div>'); } catch (e) {}
        });

        // 6. Перехват Listener — блокируем показ interstitial
        var origFollow = Lampa.Listener.follow;
        Lampa.Listener.follow = function (name, callback) {
            if (typeof callback === 'function') {
                var wrapped = function (e) {
                    // Не даём рекламным обработчикам сработать
                    if (e && e.ad) return;
                    return callback.apply(this, arguments);
                };
                return origFollow.call(this, name, wrapped);
            }
            return origFollow.apply(this, arguments);
        };

        // 7. CSS — скрытие рекламных элементов
        var style = document.createElement('style');
        style.textContent = [
            '.ad-overlay, .ad-panel, .card--ad,',
            '[class*="ad-video"], [class*="ad_overlay"],',
            '[class*="vast-"], .ad-overlay__content {',
            '  display:none!important;',
            '  opacity:0!important;',
            '  pointer-events:none!important;',
            '}'
        ].join('');
        document.head.appendChild(style);
    }

    // Инициализация
    if (window.appready) {
        block();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') block();
        });
    }

})();
