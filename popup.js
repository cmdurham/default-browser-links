const { DEFAULTS, parseHostList } = globalThis.DefaultBrowserRules;
const $ = (id) => document.getElementById(id);

// Extensions can't see where their folder is, so the commands assume you're in it.
const INSTALL = `./install-helper.sh ${chrome.runtime.id}`;
const IN_FOLDER = 'In Terminal, cd to the extension’s folder and run:';

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = s.enabled;
  document.querySelector(`input[name="scope"][value="${s.scope}"]`).checked = true;
  $('includePopups').checked = s.includePopups;
  $('keepInApp').value = s.keepInApp.join('\n');
  $('ext-id').textContent = chrome.runtime.id;
  showStatus(await chrome.runtime.sendMessage({ type: 'status', refresh: true }));
}

function showStatus(status) {
  const el = $('status');
  const setup = $('setup');
  const enabled = $('enabled').checked;
  setup.hidden = true;
  el.className = 'status';

  switch (status?.state) {
    case 'ok':
      el.textContent = enabled
        ? `Opening links in ${status.defaultBrowser?.name || 'your default browser'}`
        : 'Paused';
      if (enabled) el.classList.add('ok');
      return;
    case 'default-is-host':
      el.textContent = `${status.host?.name || 'This browser'} is your default browser`;
      el.classList.add('warn');
      showSetup(
        'Links would just come back here. Choose another default browser in System Settings → Desktop & Dock → Default web browser.',
        'open "x-apple.systempreferences:com.apple.Desktop-Settings.extension"',
      );
      return;
    case 'missing':
      el.textContent = 'Helper not installed';
      el.classList.add('warn');
      showSetup(`Extensions can’t open other apps by themselves, so a small helper does it. ${IN_FOLDER}`, INSTALL);
      return;
    default:
      el.textContent = 'Helper not working';
      el.classList.add('warn');
      showSetup(`The helper replied: ${status?.message || 'nothing'}. Run ./doctor.sh for details, or reinstall it. ${IN_FOLDER}`, INSTALL);
  }
}

function showSetup(text, cmd) {
  $('setup-text').textContent = text;
  $('setup-cmd').textContent = cmd;
  $('setup').hidden = false;
}

$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  showStatus(await chrome.runtime.sendMessage({ type: 'status' }));
});

for (const radio of document.querySelectorAll('input[name="scope"]')) {
  radio.addEventListener('change', (e) => chrome.storage.sync.set({ scope: e.target.value }));
}

$('includePopups').addEventListener('change', (e) => chrome.storage.sync.set({ includePopups: e.target.checked }));

let saveTimer;
$('keepInApp').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set({ keepInApp: parseHostList($('keepInApp').value) }), 300);
});
// Show the cleaned-up list once editing is done.
$('keepInApp').addEventListener('blur', async () => {
  clearTimeout(saveTimer);
  const keepInApp = parseHostList($('keepInApp').value);
  await chrome.storage.sync.set({ keepInApp });
  $('keepInApp').value = keepInApp.join('\n');
});

$('reset-sites').addEventListener('click', async () => {
  await chrome.storage.sync.set({ keepInApp: [...DEFAULTS.keepInApp] });
  $('keepInApp').value = DEFAULTS.keepInApp.join('\n');
});

$('copy-cmd').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('setup-cmd').textContent);
  $('copy-cmd').textContent = 'Copied';
  setTimeout(() => { $('copy-cmd').textContent = 'Copy command'; }, 1500);
});

$('recheck').addEventListener('click', async () => {
  $('status').textContent = 'Checking the helper…';
  showStatus(await chrome.runtime.sendMessage({ type: 'status', refresh: true }));
});

// ---------------------------------------------------------------------------
// Activity

const REASONS = {
  'other-site': 'another site',
  'left-app': 'left the app',
  'same-site': 'same site',
  'kept': 'on the keep list',
  'not-web': 'not a web link',
  'not-in-app': 'not in an app window',
  'paused': 'paused',
  'download': 'download link',
  'popup': 'sign-in popup',
  'helper-not-ready': 'helper not ready',
};

function describe(e) {
  const reason = REASONS[e.reason] || e.reason || '';
  switch (e.kind) {
    case 'watching':
      return { cls: '', title: 'Watching links', note: `app window (${e.detail || 'app'})` };
    case 'status':
      return { cls: e.outcome === 'ok' ? 'sent' : 'bad', title: `Helper: ${e.outcome}`, note: e.detail };
    default: {
      const source = { click: 'Click', 'new-tab': 'New tab', menu: 'Menu', shortcut: 'Shortcut' }[e.kind] || e.kind;
      if (e.outcome === 'sent') return { cls: 'sent', title: `${source} → default browser`, note: reason };
      if (e.outcome === 'failed') return { cls: 'failed', title: `${source} → helper failed`, note: e.detail };
      return { cls: '', title: `${source} → kept here`, note: reason };
    }
  }
}

function renderActivity(activity = []) {
  const list = $('activity');
  list.replaceChildren();
  if (!activity.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Click a link in an installed web app.';
    list.append(li);
    return;
  }
  for (const e of activity) {
    const { cls, title, note } = describe(e);
    const li = document.createElement('li');
    li.className = cls;
    const what = document.createElement('div');
    what.className = 'what';
    const b = document.createElement('b');
    b.textContent = title;
    const small = document.createElement('span');
    small.textContent = small.title = [note, e.inFrame ? 'in a frame' : ''].filter(Boolean).join(' · ');
    const time = document.createElement('time');
    time.textContent = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    what.append(b, small, time);
    li.append(what);
    if (e.url) {
      const url = document.createElement('div');
      url.className = 'url';
      url.textContent = url.title = e.url;
      li.append(url);
    }
    list.append(li);
  }
}

chrome.storage.session.get('activity').then(({ activity }) => renderActivity(activity));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.activity) renderActivity(changes.activity.newValue);
});

$('clear-log').addEventListener('click', () => chrome.storage.session.set({ activity: [] }));

// Everything needed to tell why links aren't going out, as text to paste somewhere.
$('copy-diag').addEventListener('click', async () => {
  const [settings, { status }, { activity = [] }] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get('status'), chrome.storage.session.get('activity'),
  ]);
  const report = {
    extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version },
    browser: navigator.userAgent,
    status, settings,
    activity: activity.map((e) => ({ ...e, t: new Date(e.t).toISOString() })),
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  $('copy-diag').textContent = 'Copied';
  setTimeout(() => { $('copy-diag').textContent = 'Copy diagnostics'; }, 1500);
});

load();
