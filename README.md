# Default Browser Links

Links you click in an installed web app (PWA) open in your Mac's **default
browser** instead of a Chromium tab. Optionally, links from every window do too.
Works in Chrome, Helium, Edge, Brave, Vivaldi, Arc and other Chromium browsers.

## Install

1. Open `chrome://extensions` (or `helium://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Install the helper. Extensions can't launch other apps, so a small native
   helper hands links to macOS:

   ```sh
   ./install-helper.sh
   ```

   This compiles `helper/default-browser-links-helper.swift` (needs Xcode's
   command line tools) into `~/Library/Application Support/DefaultBrowserLinks/`.
   It then registers the helper with every Chromium browser that has a profile
   on this Mac. If the extension's ID on the extensions page differs from the
   one the script prints, rerun with that ID: `./install-helper.sh <id>`.
   `./install-helper.sh --uninstall` removes everything.
4. Click the toolbar icon. It should say **Opening links in <your browser>**.

## Use

| | |
| --- | --- |
| Pause / resume | Toggle in the popup (the badge shows `OFF`) |
| Links from PWAs only, or from every window | Popup → **Send links from** |
| Keep a site in the app (e.g. a sign-in page) | Popup → **Keep these sites here**. Subdomains are included. |
| Send one link | Right-click → **Open Link in Default Browser** |
| Send the current page | `⌥⇧E`, or right-click → **Open Page in Default Browser** |

A red `!` badge means the helper isn't installed, or this browser *is* your
default browser (links would just come back). The popup says which, and how to fix it.

## Troubleshooting

Links still opening in the browser that runs your web apps? On that Mac, in this folder:

```sh
git pull            # get the latest version
./doctor.sh         # checks every link in the chain and says what to fix
./doctor.sh --fix   # also (re)installs the helper for the extension ids it finds
```

Then reload the extension on the extensions page.

The doctor checks:

- which app macOS opens web links with
- whether the helper is installed and responds (security software can block it)
- for each browser and profile: whether the extension is loaded and turned on,
  its site access, and whether the helper accepts its ID
- whether that browser is itself the default browser
- managed policies that block helpers or extensions

If everything checks out but links still don't go out, open the popup and watch
**Recent activity** while you click a link in the app:

| You see | Meaning |
| --- | --- |
| Nothing at all, not even **Watching links** | The extension isn't running in that app's page. Reload the app window. If it's still missing, check the extension's site access. |
| **Click → kept here** with a reason | That rule kept the link, e.g. *same site* or *on the keep list*. |
| **New tab → kept here** | The app opened the link itself in a new tab, and that rule kept it. |
| **… → helper failed** with an error | The helper couldn't open it, and the error says why. The link opens in this browser instead. |
| **… → default browser**, but it opened here anyway | The default browser is this browser, or something else reopened it. |

**Copy diagnostics** puts the status, settings and recent activity on the
clipboard as text.

## What goes out and what stays

Going to the default browser:

- Links to **another site** you click, whether plain, ⌘-, ⇧- or middle-clicked,
  `target=_blank`, inside iframes, SVG, or open and closed shadow DOM.
- New tabs a page opens itself (`window.open`, including the blank-then-redirect
  pattern), when they lead to another site. The stray tab is closed.
- Links in blank or `srcdoc` frames that pages fill in themselves (common in
  Google apps). These count as part of the page that created them.
- In PWAs, same-site links that Chromium itself moves out of the app into a
  browser tab (outside the app's scope).

Staying put:

- Links within the same site (in-app navigation).
- Sites on the keep list: Google, Microsoft, Apple, Okta, Auth0 and OneLogin
  sign-in pages by default.
- Sign-in **popups** (`window.open` with a size), because their opener
  relationship would break. You can turn this off.
- `mailto:`, `tel:`, `blob:`, custom app schemes, and links with `download`.
- Clicks a script fakes (`element.click()`) are left to the browser. Ones that
  open a new tab are still caught by the new-tab path, after Chromium's popup
  blocker has had its say.
- Pages that redirect themselves (`location.href = …`), such as OAuth flows.
  An extension can't tell those apart from sign-in redirects, so they're left alone.

## How it works

- `content.js` runs at `document_start` in every frame. It listens for clicks
  in the capture phase on `window`, so it sees them before the page's own
  handlers. For links that should go out, it cancels the click and stops it
  from propagating. That keeps apps like Slack from also calling `window.open`.
- A page is treated as in an installed app when its window is a Chromium `app`
  window (`chrome.windows`), or `display-mode` is `standalone`, `minimal-ui`,
  `window-controls-overlay` or `tabbed`. Moving a tab between an app and the
  browser ("Open in Chrome") updates this.
- `background.js` covers the rest with `webNavigation.onCreatedNavigationTarget`.
  It sends new tabs to the default browser and closes them. It also routes clicks
  to the helper, and if the helper fails it opens the link in a normal tab so it
  isn't lost.
- The helper is a native messaging host. It opens URLs with
  `NSWorkspace.open(_:withApplicationAt:)` using the system's default `https`
  handler. It refuses anything but `http(s)`, and refuses when the default
  browser is the browser that launched it, to prevent loops.

## Tests

```sh
npm install        # playwright-core, for the end-to-end tests
npm test           # rules + helper protocol (builds the helper)
npm run test:e2e   # loads the extension into Playwright's Chromium
```

The end-to-end suite loads the unpacked extension and registers the real
helper in dry-run mode (`DBL_DRY_RUN=<file>` logs URLs instead of opening
them). It clicks through test pages in normal windows and in a `--app=` window,
which is the same window type a PWA gets. It needs Playwright's Chromium build
(`npx playwright-core install chromium` if it isn't already cached).
Set `HEADED=1` to watch.
