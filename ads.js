(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v2';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    // --- 1. Сетевая блокировка (страховка) ---
    var AD_HOSTS = ['ad.cub.red', 'ads.cub.red'];
    function isAdUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return AD_HOSTS.some(function (host) { return url.indexOf(host) !== -1; });
    }

    var originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);
            if (isAdUrl(url)) {
                console.log('[AdSkipper] Blocked fetch to ad host:', url);
                return Promise.resolve(new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
            }
            return originalFetch.apply(this, arguments);
        };
    }

    var OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR) {
        var open = OriginalXHR.prototype.open;
        OriginalXHR.prototype.open = function (method, url) {
            if (isAdUrl(url)) {
                console.log('[AdSkipper] Blocked XHR to ad host:', url);
                arguments[1] = 'data:text/xml,<VAST version="2.0"></VAST>';
            }
            return open.apply(this, arguments);
        };
    }

    // --- 2. Патч Preroll.show() ---
    function patchPreroll() {
        try {
            var Preroll = (window.Lampa && window.Lampa.Advert && window.Lampa.Advert.Preroll)
                || (window.Lampa && window.Lampa.Preroll);
            if (!Preroll || typeof Preroll.show !== 'function') return false;

            var originalShow = Preroll.show;
            Preroll.show = function (data, onComplete) {
                console.log('[AdSkipper] Preroll.show() intercepted. Skipping ad.');
                if (typeof onComplete === 'function') {
                    setTimeout(function () {
                        try { onComplete(); } catch (e) { console.error('[AdSkipper] onComplete error:', e); }
                    }, 0);
                }
                return false;
            };
            console.log('[AdSkipper] Preroll.show patched.');
            return true;
        } catch (e) {
            console.error('[AdSkipper] Preroll patch failed:', e);
            return false;
        }
    }

    // --- 3. DOM-страховка ---
    function setupDomGuard() {
        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1 && node.classList) {
                        if (node.classList.contains('ad-preroll') ||
                            node.classList.contains('ad-video-block') ||
                            node.classList.contains('ad-countdown') ||
                            node.classList.contains('ad-server')) {
                            setTimeout(function () {
                                if (node.parentNode) {
                                    node.parentNode.removeChild(node);
                                    console.log('[AdSkipper] Removed ad DOM element:', node.className);
                                }
                            }, 1000);
                        }
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // --- Инициализация ---
    function start() {
        if (patchPreroll()) {
            setupDomGuard();
            return;
        }
        if (window.Lampa && window.Lampa.Listener) {
            window.Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') {
                    setTimeout(function () {
                        if (!patchPreroll()) {
                            console.warn('[AdSkipper] Preroll not found after app ready.');
                        }
                        setupDomGuard();
                    }, 1500);
                }
            });
        } else {
            setTimeout(function () {
                patchPreroll();
                setupDomGuard();
            }, 3000);
        }
    }

    start();
})();
