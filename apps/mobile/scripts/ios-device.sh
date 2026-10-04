#!/usr/bin/env bash
# One-command iPhone build + install from a Mac (warden overnight plan #47806).
#
#   apps/mobile/scripts/ios-device.sh [paid|personal]     # default: paid
#
# paid      the paid team, com.sautihost.mobile, increased-memory entitlements (config = app.json).
# personal  a free Personal Team, SAUTI_PERSONAL_TEAM=1 (app.config.js, #95): com.sautihost.mobile.personal, no memory
#           entitlements. Free teams need the phone connected (Xcode registers it); the profile lasts 7 days.
#
# SAUTI_TEAM_ID=<team id> is required to sign (no team id is committed; find it in Xcode → Settings → Accounts).
#
# Needs: root `npm ci --ignore-scripts` done once, Xcode signed in to the team's Apple account, the iPhone unlocked,
# trusted and in Developer Mode, connected by USB. Release configuration: the JS bundle is embedded, no Metro.
# NO_INSTALL=1 builds without installing. NO_SIGN=1 compiles unsigned (CI-style check, nothing to install).
set -euo pipefail

SIGNING="${1:-paid}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$APP_DIR/../.." && pwd)"
DERIVED="${DERIVED_DATA:-$ROOT/../hn-dd}"
cd "$APP_DIR"

case "$SIGNING" in
  paid|personal) ;;
  *) echo "usage: $0 [paid|personal]" >&2; exit 2 ;;
esac
TEAM="${SAUTI_TEAM_ID:-}"
if [ -z "${NO_SIGN:-}" ] && [ -z "$TEAM" ]; then
  echo "Set SAUTI_TEAM_ID to the signing team's id (Xcode → Settings → Accounts → the team)." >&2; exit 2
fi

# CocoaPods from Homebrew Ruby, when it is not already on PATH.
command -v pod >/dev/null || export PATH="$(ls -d /opt/homebrew/lib/ruby/gems/*/bin 2>/dev/null | tail -1):$PATH"
export LANG="${LANG:-en_US.UTF-8}"

# llama.rn is hoisted to the root node_modules by the workspace install; resolve it wherever it is.
LLAMA_DIR="$(node -p "require('path').dirname(require.resolve('llama.rn/package.json'))")"
[ -d "$LLAMA_DIR/ios/rnllama.xcframework" ] || node "$LLAMA_DIR/install/download-native-artifacts.js"

echo "== prebuild ($SIGNING)"
if [ "$SIGNING" = personal ]; then export SAUTI_PERSONAL_TEAM=1; else unset SAUTI_PERSONAL_TEAM; fi
CI=1 npx expo prebuild -p ios --clean --no-install
(cd ios && pod install)

DEST='generic/platform=iOS'
REQUESTED_DEVICE="${DEVICE_ID:-}"
DEVICE_ID=""
if [ -z "${NO_SIGN:-}" ] && [ -z "${NO_INSTALL:-}" ]; then
  # DEVICE_ID=<devicectl identifier> picks a phone explicitly; otherwise the first iPhone that is available, never an
  # "unavailable" one (which a plain /available/ match would also catch).
  DEVICE_ID="${REQUESTED_DEVICE:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && !/unavailable/ && /connected|available/ {for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F-]{25,}$/) {print $i; exit}}')}"
  if [ -z "$DEVICE_ID" ]; then echo "No connected iPhone found (unlock it, trust this Mac, Developer Mode on)." >&2; exit 1; fi
  echo "== target iPhone $DEVICE_ID"
fi

SIGN_ARGS=(DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates -allowProvisioningDeviceRegistration)
[ -n "${NO_SIGN:-}" ] && SIGN_ARGS=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)

echo "== xcodebuild Release -> $DEST"
xcodebuild -workspace ios/SautiHost.xcworkspace -scheme SautiHost -configuration Release \
  -destination "$DEST" -derivedDataPath "$DERIVED" "${SIGN_ARGS[@]}" build

APP="$DERIVED/Build/Products/Release-iphoneos/SautiHost.app"
echo "== built $APP ($(du -sh "$APP" | cut -f1))"
if [ -n "$DEVICE_ID" ]; then
  xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
  echo "== installed"
  # Side-load the phone default model (Gemma 4 E2B Q4_0, #90) into the app's Documents/models/gemma/ over USB.
  # MODEL_FILE overrides the path; NO_MODEL=1 skips. The app checks the full SHA-256 once before first load.
  MODEL_FILE="${MODEL_FILE:-$ROOT/../HackNationColibri/models/gemma4/gemma-4-E2B-it-Q4_0.gguf}"
  if [ -z "${NO_MODEL:-}" ] && [ -f "$MODEL_FILE" ]; then
    # Full SHA-256 against the pin in src/models/gemma.ts BEFORE copying; stop on any mismatch.
    EXPECTED="$(node -e '
      const src = require("fs").readFileSync(process.argv[1], "utf8");
      const name = require("path").basename(process.argv[2]).replace(/[.]/g, "[.]");
      const m = src.match(new RegExp("fileName: \x27" + name + "\x27,[^}]*?sha256: \x27([0-9a-f]{64})\x27"));
      process.stdout.write(m ? m[1] : "");' "$APP_DIR/src/models/gemma.ts" "$MODEL_FILE")"
    if [ -z "$EXPECTED" ]; then echo "$(basename "$MODEL_FILE") is not a variant in src/models/gemma.ts; not copied." >&2; exit 1; fi
    echo "== checking full SHA-256 of $(basename "$MODEL_FILE")"
    ACTUAL="$(shasum -a 256 "$MODEL_FILE" | cut -d' ' -f1)"
    if [ "$ACTUAL" != "$EXPECTED" ]; then echo "SHA-256 mismatch: got $ACTUAL, expected $EXPECTED. Not copied." >&2; exit 1; fi
    BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
    # The data container exists only after a first launch (runbook step 4).
    xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" >/dev/null && sleep 5
    echo "== copying $(basename "$MODEL_FILE") to $BUNDLE_ID (2.84 GB, a few minutes over USB)"
    xcrun devicectl device copy to --device "$DEVICE_ID" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
      --source "$MODEL_FILE" --destination "Documents/models/gemma/$(basename "$MODEL_FILE")" || {
      # A full phone shows up as "socket closed" or "No space left on device"; the partial file then fills the phone.
      echo "Copy failed. Most often the iPhone is out of space: free about 1 GB more than the model, keep the phone" >&2
      echo "unlocked, then rerun with NO_SIGN unset (or copy again with the devicectl line in docs/mobile/IOS_DEVICE_RUNBOOK.md)." >&2
      exit 1
    }
    echo "== model copied. In the app: Leo -> Gemma 4 check -> full SHA-256 (once), then Load demo reviews."
  else
    echo "== model not copied (NO_MODEL set or $MODEL_FILE missing)."
  fi
fi
