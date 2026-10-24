(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v5';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    console.log('[AdSkipper] Initializing v5 (VastManager.filter override)...');

    // --- 1. Сетевая страховка (204 No Content) ---
    var AD_HOSTS = ['ad.cub.red', 'ads.cub.red', 'ad.cub.rip', 'ads.cub.rip'];
    
    function isAdUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return AD_HOSTS.some(function (host) { return url.indexOf(host) !== -1; });
    }

    var originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);
            if (isAdUrl(url)) {
                console.log('[AdSkipper] Blocked fetch (204):', url);
                return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
            }
            return originalFetch.apply(this, arguments);
        };
    }

    var OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR) {
        var originalOpen = OriginalXHR.prototype.open;
        var originalSend = OriginalXHR.prototype.send;
        
        OriginalXHR.prototype.open = function (method, url) {
            this._requestUrl = url;
            return originalOpen.apply(this, arguments);
        };

        OriginalXHR.prototype.send = function (body) {
            if (isAdUrl(this._requestUrl)) {
                console.log('[AdSkipper] Blocked XHR (204):', this._requestUrl);
                var self = this;
                setTimeout(function () {
                    try {
                        Object.defineProperty(self, 'readyState', { value: 4, writable: true });
                        Object.defineProperty(self, 'status', { value: 204, writable: true });
                        Object.defineProperty(self, 'responseText', { value: '', writable: true });
                        if (self.onreadystatechange) self.onreadystatechange();
                        if (self.onload) self.onload();
                    } catch (e) {}
                }, 0);
                return;
            }
            return originalSend.apply(this, arguments);
        };
    }

    // --- 2. Ключевой перехват: VastManager.filter ---
    // Он заставляет менеджер всегда возвращать null, то есть "рекламы нет".
    function patchVastManager() {
        try {
            // Ищем класс VastManager. В разных сборках он может лежать в Lampa.Advert или быть глобальным.
            var VastManagerClass = null;
            if (window.Lampa && window.Lampa.Advert && window.Lampa.Advert.VastManager) {
                VastManagerClass = window.Lampa.Advert.VastManager;
            } else if (window.Lampa && window.Lampa.VastManager) {
                VastManagerClass = window.Lampa.VastManager;
            }

            if (!VastManagerClass || !VastManagerClass.prototype) {
                return false;
            }

            // Подменяем filter на прототипе
            var originalFilter = VastManagerClass.prototype.filter;
            VastManagerClass.prototype.filter = function (view) {
                console.log('[AdSkipper] VastManager.filter intercepted. Blocking ads.');
                return null; // Всегда говорим: "нет рекламы"
            };

            console.log('[AdSkipper] VastManager.filter patched successfully.');
            return true;
        } catch (e) {
            console.error('[AdSkipper] Failed to patch VastManager:', e);
            return false;
        }
    }

    // --- 3. DOM-страховка (удаление любых прорвавшихся элементов) ---
    function killAdVideo(node) {
        if (!node) return;
        var videos = node.tagName === 'VIDEO' ? [node] : node.querySelectorAll('video');
        videos.forEach(function (video) {
            if (video.closest('.player') || video.closest('.video-player') || video.id === 'player') {
                return; // Не трогаем основной плеер
            }
            try {
                video.pause();
                video.muted = true;
                video.removeAttribute('src');
                video.load();
                console.log('[AdSkipper] Killed background ad video.');
            } catch(e) {}
        });
    }

    function setupDomGuard() {
        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1 && node.classList) {
                        if (node.classList.contains('ad-preroll') ||
                            node.classList.contains('ad-video-block') ||
                            node.classList.contains('ad-countdown') ||
                            node.classList.contains('ad-server') ||
                            node.classList.contains('ad-bot') ||
                            node.classList.contains('vast-block')) {
                            
                            killAdVideo(node);
                            setTimeout(function () {
                                if (node.parentNode) {
                                    killAdVideo(node);
                                    node.parentNode.removeChild(node);
                                    console.log('[AdSkipper] Removed ad DOM element.');
                                }
                            }, 300);
                        }
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // --- Инициализация ---
    // Пытаемся пропатчить сразу, если VastManager уже есть
    if (patchVastManager()) {
        setupDomGuard();
    } else {
        // Если нет, ждём события готовности приложения
        if (window.Lampa && window.Lampa.Listener) {
            window.Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') {
                    setTimeout(function () {
                        if (!patchVastManager()) {
                            console.warn('[AdSkipper] VastManager not found after app ready.');
                        }
                        setupDomGuard();
                    }, 1000);
                }
            });
        } else {
            // Крайний случай: пробуем через 3 секунды
            setTimeout(function () {
                patchVastManager();
                setupDomGuard();
            }, 3000);
        }
    }
})();
