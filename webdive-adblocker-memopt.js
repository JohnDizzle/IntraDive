// WebDive AdBlocker - Memory Optimized Version
// Author: John M. Doyle
// Date: 2025-05-01

if (!window.WebDiveAdBlockerInitialized) {
    window.WebDiveAdBlockerInitialized = true;

    window.WebDiveAdBlocker = (() => {

        const DEBUG = true;
        const HOSTNAME = location.hostname;
        const STORAGE_PREFIX = 'WebDive_';
        const EASYLIST_KEY = `${STORAGE_PREFIX}EasyList`;
        const SIGNATURES_KEY = `${STORAGE_PREFIX}RemovedSigs_${HOSTNAME}`;
        const EASYLIST_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
        const LAST_SANITIZED_KEY = `${STORAGE_PREFIX}LastSanitized_${HOSTNAME}`;
        const memoryCache = {};
        const observers = new Set();
        const observedShadowRoots = new WeakSet();
        let interval = null;
        let isCleanedUp = false;
        let throttledScrollListener, debouncedCleanListener;

        const fallbackSelectors = [
            'iframe[id^="tm_ad_frame"]', 'iframe[id^="ad_"]', 'iframe[id^="google_ads"]', 'iframe[id^="google_ads_iframe"]',
            'div[id^="google_ads_iframe"]',
            'img[src^="https://res.public.onecdn.static.microsoft/assets/ads/"]',
            '[id^="owaadbar"]',
            'ins.adsbygoogle',
            '[data-google-query-id]',
            '.displayAdContainer',
            '.displayAdCard',
            '[id^="displayAdCard"]',
            '[id^="displayAdContainer"]',
            'cs-native-ad-card',
            'iframe[src*="googlesyndication.com"]', '[id*="advert"]', '[class*="advert"]', '[id*="sponsored"]', '[class*="sponsored"]',
            '[id$="nativead"]',
            '[id*="promo"]', '[class*="promo"]', '[id^="ad-"]', '[class^="ad-"]', '[id$="-ad"]', '[class$="-ad"]',
            '[data-ad]', '[data-ads]', '[data-ad-unit]', 'ins.adsbygoogle', 'iframe[src*="googlesyndication"]',
            'div[id*="taboola"]', '.trc_rbox_outer', 'div[data-widget*="outbrain"]', '.OUTBRAIN',
            '.advertisement-unit', '.ad-unit', '.ad-container', '.ad-slot', '.ad-banner', '.ad-label-text'
        ];

        // Logger with limited buffer
        const MAX_LOG_BUFFER = 100;
        const Logger = (() => {
            const logBuffer = [];
            const warnBuffer = [];
            const LOG_INTERVAL = 1000;
            let logIndex = 0, warnIndex = 0;
            const interval = setInterval(() => {
                logIndex = 0;
                if (logBuffer.length) {
                    console.log('[AdBlock_WebDive]');
                    logBuffer.splice(0).forEach(t => console.log(`${++logIndex}: ${t}\n`));
                }
                warnIndex = 0;
                if (warnBuffer.length) {
                    console.warn('[AdBlock_WebDive]');
                    warnBuffer.splice(0).forEach(t => console.warn(`${++warnIndex}: ${t}\n`));
                }
            }, LOG_INTERVAL);

            return {
                log: (...args) => {
                    if (DEBUG) {
                        while (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
                        logBuffer.push(...args);
                    }
                },
                warn: (...args) => {
                    if (DEBUG) {
                        while (warnBuffer.length > MAX_LOG_BUFFER) warnBuffer.shift();
                        warnBuffer.push(...args);
                    }
                },
                flush: () => {
                    clearInterval(interval);
                    logIndex = 0;
                    if (logBuffer.length) {
                        console.log('[AdBlock_WebDive]');
                        logBuffer.splice(0).forEach(t => console.log(`${++logIndex}: ${t}\n`));
                    }
                    warnIndex = 0;
                    if (warnBuffer.length) {
                        console.warn('[AdBlock_WebDive]');
                        warnBuffer.splice(0).forEach(t => console.warn(`${++warnIndex}: ${t}\n`));
                    }
                }
            };
        })();

        const safe = (fn, msg) => {
            try {
                return fn();
            } catch (e) {
                DEBUG && Logger.warn(msg, e);
                return null;
            }
        };

        const debounce = (fn, delay) => {
            let timer;
            return (...args) => {
                clearTimeout(timer);
                timer = setTimeout(() => fn(...args), delay);
            };
        };

        const throttle = (fn, limit) => {
            let lastCall = 0;
            return (...args) => {
                const now = Date.now();
                if (now - lastCall >= limit) {
                    lastCall = now;
                    fn(...args);
                }
            };
        };

        const getElementSignature = el => {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${CSS.escape(el.id)}` : '';
            const cls = [...el.classList].slice(0, 3).map(c => `.${CSS.escape(c)}`).join('');
            return `${tag}${id}${cls}`;
        };

        const removeElementAndAncestors = (el, depth = 5) => {
            if (!el || !(el instanceof Element)) return;
            let parent = el;
            for (let i = 0; i < depth && parent && parent !== document.body; i++) {
                const hasVisibleContent = [...parent.childNodes].some(n =>
                    n.nodeType === 1
                        ? getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden'
                        : n.nodeType === 3 && n.textContent.trim().length > 0
                );
                if (!hasVisibleContent && !parent.matches('main, section, article')) {
                    parent.remove();
                } else {
                    parent.style.pointerEvents = 'none';
                    parent.style.opacity = '0';
                    parent.style.visibility = 'hidden';
                    parent.style.height = '0';
                    parent.style.margin = '0';
                    parent.style.padding = '0';
                    parent.setAttribute('aria-hidden', 'true');
                    parent.setAttribute('inert', 'true');
                    break;
                }
                parent = parent.parentNode || (parent.getRootNode() instanceof ShadowRoot ? parent.getRootNode().host : null);
            }
        };

        const canUseLocalStorage = (() => {
            try {
                localStorage.setItem('__test', '1');
                localStorage.removeItem('__test');
                return true;
            } catch (e) {
                return false;
            }
        })();

        const loadJSON = key => {
            if (!canUseLocalStorage) return memoryCache[key] || null;
            try {
                return JSON.parse(localStorage.getItem(key));
            } catch (e) {
                DEBUG && Logger.warn(`localStorage load failed for ${key}:`, e);
                return memoryCache[key] || null;
            }
        };

        const saveJSON = (key, value) => {
            if (!canUseLocalStorage) {
                memoryCache[key] = value;
                return;
            }
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (e) {
                DEBUG && Logger.warn(`localStorage save failed for ${key}:`, e);
                memoryCache[key] = value;
            }
        };

        const loadEasyList = async url => {
            const cached = loadJSON(EASYLIST_KEY);
            const expiry = loadJSON(`${EASYLIST_KEY}_Expiry`);
            if (cached && expiry && Date.now() < expiry) return cached;
            try {
                const res = await fetch(url);
                const text = await res.text();
                const selectors = text.split('\n').map(s => s.trim())
                    .filter(s => s.startsWith("#") || s.startsWith(".")).filter(x => x.includes("ad")).map(s => s);
                saveJSON(EASYLIST_KEY, selectors);
                saveJSON(`${EASYLIST_KEY}_Expiry`, Date.now() + EASYLIST_TTL_MS);
                return selectors;
            } catch (e) {
                DEBUG && Logger.warn('Failed to fetch EasyList:', e);
                return [];
            }
        };

        const getEasyListSelectors = async () => {
            const url = 'https://raw.githubusercontent.com/JohnDizzle/IntraDive/main/easylist.txt';
            const easy = await loadEasyList(url);
            return [...easy, ...fallbackSelectors];
        };

        // Limit DOM query to first 50 elements per selector
        const cleanAds = (context, selectors) => {
            const removedSigs = new Set(loadJSON(SIGNATURES_KEY) || []);

            context.querySelectorAll('[ad], [aria-ad-label]').forEach(el => {
                const sig = getElementSignature(el);
                removeElementAndAncestors(el);
                removedSigs.add(sig);
            });

            const sanitizeSelector = (selector) => {
                try {
                    return CSS.escape(selector);
                } catch (e) {
                    return null;
                }
            };

            selectors.forEach(sel => {
                if (!sel) return;
                if (sanitizeSelector(sel)) {
                    safe(() => {
                        [...context.querySelectorAll(sel)].slice(0, 50).forEach(el => {
                            const sig = getElementSignature(el);
                            removeElementAndAncestors(el);
                            removedSigs.add(sig);
                        });
                    }, `selector error: ${sel}`);
                }
            });

            saveJSON(SIGNATURES_KEY, [...removedSigs]);
        };

        const sanitizeSignaturesKey = () => {
            const lastSanitized = loadJSON(LAST_SANITIZED_KEY);
            const today = new Date().toISOString().split('T')[0];
            if (lastSanitized !== today) {
                DEBUG && Logger.log('Sanitizing SIGNATURES_KEY for a new visit today.');
                localStorage.removeItem(SIGNATURES_KEY);
                saveJSON(LAST_SANITIZED_KEY, today);
            } else {
                DEBUG && Logger.log('SIGNATURES_KEY already sanitized today.');
            }
        };

        const fastCleanupFromCache = () => {
            const sigs = loadJSON(SIGNATURES_KEY);
            if (!sigs) return;
            sigs.forEach(sig => {
                try {
                    document.querySelectorAll(sig).forEach(el => removeElementAndAncestors(el));
                } catch { }
            });
            DEBUG && Logger.log(`Fast cleanup of ${sigs.length} items`);
        };

        const findAllShadowHosts = () => {
            const result = [];
            const recurse = node => {
                if (!node?.children) return;
                [...node.children].forEach(child => {
                    if (child.shadowRoot && !observedShadowRoots.has(child)) {
                        result.push(child);
                        observedShadowRoots.add(child);
                        recurse(child.shadowRoot);
                    }
                    recurse(child);
                });
            };
            recurse(document.body);
            return result;
        };

        const cleanShadowDOMs = selectors => {
            findAllShadowHosts().forEach(host => {
                const root = host.shadowRoot;
                if (root) cleanAds(root, selectors);
            });
        };

        // Single observer per root, reuse via property
        const observeShadowRoots = selectors => {
            findAllShadowHosts().forEach(host => {
                const root = host.shadowRoot;
                if (!root) return;
                if (!root._webDiveObserver) {
                    root._webDiveObserver = new MutationObserver(() => cleanAds(root, selectors));
                    root._webDiveObserver.observe(root, { childList: true, subtree: true });
                    observers.add(root._webDiveObserver);
                }
            });
        };

        const cleanupObservers = () => {
            observers.forEach(o => o.disconnect());
            observers.clear();
            // observedShadowRoots is a WeakSet, no need to clear
        };

        const run = async () => {
            if (isCleanedUp) return;

            const waitForBody = () => new Promise(resolve => {
                if (document.body) return resolve();
                const observer = new MutationObserver(() => {
                    if (document.body) {
                        observer.disconnect();
                        resolve();
                    }
                });
                observer.observe(document.documentElement, { childList: true });
            });

            await waitForBody();
            sanitizeSignaturesKey();
            fastCleanupFromCache();

            const selectors = await getEasyListSelectors();

            const firstRun = () => new Promise(resolve => {
                cleanAds(document, selectors);
                cleanShadowDOMs(selectors);
                DEBUG && Logger.log('Running initial page load scan with Easy List');
                return resolve();
            });

            await firstRun();

            debouncedCleanListener = debounce(() => {
                if (isCleanedUp) return;
                cleanupObservers();
                const removedSigs = new Set(loadJSON(SIGNATURES_KEY) || []);
                const dynamicSelectors = [...removedSigs, ...fallbackSelectors];
                cleanAds(document, dynamicSelectors);
                cleanShadowDOMs(dynamicSelectors);
                observeShadowRoots(dynamicSelectors);
            }, 400);

            throttledScrollListener = throttle(debouncedCleanListener, 200);

            const mo = new MutationObserver(debouncedCleanListener);
            mo.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'id', 'style']
            });
            observers.add(mo);

            interval = setInterval(() => {
                if (document.readyState === 'complete') debouncedCleanListener();
            }, 2000);

            window.addEventListener('scroll', throttledScrollListener, { passive: true });
            window.addEventListener('popstate', debouncedCleanListener);
            window.addEventListener('beforeunload', cleanup);

            debouncedCleanListener();
        };

        const cleanup = () => {
            isCleanedUp = true;
            cleanupObservers();
            if (interval) clearInterval(interval);
            if (throttledScrollListener) window.removeEventListener('scroll', throttledScrollListener, { passive: true });
            if (debouncedCleanListener) window.removeEventListener('popstate', debouncedCleanListener);
            window.removeEventListener('beforeunload', cleanup);
            Logger.warn('AdBlocker cleanup complete');
            Logger.flush();
        };

        return {
            run,
            cleanup
        };

    })();

    // Initialize when document is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.WebDiveAdBlocker.run());
    } else {
        window.WebDiveAdBlocker.run();
    }
}