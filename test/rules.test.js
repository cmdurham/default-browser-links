// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, decide, shouldRedirect, hostMatches, isKept, normalizeHost, parseHostList } = require('../rules.js');

const app = (href, pageUrl = 'https://app.slack.com/client/T1', settings = {}) =>
  shouldRedirect({ href, pageUrl, inApp: true, settings });
const tab = (href, pageUrl = 'https://news.example.com/', settings = {}) =>
  shouldRedirect({ href, pageUrl, inApp: false, settings });

test('links leaving a web app go out', () => {
  assert.equal(app('https://github.com/anthropics'), true);
  assert.equal(app('http://example.com/x'), true);
  // A different subdomain is a different site.
  assert.equal(app('https://files.slack.com/x'), true);
});

test('links within the app stay', () => {
  assert.equal(app('https://app.slack.com/client/T2'), false);
  assert.equal(app('/client/T3'), false);
  assert.equal(app('#thread'), false);
  assert.equal(app('?q=1'), false);
});

test('non-web links stay', () => {
  for (const href of ['mailto:a@b.c', 'tel:123', 'javascript:void(0)', 'blob:https://app.slack.com/1',
    'chrome://settings', 'slack://open', 'data:text/html,hi', 'about:blank', 'file:///etc/hosts']) {
    assert.equal(app(href), false, href);
  }
});

test('garbage hrefs stay', () => {
  assert.equal(app('http://'), false);
  assert.equal(shouldRedirect({ href: 'not a url', pageUrl: 'also not', inApp: true, settings: {} }), false);
});

test('scope: normal tabs only when scope is "all"', () => {
  assert.equal(tab('https://github.com/'), false);
  assert.equal(tab('https://github.com/', undefined, { scope: 'all' }), true);
  assert.equal(tab('https://news.example.com/2', undefined, { scope: 'all' }), false);
});

test('disabled sends nothing', () => {
  assert.equal(app('https://github.com/', undefined, { enabled: false }), false);
  assert.equal(tab('https://github.com/', undefined, { enabled: false, scope: 'all' }), false);
});

test('kept sites stay, including subdomains', () => {
  assert.equal(app('https://accounts.google.com/o/oauth2/auth'), false);
  assert.equal(app('https://mycorp.okta.com/login'), false);
  assert.equal(app('https://notokta.com/'), true);
  assert.equal(app('https://github.com/', undefined, { keepInApp: ['github.com'] }), false);
  assert.equal(app('https://gist.github.com/', undefined, { keepInApp: ['*.github.com'] }), false);
  // Overriding the list replaces the defaults.
  assert.equal(app('https://accounts.google.com/', undefined, { keepInApp: [] }), true);
});

test('leftApp: same-site links Chromium moved out of the app go out', () => {
  const r = (opts) => shouldRedirect({ href: 'https://app.slack.com/blog', pageUrl: 'https://app.slack.com/client', settings: {}, ...opts });
  assert.equal(r({ inApp: true }), false);
  assert.equal(r({ inApp: true, leftApp: true }), true);
  // Only meaningful for app windows; kept sites still win.
  assert.equal(r({ inApp: false, leftApp: true, settings: { scope: 'all' } }), false);
  assert.equal(r({ inApp: true, leftApp: true, settings: { keepInApp: ['slack.com'] } }), false);
  assert.equal(shouldRedirect({ href: 'mailto:x@y.z', pageUrl: 'https://a.com/', inApp: true, leftApp: true, settings: {} }), false);
});

test('decide explains itself', () => {
  const d = (href, opts = {}) => decide({ href, pageUrl: 'https://app.slack.com/', inApp: true, settings: {}, ...opts }).reason;
  assert.equal(d('https://github.com/'), 'other-site');
  assert.equal(d('https://app.slack.com/x'), 'same-site');
  assert.equal(d('https://app.slack.com/x', { leftApp: true }), 'left-app');
  assert.equal(d('https://accounts.google.com/'), 'kept');
  assert.equal(d('mailto:a@b.c'), 'not-web');
  assert.equal(d('https://github.com/', { inApp: false }), 'not-in-app');
  assert.equal(d('https://github.com/', { settings: { enabled: false } }), 'paused');
  assert.deepEqual(decide({ href: 'https://github.com/', pageUrl: 'https://a.com/', inApp: true, settings: {} }),
    { redirect: true, reason: 'other-site' });
});

test('from a non-web page (e.g. about:blank) any web link goes out', () => {
  assert.equal(app('https://github.com/', 'about:blank'), true);
});

test('hostMatches', () => {
  assert.equal(hostMatches('a.b.com', 'b.com'), true);
  assert.equal(hostMatches('b.com', 'b.com'), true);
  assert.equal(hostMatches('B.COM.', 'b.com'), true);
  assert.equal(hostMatches('ab.com', 'b.com'), false);
  assert.equal(hostMatches('b.com', ''), false);
  assert.equal(hostMatches('b.com', '   '), false);
});

test('normalizeHost accepts wildcards, dots and pasted URLs', () => {
  assert.equal(normalizeHost('*.Example.com'), 'example.com');
  assert.equal(normalizeHost('.example.com'), 'example.com');
  assert.equal(normalizeHost('https://login.example.com/path?x=1'), 'login.example.com');
  assert.equal(normalizeHost('example.com/path'), 'example.com');
  assert.equal(normalizeHost('example.com:8080'), 'example.com');
  assert.equal(normalizeHost(''), '');
});

test('parseHostList cleans and de-duplicates', () => {
  assert.deepEqual(parseHostList('a.com\n\n  *.b.com \nA.com, https://c.com/x'), ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(parseHostList(''), []);
});

test('isKept accepts strings and URL objects', () => {
  assert.equal(isKept('https://login.live.com/', DEFAULTS.keepInApp), true);
  assert.equal(isKept(new URL('https://example.com/'), DEFAULTS.keepInApp), false);
  assert.equal(isKept('nope', DEFAULTS.keepInApp), false);
});

test('defaults are frozen so callers can’t mutate them', () => {
  assert.throws(() => { 'use strict'; DEFAULTS.enabled = false; });
});
