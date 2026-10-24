(function () {
    'use strict';

    var PLUGIN_FLAG = 'plugin_ad_skipper_webos_v4';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    console.log('[AdSkipper] Initializing v4 (Safe Network 204 + Selective Video Killer)...');

    // --- 1. СЕТЕВАЯ БЛОКИРОВКА (Безопасный возврат 204 No Content) ---
    var AD_HOSTS = ['ad.cub.red', 'ads.cub.red', 'ad.cub.rip', 'ads.cub.rip'];
    
    function isAdUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return AD_HOSTS.some(function (host) { return url.indexOf(host) !== -1; });
    }

    // Перехват fetch (стандартный способ сказать "рекламы нет")
    var originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);
            if (isAdUrl(url)) {
                console.log('[AdSkipper] Blocked fetch (204):', url);
                // 204 No Content - идеальный ответ для VAST, означающий отсутствие рекламы
                return Promise.resolve(new Response(null, { 
                    status: 204, 
                    statusText: 'No Content'
                }));
            }
            return originalFetch.apply(this, arguments);
        };
    }

    // Перехват XMLHttpRequest (эмуляция 204 ответа)
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
                // Асинхронно эмулируем пустой успешный ответ
                setTimeout(function () {
                    try {
                        // В некоторых браузерах свойства readOnly, используем defineProperty
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

    // --- 2. ИЗБИРАТЕЛЬНЫЙ УБИЙЦА ФОНОВОЙ РЕКЛАМЫ ---
    function killAdVideo(node) {
        if (!node) return;
        
        var videos = node.tagName === 'VIDEO' ? [node] : node.querySelectorAll('video');
        
        videos.forEach(function (video) {
            // ВАЖНО: Не трогаем основной плеер Lampa!
            // Если видео находится внутри контейнера плеера, пропускаем его.
            if (video.closest('.player') || video.closest('.video-player') || video.id === 'player') {
                return;
            }

            try {
                video.pause();
                video.muted = true;
                video.removeAttribute('src');
                video.load(); // Прерывает фоновую загрузку
                console.log('[AdSkipper] Killed background ad video.');
            } catch(e) {}
        });
    }

    function setupDomGuard() {
        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1 && node.classList) {
                        // Список классов рекламных блоков
                        if (node.classList.contains('ad-preroll') ||
                            node.classList.contains('ad-video-block') ||
                            node.classList.contains('ad-countdown') ||
                            node.classList.contains('ad-server') ||
                            node.classList.contains('ad-bot') ||
                            node.classList.contains('vast-block')) {
                            
                            // 1. Сразу убиваем видео внутри, чтобы остановить звук/трафик
                            killAdVideo(node);
                            
                            // 2. Тихо удаляем контейнер с задержкой (300мс), 
                            // чтобы плеер успел корректно завершить переход
                            setTimeout(function () {
                                if (node.parentNode) {
                                    killAdVideo(node); // Повторная страховка
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
    setupDomGuard();

    if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') {
                console.log('[AdSkipper] Lampa App is ready. Protection active.');
            }
        });
    }
})();
