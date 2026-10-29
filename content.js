// Catches link clicks before the page (or Chromium) acts on them and sends
// links that leave the app to the default browser instead.
(() => {
  const { DEFAULTS, shouldRedirect } = globalThis.DefaultBrowserRules;

  let settings = DEFAULTS;
  let helperReady = false; // the native helper is installed and the default browser isn't this one
  let inAppWindow = false; // the service worker's view: this tab is in an app (PWA) window

  // Installed web apps report one of these display modes. ('fullscreen' is
  // left out: a normal browser window in full screen matches it too.)
  const appModes = ['standalone', 'minimal-ui', 'window-controls-overlay', 'tabbed']
    .map((mode) => matchMedia(`(display-mode: ${mode})`));
  const inApp = () => inAppWindow || appModes.some((q) => q.matches);

  chrome.storage.sync.get(DEFAULTS).then((s) => { settings = s; }).catch(() => {});
  chrome.storage.local.get('status').then(({ status }) => { helperReady = status?.state === 'ok'; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      const next = { ...settings };
      for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue ?? DEFAULTS[key];
      settings = next;
    } else if (area === 'local' && changes.status) {
      helperReady = changes.status.newValue?.state === 'ok';
    }
  });

  chrome.runtime.sendMessage({ type: 'where' })
    .then((reply) => { if (reply) inAppWindow = !!reply.inApp; })
    .catch(() => {});
  // The tab moved between a browser window and an app window ("Open in Chrome").
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'where') inAppWindow = !!msg.inApp;
  });

  const isLink = (el) => el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement || el instanceof SVGAElement;

  function linkFrom(event) {
    const path = event.composedPath();
    for (const el of path) {
      if (isLink(el)) return el.href ? el : null;
    }
    return path[0] instanceof Element ? linkInClosedShadow(path[0], event) : null;
  }

  // composedPath() stops at a closed shadow root's host. Content scripts may
  // look inside: find what was clicked (or, for Enter, what has focus).
  function linkInClosedShadow(host, event) {
    for (let el = host, depth = 0; el && depth < 8; depth++) {
      const root = chrome.dom?.openOrClosedShadowRoot?.(el);
      if (!root) return null;
      const inner = event.detail === 0 ? root.activeElement : root.elementFromPoint(event.clientX, event.clientY);
      const link = inner?.closest?.('a, area');
      if (link && isLink(link)) return link.href ? link : null;
      el = inner; // may itself host a nested shadow root
    }
    return null;
  }

  function hrefOf(link) {
    if (link instanceof SVGAElement) {
      const raw = link.href.animVal || link.getAttribute('href') || link.getAttribute('xlink:href');
      try { return new URL(raw, document.baseURI).href; } catch { return null; }
    }
    return link.href;
  }

  function onClick(event) {
    // Left click (plain or with ⌘/⇧) and middle click; right click opens the menu.
    if (event.button !== 0 && event.button !== 1) return;
    if (!event.isTrusted || !helperReady || !settings.enabled) return;
    // Extension was reloaded or removed since this page loaded.
    if (!chrome.runtime?.id) return;

    const link = linkFrom(event);
    if (!link || link.hasAttribute('download')) return;
    const href = hrefOf(link);
    if (!href || !shouldRedirect({ href, pageUrl: location.href, inApp: inApp(), settings })) return;

    // Stop the page too: many web apps open links from their own click
    // handlers with window.open, which would open the link a second time.
    event.preventDefault();
    event.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'open', url: href }).catch(() => {});
  }

  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
})();
