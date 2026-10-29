// End-to-end: loads the extension into Playwright's Chromium with the real
// helper registered in dry-run mode (it logs URLs instead of opening them),
// clicks links on test pages and checks what reached the helper.
//   npm run test:e2e
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const HELPER = process.env.DBL_HELPER || path.join(REPO, 'test', '.build', 'helper');
const HOST_NAME = 'com.cmdurham.default_browser_links';

// Same derivation as install-helper.sh.
const EXT_ID = [...createHash('sha256').update(REPO).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-e2e-'));
const userDataDir = path.join(tmp, 'profile');
const LOG = path.join(tmp, 'opened.txt');
const hostManifest = path.join(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`);

let server, port, context, worker;
const url = (host, p = '/') => `http://${host}.test:${port}${p}`;
const target = (from) => url('other', `/target?from=${from}`);

const PAGE = () => `<!doctype html><meta charset=utf-8><title>app</title>
<a id=ext href="${target('ext')}">ext</a>
<a id=same href="/same">same</a>
<a id=blank target=_blank href="${target('blank')}">blank</a>
<a id=sameblank target=_blank href="/sameblank?from=sameblank">sameblank</a>
<a id=kept href="${url('kept', '/target?from=kept')}">kept</a>
<a id=dl download href="${target('dl')}">dl</a>
<a id=mail href="mailto:x@example.com">mail</a>
<span id=shadowhost></span>
<svg width=60 height=20><a id=svg href="${target('svg')}"><text x=0 y=15>svg</text></a></svg>
<a id=apphandler href="${target('apphandler')}">apphandler</a>
<button id=open onclick="window.open('${target('open')}')">open</button>
<button id=later onclick="const w = window.open(); setTimeout(() => { w.location = '${target('later')}'; }, 100)">later</button>
<button id=popup onclick="window.open('${target('popup')}', 'p', 'width=400,height=400')">popup</button>
<iframe id=frame src="${url('third', '/frame')}" width=200 height=40></iframe>
<script>
  window.appHandlerRan = 0;
  // Like Slack and friends: the app opens links itself.
  document.getElementById('apphandler').addEventListener('click', (e) => {
    e.preventDefault(); window.appHandlerRan++; window.open(e.currentTarget.href);
  });
  const root = document.getElementById('shadowhost').attachShadow({ mode: 'closed' });
  root.innerHTML = '<a id=shadow href="${target('shadow')}">shadow</a>';
  window.shadowLink = root.getElementById('shadow');
</script>`;

const FRAME = () => `<!doctype html><a id=f href="${url('fourth', '/target?from=iframe')}">iframe link</a>`;

function opened() {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function expectOpened(from) {
  const ok = await waitFor(() => opened().includes(target(from)) || opened().some((u) => u.includes(`from=${from}`)));
  assert.ok(ok, `expected ${from} to reach the helper; got ${JSON.stringify(opened())}`);
}

async function expectNotOpened(from) {
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!opened().some((u) => u.includes(`from=${from}`)), `${from} should not reach the helper`);
}

async function setSettings(settings) {
  await worker.evaluate(async (s) => {
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set(s);
  }, settings);
}

async function freshPage() {
  for (const p of context.pages().slice(1)) await p.close();
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url('app'));
  // Give the content script a moment to read settings and status.
  await page.waitForTimeout(150);
  return page;
}

function writeHostManifest() {
  fs.mkdirSync(path.dirname(hostManifest), { recursive: true });
  fs.writeFileSync(hostManifest, JSON.stringify({
    name: HOST_NAME, description: 'test', path: HELPER, type: 'stdio',
    allowed_origins: [`chrome-extension://${EXT_ID}/`],
  }));
}

before(async () => {
  assert.ok(fs.existsSync(HELPER), `build the helper first: npm run build:helper`);
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const host = (req.headers.host || '').split('.')[0];
    if (req.url === '/' && host === 'app') return res.end(PAGE());
    if (req.url === '/frame') return res.end(FRAME());
    res.end(`<!doctype html><title>${host}${req.url}</title>${host}${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  writeHostManifest();
  await launch();
});

async function launch(extraArgs = []) {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // new headless mode, which runs extensions
    headless: !process.env.HEADED,
    env: { ...process.env, DBL_DRY_RUN: LOG },
    args: [
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1',
      ...extraArgs,
    ],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
}

after(async () => {
  await context?.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => fs.rmSync(LOG, { force: true }));

test('the unpacked extension id matches the installer’s derivation', () => {
  assert.equal(new URL(worker.url()).host, EXT_ID);
});

test('the service worker sees the helper', async () => {
  const status = await worker.evaluate(() => refreshStatus());
  assert.equal(status.state, 'ok', JSON.stringify(status));
  assert.ok(status.defaultBrowser?.name);
});

test('scope "all": external links go out and the page stays put', async () => {
  await setSettings({ scope: 'all' });
  const page = await freshPage();
  await page.click('#ext');
  await expectOpened('ext');
  assert.equal(page.url(), url('app'));
});

test('scope "all": same-site, kept, download and mailto links behave normally', async () => {
  await setSettings({ scope: 'all', keepInApp: ['kept.test'] });
  let page = await freshPage();
  await Promise.all([page.waitForURL(url('app', '/same')), page.click('#same')]);

  page = await freshPage();
  await Promise.all([page.waitForURL(/kept\.test/), page.click('#kept')]);
  await expectNotOpened('kept');

  page = await freshPage();
  await page.click('#dl').catch(() => {});
  await expectNotOpened('dl');
  assert.equal(opened().length, 0);
});

test('scope "all": target=_blank, ⌘-click and middle-click go out without a new tab', async () => {
  await setSettings({ scope: 'all' });
  const page = await freshPage();
  await page.click('#blank');
  await expectOpened('blank');
  await page.click('#ext', { modifiers: ['Meta'] });
  await page.click('#ext', { button: 'middle' });
  await waitFor(() => opened().filter((u) => u === target('ext')).length === 2);
  assert.equal(opened().filter((u) => u === target('ext')).length, 2);
  await page.waitForTimeout(300);
  assert.equal(context.pages().length, 1, 'no extra tabs');
});

test('scope "all": links in shadow DOM, SVG and iframes', async () => {
  await setSettings({ scope: 'all' });
  const page = await freshPage();
  await page.evaluate(() => window.shadowLink.click());
  // element.click() is untrusted, so it must NOT be intercepted…
  await expectNotOpened('shadow');
  // …but a real click is.
  const page2 = await freshPage();
  const box = await page2.evaluate(() => {
    const r = window.shadowLink.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page2.mouse.click(box.x, box.y);
  await expectOpened('shadow');

  await page2.click('#svg text');
  await expectOpened('svg');

  await page2.frameLocator('#frame').locator('#f').click();
  await expectOpened('iframe');
  assert.equal(page2.url(), url('app'));
});

test('scope "all": an app’s own click handler doesn’t open the link a second time', async () => {
  await setSettings({ scope: 'all' });
  const page = await freshPage();
  await page.click('#apphandler');
  await expectOpened('apphandler');
  await page.waitForTimeout(500);
  assert.equal(opened().filter((u) => u.includes('apphandler')).length, 1);
  assert.equal(await page.evaluate(() => window.appHandlerRan), 0);
});

test('scope "all": window.open tabs are sent out and closed', async () => {
  await setSettings({ scope: 'all' });
  const page = await freshPage();
  await page.click('#open');
  await expectOpened('open');
  await page.click('#later');
  await expectOpened('later');
  assert.ok(await waitFor(() => context.pages().length === 1), 'opened tabs are closed');
});

test('sign-in popups stay unless includePopups is on', async () => {
  await setSettings({ scope: 'all' });
  let page = await freshPage();
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#popup')]);
  await expectNotOpened('popup');
  assert.ok(!popup.isClosed());

  await setSettings({ scope: 'all', includePopups: true });
  page = await freshPage();
  await page.click('#popup');
  await expectOpened('popup');
});

test('scope "apps": normal tabs are left alone', async () => {
  await setSettings({ scope: 'apps' });
  const page = await freshPage();
  await Promise.all([page.waitForURL(/other\.test/), page.click('#ext')]);
  await expectNotOpened('ext');
  const [tab] = await Promise.all([context.waitForEvent('page'), (await freshPage()).click('#open')]);
  await expectNotOpened('open');
  assert.ok(!tab.isClosed());
});

test('paused: nothing is sent', async () => {
  await setSettings({ scope: 'all', enabled: false });
  const page = await freshPage();
  await Promise.all([page.waitForURL(/other\.test/), page.click('#ext')]);
  await expectNotOpened('ext');
});

test('without the helper, links work as usual', async () => {
  await setSettings({ scope: 'all' });
  fs.rmSync(hostManifest);
  try {
    const status = await worker.evaluate(() => refreshStatus());
    assert.equal(status.state, 'missing', JSON.stringify(status));
    const page = await freshPage();
    await Promise.all([page.waitForURL(/other\.test/), page.click('#ext')]);
  } finally {
    writeHostManifest();
    await worker.evaluate(() => refreshStatus());
  }
});

test('popup page shows the default browser', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await page.locator('#status.ok').waitFor(); // (waitForFunction needs eval, which extension CSP blocks)
  const text = await page.textContent('#status');
  assert.match(text, /^Opening links in .+/);
  assert.equal(await page.isHidden('#setup'), true);

  // Editing the kept-sites list saves a cleaned-up version.
  await page.fill('#keepInApp', 'https://Example.com/x\n*.foo.org\nexample.com');
  await page.locator('#keepInApp').blur();
  await page.waitForTimeout(200);
  const saved = await worker.evaluate(() => chrome.storage.sync.get('keepInApp'));
  assert.deepEqual(saved.keepInApp, ['example.com', 'foo.org']);
  await page.close();
});

// ---------------------------------------------------------------------------
// Installed web apps. `--app=<url>` opens the same kind of window a PWA gets
// (chrome.windows type "app", display-mode: standalone). Default settings.

test('app window: relaunch with the page as an app', async () => {
  await context.close();
  await launch([`--app=${url('app')}`]);
  await setSettings({});
  const windows = await worker.evaluate(async () =>
    (await chrome.windows.getAll({ populate: true })).map((w) => ({ type: w.type, url: w.tabs[0]?.url })));
  assert.deepEqual(windows.map((w) => w.type), ['app']);
  const page = context.pages()[0];
  assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), true);
});

test('app window: links leaving the app go out; the app stays put', async () => {
  const page = await freshPage();
  await page.click('#ext');
  await expectOpened('ext');
  await page.click('#blank');
  await expectOpened('blank');
  await page.click('#apphandler');
  await expectOpened('apphandler');
  await page.waitForTimeout(300);
  assert.equal(page.url(), url('app'));
  assert.equal(context.pages().length, 1, 'no extra tabs or windows');
});

test('app window: window.open from the app goes out and the stray tab closes', async () => {
  const page = await freshPage();
  await page.click('#open');
  await expectOpened('open');
  await page.click('#later');
  await expectOpened('later');
  assert.ok(await waitFor(() => context.pages().length === 1), 'stray tabs are closed');
  const types = await worker.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.type));
  assert.deepEqual(types, ['app'], 'no leftover browser windows');
});

test('app window: in-app and kept links stay in the app', async () => {
  await setSettings({ keepInApp: ['kept.test'] });
  let page = await freshPage();
  await Promise.all([page.waitForURL(url('app', '/same')), page.click('#same')]);
  page = await freshPage();
  await Promise.all([page.waitForURL(/kept\.test/), page.click('#kept')]);
  await expectNotOpened('kept');
});

test('app window: same-site links Chromium moves to a browser tab go out', async () => {
  await setSettings({});
  const page = await freshPage();
  await page.click('#sameblank');
  const ok = await waitFor(() => opened().some((u) => u.endsWith('/sameblank?from=sameblank')));
  assert.ok(ok, `got ${JSON.stringify(opened())}`);
  assert.ok(await waitFor(() => context.pages().length === 1), 'stray tab closed');
});

test('normal window, scope "all": same-site target=_blank stays', async () => {
  await context.close();
  await launch();
  await setSettings({ scope: 'all' });
  const page = await freshPage();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.click('#sameblank')]);
  await expectNotOpened('sameblank');
  assert.ok(!tab.isClosed());
});
