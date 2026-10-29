#!/bin/zsh
# Installs (or with --uninstall removes) the native helper Default Browser Links
# needs to hand links to your default browser. Extensions can't launch other
# apps themselves; this small helper does it for them via native messaging.
#
#   ./install-helper.sh [--uninstall] [extension-id …]
#
# Registers the helper with every Chromium-based browser that has a profile
# folder on this Mac (Chrome, Helium, Arc, Edge, Brave, Vivaldi, Chromium…).
# The extension id defaults to the one a browser gives this folder when it's
# loaded unpacked; pass the id(s) shown on the extensions page if yours differ.
# ./doctor.sh checks the whole setup and finds the ids for you.
# Set DBL_EXTRA_DIRS (colon-separated browser data folders) to add others.
# Set DBL_ONLY (colon-separated folder names from browsers.zsh, e.g.
# net.imput.helium) to register with just those browsers.
set -euo pipefail

NAME=com.cmdurham.default_browser_links
REPO=${0:A:h}
SUPPORT="$HOME/Library/Application Support"
BIN_DIR="$SUPPORT/DefaultBrowserLinks"
BIN="$BIN_DIR/default-browser-links-helper"

source "$REPO/browsers.zsh"
dirs=()
only=(${(s.:.)${DBL_ONLY:-}})
for b in $BROWSERS; do
  d=${b%%|*}
  (( ${#only} )) && (( ! ${only[(Ie)$d]} )) && continue
  [[ -d "$SUPPORT/$d" ]] && dirs+=("$SUPPORT/$d")
done
for d in ${(s.:.)${DBL_EXTRA_DIRS:-}}; do
  [[ -n $d ]] && dirs+=("$d")
done

if [[ ${1:-} == --uninstall ]]; then
  for d in $dirs; do rm -f "$d/NativeMessagingHosts/$NAME.json"; done
  rm -f "$BIN"
  rmdir "$BIN_DIR" 2>/dev/null || true
  echo "Removed the Default Browser Links helper."
  exit 0
fi

if (( ${#dirs} == 0 )); then
  echo "No Chromium-based browser profile folders found in $SUPPORT." >&2
  echo "Open your browser once, or set DBL_EXTRA_DIRS to its data folder." >&2
  exit 1
fi

if ! command -v swiftc >/dev/null; then
  echo "swiftc not found. Install Xcode's command line tools: xcode-select --install" >&2
  exit 1
fi

# Unpacked extension ids are the first 128 bits of SHA-256(folder path), hex mapped to a–p.
EXT_IDS=("$@")
(( ${#EXT_IDS} )) || EXT_IDS=($(print -rn -- "$REPO" | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p'))
origins=()
for id in $EXT_IDS; do
  if [[ ! $id =~ '^[a-p]{32}$' ]]; then
    echo "'$id' doesn't look like an extension id (32 letters a–p)." >&2
    exit 1
  fi
  origins+=("\"chrome-extension://$id/\"")
done

mkdir -p "$BIN_DIR"
swiftc -O -o "$BIN" "$REPO/helper/default-browser-links-helper.swift"

for d in $dirs; do
  mkdir -p "$d/NativeMessagingHosts"
  cat > "$d/NativeMessagingHosts/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Default Browser Links helper: opens links in the default browser",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": [${(j:, :)origins}]
}
JSON
  echo "  registered with ${d#$SUPPORT/}"
done

echo "Installed the Default Browser Links helper for extension ${(j:, :)EXT_IDS}."
echo "Reopen the extension's popup (or reload it) to pick it up."
