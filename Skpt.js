(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v13';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    console.log('[AdSkipper] Initializing v13 (root-cause fix)...');

    // ==========================================
    // 1. СЕТЕВАЯ БЛОКИРОВКА
    // ==========================================

    // Запасной список доменов, которые реально отдают рекламный контент/трекинг.
    // Оставлен как defense-in-depth, но это НЕ главный источник проблемы.
    var AD_HOSTS = ['ad.cub.red', 'ads.cub.red', 'ad.cub.rip', 'ads.cub.rip'];

    function isAdHostUrl(url) {
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


    function isAdConfigUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return /\/api\/ad\/get\//.test(url);
    }

    function fakeEmptyAdJson() {
        return JSON.stringify({ ad: [] });
    }

    // --- Fetch ---
    if (window.fetch) {
        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);

            if (isAdConfigUrl(url)) {
                console.log('[AdSkipper] Faked empty ad-config (200):', url);
                return Promise.resolve(new Response(fakeEmptyAdJson(), {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'application/json' }
                }));
            }

            if (isAdHostUrl(url)) {
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
                var xhr = Reflect.construct(target, args, newTarget);

                var originalOpen = xhr.open;
                var originalSend = xhr.send;
                var originalAbort = xhr.abort;

                xhr.open = function (method, url) {
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
                    var mode = null;

                    if (state && isAdConfigUrl(state.url)) mode = 'fake_json';
                    else if (state && isAdHostUrl(state.url)) mode = 'empty_204';

                    if (mode) {
                        console.log('[AdSkipper] Blocked XHR (' + mode + '):', state.url);
                        state.blocked = true;
                        var self = this;
                        var currentGen = state.gen;

                        setTimeout(function () {
                            var checkState = xhrStateMap.get(self);
                            if (!checkState || checkState.gen !== currentGen || !checkState.blocked) {
                                return;
                            }

                            try {
                                var rt = self.responseType;
                                var status = mode === 'fake_json' ? 200 : 204;
                                var statusText = mode === 'fake_json' ? 'OK' : 'No Content';
                                var bodyText = mode === 'fake_json' ? fakeEmptyAdJson() : '';

                                Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
                                Object.defineProperty(self, 'status', { value: status, configurable: true });
                                Object.defineProperty(self, 'statusText', { value: statusText, configurable: true });
                                Object.defineProperty(self, 'responseURL', { value: state.url, configurable: true });

                                if (rt === 'json') {
                                    Object.defineProperty(self, 'response', { value: mode === 'fake_json' ? { ad: [] } : {}, configurable: true });
                                } else if (rt === 'blob') {
                                    Object.defineProperty(self, 'response', { value: new Blob([bodyText]), configurable: true });
                                } else if (rt === 'arraybuffer') {
                                    Object.defineProperty(self, 'response', { value: new ArrayBuffer(0), configurable: true });
                                } else if (rt === 'document') {
                                    Object.defineProperty(self, 'response', { value: null, configurable: true });
                                } else {
                                    Object.defineProperty(self, 'responseText', { value: bodyText, configurable: true });
                                    Object.defineProperty(self, 'response', { value: bodyText, configurable: true });
                                }

                                self._adsHeadersPatched = true;
                                self.getAllResponseHeaders = function () {
                                    return mode === 'fake_json' ? 'content-type: application/json\r\n' : '';
                                };
                                self.getResponseHeader = function (name) {
                                    if (mode === 'fake_json' && /content-type/i.test(name || '')) return 'application/json';
                                    return null;
                                };

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
                        state.blocked = false;
                        return;
                    }
                    return originalAbort.apply(this, arguments);
                };

                return xhr;
            }
        });
    }

    // ==========================================
    // 2. ДОП. ПОПЫТКА ПАТЧА ПУБЛИЧНОГО API
    function patchPrerollMethodsIfExposed() {
        try {
            var candidates = [
                window.Lampa && window.Lampa.Advert && window.Lampa.Advert.Preroll,
                window.Lampa && window.Lampa.Preroll,
                window.Lampa && window.Lampa.Advert && window.Lampa.Advert.IMA,
                window.Lampa && window.Lampa.IMA
            ].filter(Boolean);

            if (!candidates.length) {
                console.log('[AdSkipper] Public Preroll/IMA API not exposed - relying on network-level fix only (this is normal).');
                return;
            }

            candidates.forEach(function (mod) {
                if (typeof mod.canShow === 'function') {
                    mod.canShow = function () { return false; };
                }
                if (typeof mod.getMediaType === 'function') {
                    mod.getMediaType = function () { return { any: true }; };
                }
                if (typeof mod.show === 'function') {
                    mod.show = function (data, call) {
                        console.log('[AdSkipper] Preroll.show intercepted, skipping ad instantly');
                        if (typeof call === 'function') call();
                    };
                }
            });

            console.log('[AdSkipper] Public Preroll/IMA methods patched (bonus layer).');
        } catch (e) {
            console.warn('[AdSkipper] optional Preroll patch failed', e);
        }
    }

    // ==========================================
    // 3. МЯГКИЙ DOM-СТРАЖ (страховка, в норме теперь не должен срабатывать)
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

                            // Если реклама всё же пытается показаться - принудительно
                            // возвращаем управление пульту, чтобы навигация не зависала.
                            try {
                                if (window.Lampa && window.Lampa.Controller) {
                                    window.Lampa.Controller.toggle(window.Lampa.Controller.enabled().name === 'ad_preroll' || window.Lampa.Controller.enabled().name === 'ad_video_block' ? 'content' : window.Lampa.Controller.enabled().name);
                                }
                            } catch (e) {}

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
        patchPrerollMethodsIfExposed();
        setupDomGuard();
    }

    // Сетевые перехватчики (fetch/XHR) уже активны сразу после выполнения IIFE,
    // поэтому первый же запрос /api/ad/get/preroll (который Lampa делает при
    // старте плеера) будет перехвачен независимо от того, когда сработает
    // initializeProtection().
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
