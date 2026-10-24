(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v7';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    console.log('[AdSkipper] Initializing v7 (Safe multi-layer interception)...');

    // ==========================================
    // 1. СЕТЕВАЯ БЛОКИРОВКА (204 No Content)
    // ==========================================
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
                    } catch (e) {
                        console.warn('[AdSkipper] Failed to spoof XHR response', e);
                    }
                }, 0);
                return;
            }
            return originalSend.apply(this, arguments);
        };
    }

    // ==========================================
    // 2. ПЕРЕХВАТ ЛОГИКИ IMA
    // ==========================================
    
    // Приоритетный метод: IMA.getMediaType
    // Согласно исходному коду preroll.js, возврат объекта { any: true } 
    // заставляет систему пропустить рекламу.
    function patchIMAMediaType() {
        try {
            var IMA = (window.Lampa && window.Lampa.IMA) 
                   || (window.Lampa && window.Lampa.Advert && window.Lampa.Advert.IMA);

            if (!IMA) {
                console.warn('[AdSkipper] IMA module not found. Trying next fallback...');
                return false;
            }

            if (typeof IMA.getMediaType !== 'function') {
                console.warn('[AdSkipper] IMA.getMediaType is not a function. Trying next fallback...');
                return false;
            }

            // Сохраняем оригинал для возможного восстановления
            var originalGetMediaType = IMA.getMediaType;
            
            IMA.getMediaType = function (data) {
                try {
                    console.log('[AdSkipper] IMA.getMediaType intercepted. Blocking ads.');
                    return { any: true }; // Ключевой флаг для пропуска рекламы
                } catch (e) {
                    console.error('[AdSkipper] Error in patched getMediaType:', e);
                    return originalGetMediaType.apply(this, arguments);
                }
            };

            console.log('[AdSkipper] IMA.getMediaType patched successfully.');
            return true;
        } catch (e) {
            console.error('[AdSkipper] Failed to patch IMA.getMediaType:', e);
            return false;
        }
    }

    // Резервный метод: IMA.canShow
    // Более безопасная альтернатива перехвату Preroll.show
    function patchIMACanShow() {
        try {
            var IMA = (window.Lampa && window.Lampa.IMA) 
                   || (window.Lampa && window.Lampa.Advert && window.Lampa.Advert.IMA);

            if (!IMA || typeof IMA.canShow !== 'function') {
                return false;
            }

            var originalCanShow = IMA.canShow;
            IMA.canShow = function (data) {
                try {
                    console.log('[AdSkipper] IMA.canShow intercepted. Returning false.');
                    return false;
                } catch (e) {
                    console.error('[AdSkipper] Error in patched canShow:', e);
                    return originalCanShow.apply(this, arguments);
                }
            };

            console.log('[AdSkipper] IMA.canShow patched successfully.');
            return true;
        } catch (e) {
            console.error('[AdSkipper] Failed to patch IMA.canShow:', e);
            return false;
        }
    }

    // ==========================================
    // 3. БЕЗОПАСНЫЙ РЕЗЕРВНЫЙ ПЕРЕХВАТ PREROLL.SHOW
    // ==========================================
    // Используется только если IMA модули недоступны.
    // Вместо агрессивного вмешательства, мы аккуратно вызываем колбэк.
    function patchPrerollShowFallback() {
        try {
            var Preroll = (window.Lampa && window.Lampa.Advert && window.Lampa.Advert.Preroll)
                || (window.Lampa && window.Lampa.Preroll);

            if (!Preroll || typeof Preroll.show !== 'function') {
                console.warn('[AdSkipper] Preroll.show not found. Ad blocking may be incomplete.');
                return false;
            }

            var originalShow = Preroll.show;
            Preroll.show = function (data, call) {
                console.log('[AdSkipper] Preroll.show intercepted (fallback). Skipping ad.');
                // Асинхронный вызов колбэка, чтобы не ломать текущий стек вызовов плеера
                if (typeof call === 'function') {
                    setTimeout(function () {
                        try {
                            call();
                        } catch (e) {
                            console.error('[AdSkipper] Error in Preroll.show callback:', e);
                        }
                    }, 0);
                }
                return false;
            };

            console.log('[AdSkipper] Preroll.show patched (fallback).');
            return true;
        } catch (e) {
            console.error('[AdSkipper] Failed to patch Preroll.show:', e);
            return false;
        }
    }

    // ==========================================
    // 4. DOM-СТРАХОВКА
    // ==========================================
    function killAdVideo(node) {
        if (!node) return;
        var videos = node.tagName === 'VIDEO' ? [node] : node.querySelectorAll('video');
        videos.forEach(function (video) {
            // Защита основного плеера
            if (video.closest('.player') || video.closest('.video-player') || video.id === 'player') {
                return;
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

    // ==========================================
    // ИНИЦИАЛИЗАЦИЯ
    // ==========================================
    function initializeProtection() {
        // Пытаемся применить перехваты в порядке приоритета
        var patched = false;

        if (patchIMAMediaType()) {
            patched = true;
        } else if (patchIMACanShow()) {
            patched = true;
        } else if (patchPrerollShowFallback()) {
            patched = true;
        }

        if (!patched) {
            console.warn('[AdSkipper] No IMA or Preroll modules found. Only network blocking is active.');
        }

        // DOM-страховка работает всегда
        setupDomGuard();
    }

    // Ждем загрузки приложения Lampa для гарантии наличия модулей
    if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') {
                // Небольшая задержка для инициализации всех внутренних модулей
                setTimeout(initializeProtection, 1000);
            }
        });
    } else {
        // Крайний случай: пробуем через 3 секунды
        setTimeout(initializeProtection, 3000);
    }
})();
