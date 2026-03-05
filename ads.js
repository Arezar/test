(function() {
    'use strict';
    console.log('[AdBlock] Инициализация...');

    // ============================================
    // 1. Ждём загрузки Lampa
    // ============================================
    function onLampaReady(callback) {
        if (window.Lampa) return callback();
        var timer = setInterval(function() {
            if (window.Lampa) {
                clearInterval(timer);
                callback();
            }
        }, 100);
    }

    onLampaReady(function() {

        // ============================================
        // 2. Блокируем рекламный модуль Lampa
        // ============================================
        if (Lampa.Ad) {
            Lampa.Ad.show  = function() { console.log('[AdBlock] Ad.show заблокирован'); };
            Lampa.Ad.load  = function() { console.log('[AdBlock] Ad.load заблокирован'); };
            Lampa.Ad.get   = function() { return ''; };
            Lampa.Ad.start = function() {};
        }

        if (Lampa.Ads) {
            Lampa.Ads.show  = function() {};
            Lampa.Ads.load  = function() {};
            Lampa.Ads.get   = function() { return ''; };
            Lampa.Ads.start = function() {};
        }

        // ============================================
        // 3. Подменяем статус аккаунта (премиум)
        // ============================================
        if (Lampa.Account) {
            var origHasPremium = Lampa.Account.hasPremium;
            Lampa.Account.hasPremium = function() { return true; };

            // Некоторые версии используют .premium()
            if (Lampa.Account.premium) {
                Lampa.Account.premium = function() { return true; };
            }
        }

        observer.observe(document.body, { childList: true, subtree: true });

        console.log('[AdBlock] Блокировка рекламы активна ✓');
    });
})();
