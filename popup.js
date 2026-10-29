const { DEFAULTS, parseHostList } = globalThis.DefaultBrowserRules;
const $ = (id) => document.getElementById(id);

const INSTALL_DIR = '~/Dev/default-browser-links';

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
      showSetup(
        'Extensions can’t open other apps by themselves. Install the small helper by running this in Terminal:',
        `${INSTALL_DIR}/install-helper.sh ${chrome.runtime.id}`,
      );
      return;
    default:
      el.textContent = 'Helper not working';
      el.classList.add('warn');
      showSetup(`The helper replied: ${status?.message || 'nothing'}. Try reinstalling it:`,
        `${INSTALL_DIR}/install-helper.sh ${chrome.runtime.id}`);
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

load();
