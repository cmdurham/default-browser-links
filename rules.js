// Link-routing rules shared by the content script, the service worker and the
// tests. Plain script (no modules) so it loads in all three places.
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    // 'apps': only links from installed web apps (PWA windows).
    // 'all': links from every window.
    scope: 'apps',
    // Leave sign-in popups (window.open with a size) in the browser so
    // flows that need window.opener keep working.
    includePopups: false,
    // Sites that always stay in the browser: a host matches itself and its subdomains.
    keepInApp: [
      'accounts.google.com',
      'accounts.youtube.com',
      'login.microsoftonline.com',
      'login.live.com',
      'appleid.apple.com',
      'okta.com',
      'auth0.com',
      'onelogin.com',
    ],
  });

  function parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  }

  function isWeb(url) {
    return !!url && (url.protocol === 'http:' || url.protocol === 'https:');
  }

  // Accepts "example.com", "*.example.com", ".example.com" or a pasted URL.
  function normalizeHost(pattern) {
    let p = String(pattern || '').trim().toLowerCase();
    if (!p) return '';
    if (p.includes('://')) p = parse(p)?.hostname || '';
    return p.replace(/^\*\./, '').replace(/^\.+/, '').replace(/[/:].*$/, '');
  }

  function hostMatches(host, pattern) {
    const p = normalizeHost(pattern);
    if (!p) return false;
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    return host === p || host.endsWith('.' + p);
  }

  function isKept(url, keepInApp) {
    const u = typeof url === 'string' ? parse(url) : url;
    return !!u && (keepInApp || []).some((p) => hostMatches(u.hostname, p));
  }

  // Should a link from the page at pageUrl to href go to the default browser?
  // inApp: the page is in an installed web app's window.
  // leftApp: Chromium already moved the link out of the app into a browser
  // tab, i.e. it's outside the app's scope even if it's on the same site.
  // Same question, with the reason (shown in the popup's activity log).
  function decide({ href, pageUrl, inApp, leftApp = false, settings }) {
    const s = { ...DEFAULTS, ...settings };
    const no = (reason) => ({ redirect: false, reason });
    if (!s.enabled) return no('paused');
    if (!inApp && s.scope !== 'all') return no('not-in-app');
    const target = parse(href, pageUrl);
    if (!isWeb(target)) return no('not-web');
    if (isKept(target, s.keepInApp)) return no('kept');
    if (inApp && leftApp) return { redirect: true, reason: 'left-app' };
    // Links within the same site are part of the app (or page) itself.
    const page = parse(pageUrl);
    if (isWeb(page) && page.origin === target.origin) return no('same-site');
    return { redirect: true, reason: 'other-site' };
  }

  function shouldRedirect(args) {
    return decide(args).redirect;
  }

  // Textarea contents -> clean, de-duplicated host list.
  function parseHostList(text) {
    const seen = new Set();
    for (const line of String(text || '').split(/[\s,]+/)) {
      const h = normalizeHost(line);
      if (h) seen.add(h);
    }
    return [...seen];
  }

  const api = { DEFAULTS, decide, shouldRedirect, hostMatches, isKept, normalizeHost, parseHostList };
  root.DefaultBrowserRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
