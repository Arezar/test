(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v12';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    console.log('[AdSkipper] Initializing v12 (final, leak-free)...');

    // ==========================================
    // 1. СЕТЕВАЯ БЛОКИРОВКА
    // ==========================================
    var AD_HOSTS = ['ad.cub.red', 'ads.cub.red', 'ad.cub.rip', 'ads.cub.rip'];
    
    function isAdUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            var hostname = new URL(url, window.location.href).hostname;
            return AD_HOSTS.some(function (host) {
                return hostname === host || hostname.endsWith('.' + host);
            });
        } catch (e) {
            return false;
        }
    }

    // --- Fetch ---
    if (window.fetch) {
        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);
            if (isAdUrl(url)) {
                console.log('[AdSkipper] Blocked fetch (204):', url);
                return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
            }
            return originalFetch.apply(this, arguments);
        };
    }

    // --- XMLHttpRequest ---
    if (window.XMLHttpRequest) {
        var xhrStateMap = new WeakMap();
        
        window.XMLHttpRequest = new Proxy(window.XMLHttpRequest, {
            construct: function (target, args, newTarget) {
                // Используем Reflect.construct для корректной работы с наследованием
                var xhr = Reflect.construct(target, args, newTarget);
                
                var originalOpen = xhr.open;
                var originalSend = xhr.send;
                var originalAbort = xhr.abort;
                
                xhr.open = function (method, url) {
                    // КРИТИЧЕСКИЙ ФИКС: Восстанавливаем нативные методы заголовков, 
                    // если они были испорчены предыдущим заблокированным запросом
                    if (xhr._adsHeadersPatched) {
                        delete xhr.getAllResponseHeaders;
                        delete xhr.getResponseHeader;
                        xhr._adsHeadersPatched = false;
                    }

                    var currentState = xhrStateMap.get(xhr) || { gen: 0 };
                    xhrStateMap.set(xhr, {
                        url: url,
                        gen: currentState.gen + 1,
                        blocked: false
                    });
                    return originalOpen.apply(this, arguments);
                };
                
                xhr.send = function (body) {
                    var state = xhrStateMap.get(xhr);
                    if (state && isAdUrl(state.url)) {
                        console.log('[AdSkipper] Blocked XHR (Proxy 204):', state.url);
                        state.blocked = true;
                        var self = this;
                        var currentGen = state.gen;
                        
                        setTimeout(function () {
                            var checkState = xhrStateMap.get(self);
                            // Проверяем, что это тот же запрос и его не отменили через abort()
                            if (!checkState || checkState.gen !== currentGen || !checkState.blocked) {
                                return; 
                            }

                            try {
                                var rt = self.responseType;
                                Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
                                Object.defineProperty(self, 'status', { value: 204, configurable: true });
                                Object.defineProperty(self, 'statusText', { value: 'No Content', configurable: true });
                                Object.defineProperty(self, 'responseURL', { value: state.url, configurable: true });
                                
                                if (rt === 'json') {
                                    Object.defineProperty(self, 'response', { value: {}, configurable: true });
                                } else if (rt === 'blob') {
                                    Object.defineProperty(self, 'response', { value: new Blob([]), configurable: true });
                                } else if (rt === 'arraybuffer') {
                                    Object.defineProperty(self, 'response', { value: new ArrayBuffer(0), configurable: true });
                                } else if (rt === 'document') {
                                    Object.defineProperty(self, 'response', { value: null, configurable: true });
                                } else {
                                    Object.defineProperty(self, 'responseText', { value: '', configurable: true });
                                    Object.defineProperty(self, 'response', { value: '', configurable: true });
                                }

                                // Ставим флаг, чтобы методы были удалены при следующем open()
                                self._adsHeadersPatched = true;
                                self.getAllResponseHeaders = function () { return ''; };
                                self.getResponseHeader = function () { return null; };
                                
                                // Триггерим стандартные события (поддержка и on..., и addEventListener)
                                self.dispatchEvent(new Event('readystatechange'));
                                self.dispatchEvent(new ProgressEvent('load'));
                                self.dispatchEvent(new ProgressEvent('loadend'));
                            } catch (e) {
                                console.warn('[AdSkipper] Failed to spoof XHR properties', e);
                            }
                        }, 0);
                        return;
                    }
                    return originalSend.apply(this, arguments);
                };

                xhr.abort = function () {
                    var state = xhrStateMap.get(xhr);
                    if (state && state.blocked) {
                        console.log('[AdSkipper] Abort called on blocked XHR (preventing callbacks)');
                        state.blocked = false; // Отменяем вызов onload в setTimeout
                        return;
                    }
                    return originalAbort.apply(this, arguments);
                };
                
                return xhr;
            }
        });
    }

    // ==========================================
    // 2. ПЕРЕХВАТ ЛОГИКИ PREROLL
    // ==========================================
    function patchPrerollMethods() {
        try {
            var Preroll = (window.Lampa && window.Lampa.Advert && window.Lampa.Advert.Preroll)
                       || (window.Lampa && window.Lampa.Preroll);

            if (!Preroll) {
                console.warn('[AdSkipper] Preroll module not found.');
                return false;
            }

            var patched = false;

            if (typeof Preroll.getMediaType === 'function') {
                Preroll.getMediaType = function (data) {
                    console.log('[AdSkipper] Preroll.getMediaType intercepted -> { any: true }');
                    return { any: true }; 
                };
                patched = true;
            }

            if (typeof Preroll.canShow === 'function') {
                Preroll.canShow = function (data) {
                    console.log('[AdSkipper] Preroll.canShow intercepted -> false');
                    return false;
                };
                patched = true;
            }

            if (patched) {
                console.log('[AdSkipper] Preroll methods patched successfully.');
            } else {
                console.warn('[AdSkipper] No target methods found in Preroll.');
            }
            return patched;
        } catch (e) {
            console.error('[AdSkipper] Failed to patch Preroll:', e);
            return false;
        }
    }

    // ==========================================
    // 3. МЯГКИЙ DOM-СТРАЖ
    // ==========================================
    function setupDomGuard() {
        if (!document.body) {
            setTimeout(setupDomGuard, 200);
            return;
        }

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
                            
                            node.style.setProperty('display', 'none', 'important');
                            
                            setTimeout(function () {
                                if (node.parentNode) {
                                    if (!node.querySelector('.player') && !node.querySelector('#player')) {
                                        node.parentNode.removeChild(node);
                                        console.log('[AdSkipper] Safely removed hidden ad element.');
                                    }
                                }
                            }, 1000);
                        }
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ==========================================
    // 4. ИНИЦИАЛИЗАЦИЯ
    // ==========================================
    function initializeProtection() {
        patchPrerollMethods();
        setupDomGuard();
    }

    if (window.appready) {
        setTimeout(initializeProtection, 500);
    } else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') {
                setTimeout(initializeProtection, 500);
            }
        });
    } else {
        setTimeout(initializeProtection, 3000);
    }
})();
