// Sends links to the macOS default browser through the native helper.
//
// Two paths catch links:
//   1. content.js stops link clicks before the page or Chromium handles them.
//   2. New tabs and windows a page opens some other way (window.open, forms,
//      Chromium's own handling of out-of-scope links in web apps) are caught
//      here, sent out, and closed.
importScripts('rules.js');

const { DEFAULTS, decide } = globalThis.DefaultBrowserRules;
const HELPER = 'com.cmdurham.default_browser_links';
const PENDING_MS = 5000; // how long to wait for a blank new tab to get its real URL
const STATUS_ALARM = 'refresh-status';
const LOG_SIZE = 50;

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

async function isAppWindow(windowId) {
  const win = await chrome.windows.get(windowId).catch(() => null);
  return win?.type === 'app';
}

// ---------------------------------------------------------------------------
// Activity log, shown in the popup (session storage: cleared on browser quit)

let logWrite = Promise.resolve();

function log(entry) {
  logWrite = logWrite.then(async () => {
    const { activity = [] } = await chrome.storage.session.get('activity');
    activity.unshift({ t: Date.now(), ...entry });
    await chrome.storage.session.set({ activity: activity.slice(0, LOG_SIZE) });
  }).catch(() => {});
  return logWrite;
}

// ---------------------------------------------------------------------------
// The native helper

// status.state: 'ok' | 'missing' | 'default-is-host' | 'error'
async function refreshStatus() {
  let status;
  try {
    const reply = await chrome.runtime.sendNativeMessage(HELPER, { type: 'ping' });
    status = {
      state: reply?.defaultIsHost ? 'default-is-host' : reply?.ok ? 'ok' : 'error',
      defaultBrowser: reply?.defaultBrowser || null,
      host: reply?.host || null,
      version: reply?.version ?? null,
      message: reply?.ok ? '' : String(reply?.error || 'Unexpected reply from the helper'),
    };
  } catch (e) {
    const message = String(e?.message || e);
    // "Specified native messaging host not found." / "Access to the specified
    // native messaging host is forbidden." (manifest lists another extension id)
    status = { state: /not found|forbidden/i.test(message) ? 'missing' : 'error', message };
  }
  status.checkedAt = Date.now();
  const { status: previous } = await chrome.storage.local.get('status');
  if (previous?.state !== status.state) {
    log({ kind: 'status', outcome: status.state, detail: status.message || status.defaultBrowser?.name || '' });
  }
  await chrome.storage.local.set({ status });
  await updateBadge(status);
  return status;
}

async function getStatus() {
  const { status } = await chrome.storage.local.get('status');
  return status || refreshStatus();
}

async function updateBadge(status) {
  status ??= await getStatus();
  const { enabled } = await getSettings();
  let text = '';
  let title = 'Default Browser Links';
  if (!enabled) {
    text = 'OFF';
    title += ': paused';
  } else if (status.state !== 'ok') {
    text = '!';
    title += status.state === 'default-is-host'
      ? ': this browser is your default browser, so links have nowhere else to go'
      : ': the helper isn’t installed or isn’t working';
  } else if (status.defaultBrowser?.name) {
    title += `: opening links in ${status.defaultBrowser.name}`;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#dc2626' : '#71717a' });
  await chrome.action.setTitle({ title });
}

// Opens url in the default browser. If that fails and `fallback` is set,
// opens it in this browser instead so the click isn't lost.
async function openInDefault(url, { fallback = false, via = 'menu', reason = '' } = {}) {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(HELPER, { type: 'open', url });
  } catch (e) {
    reply = { ok: false, error: String(e?.message || e) };
  }
  log({ kind: via, url, outcome: reply?.ok ? 'sent' : 'failed', reason, detail: reply?.ok ? '' : String(reply?.error || '') });
  if (!reply?.ok) {
    refreshStatus();
    if (fallback) await openHere(url);
  }
  return !!reply?.ok;
}

async function openHere(url) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (win) await chrome.tabs.create({ url, windowId: win.id });
  else await chrome.windows.create({ url });
}

// ---------------------------------------------------------------------------
// Messages from content.js and the popup

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'open':
      if (!isWebUrl(msg.url)) return false;
      openInDefault(msg.url, { fallback: true, via: 'click', reason: msg.reason }).then((ok) => sendResponse({ ok }));
      return true;
    case 'log':
      if (msg.entry && typeof msg.entry === 'object') {
        log({ ...msg.entry, inFrame: sender.frameId > 0 });
      }
      return false;
    case 'where':
      if (!sender.tab) return false;
      isAppWindow(sender.tab.windowId).then((inApp) => sendResponse({ inApp }));
      return true;
    case 'status':
      (msg.refresh ? refreshStatus() : getStatus()).then(sendResponse);
      return true;
  }
  return false;
});

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  const inApp = await isAppWindow(newWindowId);
  chrome.tabs.sendMessage(tabId, { type: 'where', inApp }).catch(() => {});
});

// ---------------------------------------------------------------------------
// New tabs and windows opened by pages

// New tab id -> promise of its context, for a blank window.open() that the
// page points somewhere next. Stored synchronously so a quick navigation
// can't slip past while the context is still being looked up.
const pending = new Map();

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
  const ctx = contextFor(sourceTabId, tabId);
  if (isWebUrl(url)) {
    route(tabId, url, ctx);
  } else {
    pending.set(tabId, ctx);
    setTimeout(() => pending.delete(tabId), PENDING_MS);
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || !isWebUrl(url) || !pending.has(tabId)) return;
  const ctx = pending.get(tabId);
  pending.delete(tabId);
  route(tabId, url, ctx);
});

chrome.tabs.onRemoved.addListener((tabId) => pending.delete(tabId));

// Resolves to what route() needs, or null when the new tab should be left alone.
async function contextFor(sourceTabId, tabId) {
  const [settings, status] = await Promise.all([getSettings(), getStatus()]);
  const source = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (!source) return null;
  const inApp = await isAppWindow(source.windowId);
  // Like clicks, only new tabs from app windows are logged when left alone.
  const skip = (reason) => (inApp ? { skip: reason } : null);

  if (!settings.enabled) return skip('paused');
  if (status.state !== 'ok') return skip('helper-not-ready');
  if (!inApp && settings.scope !== 'all') return null;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const win = tab && await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.type === 'popup' && !settings.includePopups) return skip('popup');
  // In-scope links from a web app open in another app window; out-of-scope
  // ones land in a browser window.
  const leftApp = inApp && win?.type === 'normal';
  return { sourceUrl: source.url || source.pendingUrl, inApp, leftApp, settings };
}

async function route(tabId, url, ctxPromise) {
  const ctx = await ctxPromise;
  if (!ctx) return;
  if (ctx.skip) return log({ kind: 'new-tab', url, outcome: 'kept', reason: ctx.skip });
  const { redirect, reason } = decide({ href: url, pageUrl: ctx.sourceUrl, ...ctx });
  if (!redirect) {
    if (ctx.inApp) log({ kind: 'new-tab', url, outcome: 'kept', reason });
    return;
  }
  if (await openInDefault(url, { via: 'new-tab', reason })) await chrome.tabs.remove(tabId).catch(() => {});
}

// ---------------------------------------------------------------------------
// Menus, shortcut, lifecycle

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === 'open-link' ? info.linkUrl : info.pageUrl;
  if (isWebUrl(url)) openInDefault(url, { via: 'menu' });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-page') return;
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (isWebUrl(tab?.url)) openInDefault(tab.url, { via: 'shortcut' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STATUS_ALARM) refreshStatus();
});

async function setUp() {
  chrome.contextMenus.removeAll(() => {
    const web = ['http://*/*', 'https://*/*'];
    chrome.contextMenus.create({
      id: 'open-link', title: 'Open Link in Default Browser', contexts: ['link'], targetUrlPatterns: web,
    });
    chrome.contextMenus.create({
      id: 'open-page', title: 'Open Page in Default Browser', contexts: ['page'], documentUrlPatterns: web,
    });
  });
  // Picks up a newly installed helper or a change of default browser.
  chrome.alarms.create(STATUS_ALARM, { periodInMinutes: 5 });
  await refreshStatus();
}

chrome.runtime.onInstalled.addListener(setUp);
chrome.runtime.onStartup.addListener(setUp);
