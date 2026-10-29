#!/bin/zsh
# Checks every link in the chain Default Browser Links needs, on this Mac,
# and says what to fix. Read-only unless you pass --fix.
#
#   ./doctor.sh [--fix]
#
# --fix (re)installs the helper for the extension ids found in your browsers.
# Everything else it finds needs a click in the browser or System Settings,
# and the report says where.
set -u

NAME=com.cmdurham.default_browser_links
REPO=${0:A:h}
SUPPORT="$HOME/Library/Application Support"
BIN="$SUPPORT/DefaultBrowserLinks/default-browser-links-helper"
POLICY_DIR=${DBL_POLICY_DIR:-/Library/Managed Preferences}
source "$REPO/browsers.zsh"

FIX=0
[[ ${1:-} == --fix ]] && FIX=1
problems=0
fixable_ids=()

ok()   { print -P "  %F{green}✓%f $1"; }
info() { print -P "  %F{244}·%f $1"; }
bad()  { print -P "  %F{red}✗%f $1"; (( problems++ )); }
hint() { print -P "      %F{244}→%f $1"; }
head() { print; print -P "%B$1%b"; }

# JSON/plist reading and AppKit lookups, via JavaScript for Automation (always on macOS).
jxa() {
  osascript -l JavaScript -e '
ObjC.import("Foundation"); ObjC.import("AppKit");
function read(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  return ObjC.unwrap(s);
}
const SEP = "\u001f"; // field separator: not whitespace, so empty fields survive `read`
function json(path) { try { return JSON.parse(read(path)); } catch (e) { return null; } }
function run(argv) {
  const [cmd, a, b] = argv;
  if (cmd === "default-browser") {
    const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com/"));
    if (!ObjC.unwrap(app)) return "";
    const path = ObjC.unwrap(app.path);
    const id = ObjC.unwrap($.NSBundle.bundleWithPath(path).bundleIdentifier) || "";
    return [path.replace(/^.*\//, "").replace(/\.app$/, ""), id, path].join(SEP);
  }
  if (cmd === "extensions") {
    // Records for any copy of this extension: unpacked folders whose manifest is ours.
    const prefs = json(a);
    const out = [];
    for (const [id, v] of Object.entries(prefs?.extensions?.settings || {})) {
      if (!v.path || !v.path.startsWith("/")) continue;
      const m = json(v.path + "/manifest.json");
      if (m?.name !== "Default Browser Links") continue;
      const reasons = Array.isArray(v.disable_reasons) ? v.disable_reasons : (v.disable_reasons ? [v.disable_reasons] : []);
      const hosts = (v.runtime_granted_permissions?.scriptable_host || []).concat(v.runtime_granted_permissions?.explicit_host || []);
      out.push([id, v.path, m.version || "", reasons.join(","), v.withholding_permissions ? 1 : 0, hosts.join(" ")].join(SEP));
    }
    return out.join("\n");
  }
  if (cmd === "host-manifest") {
    const m = json(a);
    if (!m) return "INVALID";
    return [m.name || "", m.path || "", (m.allowed_origins || []).join(" ")].join(SEP);
  }
  if (cmd === "policy") {
    // Managed policies that can stop the extension or its helper.
    const d = ObjC.deepUnwrap($.NSDictionary.dictionaryWithContentsOfFile(a));
    if (!d) return "";
    const keys = ["NativeMessagingUserLevelHosts", "NativeMessagingBlocklist", "NativeMessagingAllowlist",
      "ExtensionSettings", "ExtensionInstallBlocklist", "DeveloperToolsAvailability", "ExtensionAllowedTypes"];
    const found = {};
    for (const k of keys) if (k in d) found[k] = d[k];
    return Object.keys(found).length ? JSON.stringify(found) : "";
  }
  if (cmd === "field") {
    // field <json> <key>: one top-level field of a JSON string
    try { const v = JSON.parse(a)[b]; return typeof v === "object" ? JSON.stringify(v) : String(v); } catch (e) { return ""; }
  }
  return "";
}' "$@" 2>/dev/null
}

# Sends one native message to the helper and prints the reply (exit 124 on timeout).
ping_helper() {
  local msg='{"type":"ping"}'
  { printf "\\x$(printf %02x ${#msg})\\x00\\x00\\x00"; printf %s "$msg"; } |
    perl -e 'alarm 5; exec { $ARGV[0] } @ARGV or exit 127' "$BIN" | tail -c +5
  return ${pipestatus[2]}
}

print -P "%BDefault Browser Links doctor%b  (folder: $REPO)"

# ---------------------------------------------------------------------------
head "Default browser"
IFS=$'\x1f' read -r def_name def_id def_path <<< "$(jxa default-browser)"
if [[ -n ${def_name:-} ]]; then
  ok "macOS opens web links with $def_name ($def_id)"
else
  bad "macOS has no default browser for https links"
  hint "System Settings → Desktop & Dock → Default web browser"
fi

# ---------------------------------------------------------------------------
head "Helper"
if [[ ! -x $BIN ]]; then
  bad "Not installed at $BIN"
  if ! command -v swiftc >/dev/null; then
    hint "Install Xcode's command line tools first: xcode-select --install"
  fi
  hint "Run ./install-helper.sh in this folder (or ./doctor.sh --fix)"
else
  ok "Installed at ${BIN/#$HOME/~}"
  reply=$(ping_helper); code=$?
  if (( code == 0 )) && [[ $(jxa field "$reply" ok) == true ]]; then
    ok "Responds to a test message (sees $(jxa field "$reply" defaultBrowser | sed -E 's/.*"name":"([^"]*)".*/\1/') as the default browser)"
  else
    bad "Doesn't respond (exit code $code)"
    if (( code == 137 || code == 9 )); then
      hint "It was killed on launch. Security software (e.g. Santa, CrowdStrike, Jamf) may block unsigned programs."
      hint "Ask IT to allow it, or check: log show --last 5m --predicate 'eventMessage CONTAINS \"default-browser-links\"'"
    elif (( code == 124 || code == 142 )); then
      hint "It hung for 5 s. Try reinstalling: ./install-helper.sh"
    else
      hint "Try reinstalling: ./install-helper.sh"
    fi
    xattr -p com.apple.quarantine "$BIN" >/dev/null 2>&1 &&
      hint "It's quarantined. Remove that with: xattr -d com.apple.quarantine \"$BIN\""
  fi
fi

# ---------------------------------------------------------------------------
found_any=0
registered_only=()
for b in $BROWSERS; do
  IFS='|' read -r dir bundle bname <<< "$b"
  data="$SUPPORT/$dir"
  [[ -d $data ]] || continue

  # Every profile's record of the extension.
  records=()
  for prefs in "$data"/*/"Secure Preferences"(N) "$data"/*/Preferences(N); do
    [[ -f $prefs ]] || continue
    profile=${${prefs:h}:t}
    while IFS= read -r line; do
      [[ -n $line ]] && records+=("$profile"$'\x1f'"$line")
    done <<< "$(jxa extensions "$prefs")"
  done
  host_manifest="$data/NativeMessagingHosts/$NAME.json"
  if (( ${#records} == 0 )); then
    [[ -f $host_manifest ]] && registered_only+=($bname)
    continue
  fi
  found_any=1
  head "$bname"

  ids=()
  typeset -A seen_profile_id
  for r in $records; do
    IFS=$'\x1f' read -r profile id ext_path version reasons withholding hosts <<< "$r"
    [[ -n ${seen_profile_id[$profile/$id]:-} ]] && continue
    seen_profile_id[$profile/$id]=1
    ids+=($id)
    where="profile “$profile”"
    ok "Loaded in $where: id $id, version $version"
    [[ ${ext_path:A} != $REPO ]] && info "Loaded from $ext_path (not this folder)"
    if [[ -n $reasons ]]; then
      bad "It's turned off in $where (disable reasons: $reasons)"
      hint "Turn it on at the extensions page. If it won't stay on, your browser may block unpacked extensions by policy."
    fi
    if (( withholding )); then
      if [[ " $hosts " == *" https://*/* "* || " $hosts " == *" <all_urls> "* || " $hosts " == *" *://*/* "* ]]; then
        ok "Site access: limited, but allowed on all https sites"
      else
        bad "Site access is limited (“On click” or “On specific sites”) in $where"
        hint "Without access the extension can't see clicks in your apps."
        hint "Extensions page → Default Browser Links → Details → Site access → On all sites"
        [[ -n $hosts ]] && hint "Currently allowed: $hosts"
      fi
    else
      ok "Site access: all sites"
    fi
  done
  ids=(${(u)ids})

  if [[ ! -f $host_manifest ]]; then
    bad "The helper isn't registered with $bname"
    hint "Run ./install-helper.sh ${ids[*]} (or ./doctor.sh --fix)"
    fixable_ids+=($ids)
  else
    IFS=$'\x1f' read -r m_name m_path m_origins <<< "$(jxa host-manifest "$host_manifest")"
    if [[ $m_name == INVALID ]]; then
      bad "Helper registration file is unreadable: $host_manifest"
      fixable_ids+=($ids)
    else
      [[ $m_path == $BIN ]] && ok "Helper registered" || {
        bad "Helper registration points to $m_path"; hint "Expected $BIN"; fixable_ids+=($ids); }
      for id in $ids; do
        if [[ " $m_origins " != *" chrome-extension://$id/ "* ]]; then
          bad "The helper doesn't accept extension $id (it accepts: ${m_origins:-nothing})"
          hint "Run ./install-helper.sh ${ids[*]} (or ./doctor.sh --fix)"
          fixable_ids+=($ids)
        fi
      done
    fi
  fi

  if [[ -n ${def_id:-} && $def_id == $bundle ]]; then
    bad "$bname is your default browser, so links have nowhere else to go"
    hint "Pick another in System Settings → Desktop & Dock → Default web browser"
  fi

  policy_found=0
  for plist in "$POLICY_DIR/$bundle.plist" "$POLICY_DIR/$USER/$bundle.plist"; do
    [[ -f $plist ]] || continue
    pol=$(jxa policy "$plist")
    [[ -z $pol ]] && continue
    policy_found=1
    info "Managed by your organization ($plist): $pol"
    [[ $pol == *'"NativeMessagingUserLevelHosts":false'* ]] &&
      bad "Policy ignores helpers installed per user. The helper must be installed system-wide by an admin."
    [[ $pol == *'"NativeMessagingBlocklist"'* ]] &&
      bad "Policy blocks native helpers (NativeMessagingBlocklist). Ask IT to allow $NAME."
    [[ $pol == *runtime_blocked_hosts* ]] &&
      bad "Policy stops extensions from running on some sites (runtime_blocked_hosts). Check whether your app's site is listed."
  done
  (( policy_found )) || ok "No managed policies for $bname"
done

(( ${#registered_only} )) && { print; info "Helper also registered with ${(j:, :)registered_only}, where the extension isn't loaded (harmless)"; }

if (( ! found_any )); then
  head "Extension"
  bad "Default Browser Links isn't loaded in any browser profile"
  hint "Extensions page → Developer mode → Load unpacked → pick $REPO"
fi

# ---------------------------------------------------------------------------
if (( FIX && ${#fixable_ids} )); then
  head "Fixing"
  "$REPO/install-helper.sh" ${(u)fixable_ids} && print -P "  %F{green}Done.%f Reload the extension, then run ./doctor.sh again."
elif (( FIX )) && [[ ! -x $BIN ]]; then
  head "Fixing"
  "$REPO/install-helper.sh" && print -P "  %F{green}Done.%f Reload the extension, then run ./doctor.sh again."
fi

print
if (( problems && FIX )); then
  print -P "%F{yellow}$problems problem(s) found before fixing.%f Run ./doctor.sh again to see what's left."
elif (( problems )); then
  print -P "%F{red}$problems problem(s) found.%f"
  (( ${#fixable_ids} && ! FIX )) && print "Some can be fixed automatically: ./doctor.sh --fix"
else
  print -P "%F{green}Everything checks out.%f"
  print "If links still don't go out, reload the extension, then open its popup and look at"
  print "Recent activity while you click a link in the app:"
  print "  • Nothing appears: the extension isn't seeing the app's page. Reload the app window too."
  print "  • “kept here” with a reason: that's the rule that stopped it (e.g. a site on the keep list)."
  print "  • “helper failed”: the error shown is the helper's reply."
  print "Copy diagnostics in the popup puts all of that on the clipboard."
fi
exit $(( problems > 0 ))
