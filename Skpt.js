(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v16';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    console.log('[AdSkipper] Initializing v16 (regex mirrors + safe spoof)...');

    // ==========================================
    // ХЕЛПЕРЫ
    // ==========================================
    function createSafeProgressEvent(type) {
        try {
            return new ProgressEvent(type);
        } catch (e) {
            return new Event(type);
        }
    }

    // Регулярка для любых зеркал: ad.cub.red, ads.cub.black, ad.cub.best и т.д.
    var AD_HOST_REGEX = /^(ad|ads)\.cub\.[a-z]+$/i;

    function isAdHostUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            var hostname = new URL(url, window.location.href).hostname;
            // Проверка по регулярному выражению
            return AD_HOST_REGEX.test(hostname);
        } catch (e) {
            return false;
        }
    }

    function isAdConfigUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            var parsed = new URL(url, window.location.href);
            // Домен не важен (может быть любое зеркало), проверяем только путь
            return parsed.pathname === '/api/ad/get/' || parsed.pathname.startsWith('/api/ad/get/');
        } catch (e) {
            return false;
        }
    }

    function getFakeAdJson() {
        return JSON.stringify({ ad: [], settings: {}, ab: {} });
    }

    // ==========================================
    // 1. СЕТЕВАЯ БЛОКИРОВКА (Fetch + XHR)
    // ==========================================
    
    if (window.fetch) {
        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);

            if (isAdConfigUrl(url)) {
                console.log('[AdSkipper] Faked empty ad-config (200):', url);
                return Promise.resolve(new Response(getFakeAdJson(), {
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
                                var bodyText = mode === 'fake_json' ? getFakeAdJson() : '';

                                Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
                                Object.defineProperty(self, 'status', { value: status, configurable: true });
                                Object.defineProperty(self, 'statusText', { value: statusText, configurable: true });
                                Object.defineProperty(self, 'responseURL', { value: state.url, configurable: true });

                                if (rt === 'json') {
                                    Object.defineProperty(self, 'response', { value: mode === 'fake_json' ? JSON.parse(bodyText) : {}, configurable: true });
                                } else if (rt === 'blob') {
                                    Object.defineProperty(self, 'response', { value: new Blob([bodyText]), configurable: true });
                                } else if (rt === 'arraybuffer') {
                                    var buffer = mode === 'fake_json' ? new TextEncoder().encode(bodyText).buffer : new ArrayBuffer(0);
                                    Object.defineProperty(self, 'response', { value: buffer, configurable: true });
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
                                self.dispatchEvent(createSafeProgressEvent('load'));
                                self.dispatchEvent(createSafeProgressEvent('loadend'));
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
    // 2. БЕЗОПАСНЫЙ СПУФ ACCOUNT
    // ==========================================
    function patchAccount() {
        function applySpoof(obj) {
            if (!obj) return;
            try {
                obj.hasPremium = function () { return true; };
                console.log('[AdSkipper] Spoofed Account.hasPremium = true');
            } catch (e) {}
        }

        if (window.Account) applySpoof(window.Account);
        if (window.Lampa && window.Lampa.Account) applySpoof(window.Lampa.Account);

        try {
            var _account = window.Account;
            Object.defineProperty(window, 'Account', {
                get: function () { return _account; },
                set: function (val) {
                    _account = val;
                    applySpoof(_account);
                },
                configurable: true
            });
        } catch (e) {}
    }

    // ==========================================
    // 3. ПАТЧ PREROLL API
    // ==========================================
    function patchPrerollMethodsIfExposed() {
        try {
            var candidates = [
                window.Lampa && window.Lampa.Advert && window.Lampa.Advert.Preroll,
                window.Lampa && window.Lampa.Preroll
            ].filter(Boolean);

            if (!candidates.length) return;

            candidates.forEach(function (mod) {
                if (typeof mod.canShow === 'function') {
                    mod.canShow = function () { return false; };
                }
                if (typeof mod.getMediaType === 'function') {
                    mod.getMediaType = function () { return { any: true }; };
                }
            });
            console.log('[AdSkipper] Public Preroll methods patched.');
        } catch (e) {}
    }

    // ==========================================
    // 4. МЯГКИЙ DOM-СТРАЖ
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

                            try {
                                if (window.Lampa && window.Lampa.Controller) {
                                    var currentCtrl = window.Lampa.Controller.enabled();
                                    if (currentCtrl && typeof currentCtrl === 'object' && 
                                       (currentCtrl.name === 'ad_preroll' || currentCtrl.name === 'ad_video_block')) {
                                        window.Lampa.Controller.toggle('content');
                                    }
                                }
                            } catch (e) {}

                            setTimeout(function () {
                                if (node.parentNode) {
                                    if (!node.querySelector('.player') && !node.querySelector('#player')) {
                                        node.parentNode.removeChild(node);
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
    // 5. ИНИЦИАЛИЗАЦИЯ
    // ==========================================
    function initializeProtection() {
        patchAccount();
        patchPrerollMethodsIfExposed();
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
