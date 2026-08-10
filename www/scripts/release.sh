#!/usr/bin/env bash
# www/scripts/release.sh — bump the app version + iOS/Android build numbers,
# then build fresh release binaries for both platforms locally (Xcode
# archive/export, Gradle bundleRelease). Automates the manual flow recorded
# in the project-ios-local-xcode-build / project-android-release-signing
# notes.
#
# Usage:
#   scripts/release.sh major|minor|patch [options]
#   scripts/release.sh version X.Y.Z [options]
#
# Options:
#   --ios-only        Build iOS only (skip Android)
#   --android-only    Build Android only (skip iOS)
#   --bump-only       Bump version/build numbers and exit, build nothing
#   --no-bump         Skip the version bump, build the current app.json
#                      version as-is (mutually exclusive with a bump mode).
#                      Useful to resume/split a run, e.g. after building iOS
#                      to then build Android separately without bumping twice.
#   --no-upload       Build the .ipa locally but skip the App Store Connect
#                      upload. By default a successful iOS build IS
#                      uploaded to App Store Connect.
#   -h, --help        Show this help
#
# The version bump always advances expo.version (per the chosen mode) AND
# both platforms' build counters (ios.buildNumber, android.versionCode) by
# 1, even if only one platform is actually built with --ios-only/
# --android-only — they're independent per-store counters.
#
# Before the iOS archive, scripts/check-ios-distribution-certs.mjs queries
# App Store Connect and aborts if the account is at (or over) its Apple
# Distribution certificate limit (default 3, override with
# QQ_MAX_DISTRIBUTION_CERTS) — xcodebuild's automatic signing can otherwise
# revoke an existing cert unattended (possibly the one EAS Build relies on)
# to make room for a new one.
#
# On success: the iOS .ipa is uploaded straight to App Store Connect (no
# further review-submission step — that's still a manual step in App Store
# Connect). The Android .aab is never auto-uploaded — there's no Play Store
# submission credential wired up in this repo — its path is printed for a
# manual upload to the Play Console.
#
# Android release signing needs QQ_RELEASE_STORE_PASSWORD (and, if
# different from the store password, QQ_RELEASE_KEY_PASSWORD). These are
# loaded from www/.env if present (gitignored, local-only); otherwise
# you'll be prompted for them interactively. See the
# project-android-release-signing memory for where the keystore lives.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # -> www/

# The version bump above intentionally leaves app.json/package.json dirty.
# `expo prebuild` runs its own interactive `git status --porcelain` check
# (independent of --non-interactive) and would otherwise block on a
# "Continue with uncommited changes?" prompt every single run.
export EXPO_NO_GIT_STATUS=1

usage() {
  cat <<'EOF'
Usage:
  scripts/release.sh major|minor|patch [options]
  scripts/release.sh version X.Y.Z [options]

Options:
  --ios-only        Build iOS only (skip Android)
  --android-only    Build Android only (skip iOS)
  --bump-only       Bump version/build numbers and exit, build nothing
  --no-bump         Skip the version bump, build the current app.json version as-is
  --no-upload       Build the .ipa locally but skip the App Store Connect upload
  -h, --help        Show this help
EOF
}

MODE=""
EXPLICIT_VERSION=""
DO_IOS=1
DO_ANDROID=1
BUMP_ONLY=0
UPLOAD_IOS=1
NO_BUMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    major|minor|patch)
      MODE="$1"; shift ;;
    version)
      MODE="version"; shift
      [[ $# -gt 0 ]] || { echo "release.sh: 'version' needs an X.Y.Z argument" >&2; exit 1; }
      EXPLICIT_VERSION="$1"; shift ;;
    --ios-only) DO_ANDROID=0; shift ;;
    --android-only) DO_IOS=0; shift ;;
    --bump-only) BUMP_ONLY=1; shift ;;
    --no-upload) UPLOAD_IOS=0; shift ;;
    --no-bump) NO_BUMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "release.sh: unknown argument '$1'" >&2; usage; exit 1 ;;
  esac
done

if [[ "$NO_BUMP" == "1" ]]; then
  [[ -z "$MODE" ]] || { echo "release.sh: --no-bump and a bump mode ($MODE) are mutually exclusive" >&2; exit 1; }
  [[ "$BUMP_ONLY" == "0" ]] || { echo "release.sh: --no-bump and --bump-only are mutually exclusive" >&2; exit 1; }
else
  [[ -n "$MODE" ]] || { echo "release.sh: missing bump mode (major|minor|patch|version X.Y.Z), or pass --no-bump to build the current app.json version as-is" >&2; usage; exit 1; }
fi
if [[ "$BUMP_ONLY" == "0" && "$DO_IOS" == "0" && "$DO_ANDROID" == "0" ]]; then
  echo "release.sh: --ios-only and --android-only together build nothing" >&2; exit 1
fi

if [[ "$NO_BUMP" == "1" ]]; then
  echo "==> --no-bump set, building the current app.json version as-is"
  BUMP_OUT="$(node -e "const j=require('./app.json'); console.log('RELEASE_VERSION='+j.expo.version); console.log('RELEASE_IOS_BUILD='+j.expo.ios.buildNumber); console.log('RELEASE_ANDROID_VERSION_CODE='+j.expo.android.versionCode);")"
else
  echo "==> Bumping version ($MODE${EXPLICIT_VERSION:+ $EXPLICIT_VERSION})"
  BUMP_OUT="$(node scripts/bump-version.mjs "$MODE" "$EXPLICIT_VERSION")"
fi
eval "$BUMP_OUT"
echo "    version=$RELEASE_VERSION  ios.buildNumber=$RELEASE_IOS_BUILD  android.versionCode=$RELEASE_ANDROID_VERSION_CODE"

if [[ "$BUMP_ONLY" == "1" ]]; then
  echo "==> --bump-only set, not building. Review the app.json/package.json diff and commit when ready."
  exit 0
fi

IOS_IPA=""
ANDROID_AAB=""

if [[ "$DO_IOS" == "1" ]]; then
  echo "==> [iOS] checking Apple Distribution certificate count (avoid an unattended revoke — see script comments)"
  node scripts/check-ios-distribution-certs.mjs "${QQ_MAX_DISTRIBUTION_CERTS:-3}"

  echo "==> [iOS] prebuild"
  npx expo prebuild -p ios --clean --non-interactive

  # The workspace/scheme name is derived by Expo from expo.name (app.json)
  # and changes whenever that does — read it back from the generated
  # project instead of hardcoding it, so a future rename doesn't silently
  # break this script the way it broke on the "Quran Quiz" rename.
  IOS_WORKSPACE="$(ls -d ios/*.xcworkspace | head -n1)"
  IOS_SCHEME="$(basename "$IOS_WORKSPACE" .xcworkspace)"

  ARCHIVE_PATH="ios/build/${IOS_SCHEME}.xcarchive"
  EXPORT_DIR="ios/build/export"
  rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR"

  echo "==> [iOS] xcodebuild archive (scheme=$IOS_SCHEME)"
  xcodebuild archive \
    -workspace "$IOS_WORKSPACE" \
    -scheme "$IOS_SCHEME" \
    -configuration Release \
    -archivePath "$ARCHIVE_PATH" \
    -destination "generic/platform=iOS" \
    -allowProvisioningUpdates

  EXPORT_OPTIONS="ios/build/ExportOptions.plist"
  DESTINATION="export"
  [[ "$UPLOAD_IOS" == "1" ]] && DESTINATION="upload"
  cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>FNSP52WBLF</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>destination</key>
    <string>${DESTINATION}</string>
</dict>
</plist>
PLIST

  EXPORT_ARGS=(-exportArchive -archivePath "$ARCHIVE_PATH" -exportPath "$EXPORT_DIR" -exportOptionsPlist "$EXPORT_OPTIONS" -allowProvisioningUpdates)
  if [[ "$UPLOAD_IOS" == "1" ]]; then
    # Reuse the same ASC API key already configured for `eas submit` in
    # eas.json (submit.production.ios) rather than duplicating it here.
    eval "$(node -e "const c=require('./eas.json').submit.production.ios; console.log('ASC_KEY_PATH='+c.ascApiKeyPath); console.log('ASC_KEY_ID='+c.ascApiKeyId); console.log('ASC_KEY_ISSUER_ID='+c.ascApiKeyIssuerId);")"
    [[ -f "$ASC_KEY_PATH" ]] || { echo "release.sh: ASC API key not found at $ASC_KEY_PATH (needed to upload; pass --no-upload to skip)" >&2; exit 1; }
    EXPORT_ARGS+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_KEY_ISSUER_ID")
  fi
  echo "==> [iOS] xcodebuild -exportArchive (destination=$DESTINATION)"
  xcodebuild "${EXPORT_ARGS[@]}"

  if [[ "$UPLOAD_IOS" == "1" ]]; then
    # destination=upload sends the ipa straight to App Store Connect and
    # doesn't leave a local copy in $EXPORT_DIR — nothing to find.
    echo "==> [iOS] uploaded build $RELEASE_VERSION ($RELEASE_IOS_BUILD) to App Store Connect"
  else
    IOS_IPA="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' | head -n1)"
  fi
fi

if [[ "$DO_ANDROID" == "1" ]]; then
  echo "==> [Android] prebuild"
  npx expo prebuild -p android --clean --non-interactive

  # www/.env (gitignored) already carries QQ_RELEASE_* for local release
  # builds — load it before falling back to an interactive prompt, so a
  # fully-provisioned machine never needs to type the password by hand.
  if [[ -f .env && ( -z "${QQ_RELEASE_STORE_PASSWORD:-}" || -z "${QQ_RELEASE_KEY_PASSWORD:-}" ) ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi

  : "${QQ_RELEASE_STORE_FILE:=$HOME/.android-signing/quranquiznet/net-quranquiz-ORIGINAL-2013-key.jks}"
  : "${QQ_RELEASE_KEY_ALIAS:=tarekey}"
  [[ -f "$QQ_RELEASE_STORE_FILE" ]] || { echo "release.sh: release keystore not found at $QQ_RELEASE_STORE_FILE (set QQ_RELEASE_STORE_FILE to override)" >&2; exit 1; }

  if [[ -z "${QQ_RELEASE_STORE_PASSWORD:-}" ]]; then
    read -r -s -p "Android release keystore password: " QQ_RELEASE_STORE_PASSWORD; echo
  fi
  if [[ -z "${QQ_RELEASE_KEY_PASSWORD:-}" ]]; then
    read -r -s -p "Android release key password [enter = same as keystore password]: " QQ_RELEASE_KEY_PASSWORD; echo
    QQ_RELEASE_KEY_PASSWORD="${QQ_RELEASE_KEY_PASSWORD:-$QQ_RELEASE_STORE_PASSWORD}"
  fi
  export QQ_RELEASE_STORE_FILE QQ_RELEASE_STORE_PASSWORD QQ_RELEASE_KEY_ALIAS QQ_RELEASE_KEY_PASSWORD

  echo "==> [Android] gradlew bundleRelease"
  (cd android && ./gradlew clean bundleRelease)

  ANDROID_AAB="android/app/build/outputs/bundle/release/app-release.aab"
  [[ -f "$ANDROID_AAB" ]] || { echo "release.sh: expected AAB not found at $ANDROID_AAB" >&2; exit 1; }

  echo "==> [Android] verifying signature"
  jarsigner -verify -verbose -certs "$ANDROID_AAB" | grep -q "jar verified" \
    && echo "    jar verified" \
    || echo "    WARNING: jarsigner did not report 'jar verified' — inspect its output above before uploading"

  FINGERPRINT="$(keytool -list -v -keystore "$QQ_RELEASE_STORE_FILE" -alias "$QQ_RELEASE_KEY_ALIAS" -storepass "$QQ_RELEASE_STORE_PASSWORD" 2>/dev/null | awk -F': ' '/SHA256:/{print $2; exit}')"
  EXPECTED_FINGERPRINT="D8:12:CC:B0:6E:04:95:20:8E:82:11:87:80:4C:02:0C:86:DC:4E:82:BD:7A:58:F4:20:73:19:8C:63:3F:4F:02"
  if [[ "$FINGERPRINT" != "$EXPECTED_FINGERPRINT" ]]; then
    echo "    WARNING: signing cert SHA-256 ($FINGERPRINT) does not match the known Play Store key ($EXPECTED_FINGERPRINT) — do NOT upload this build" >&2
  else
    echo "    signing cert matches the known Play Store key"
  fi
fi

echo
echo "==> Done — version=$RELEASE_VERSION  ios.buildNumber=$RELEASE_IOS_BUILD  android.versionCode=$RELEASE_ANDROID_VERSION_CODE"
if [[ "$DO_IOS" == "1" ]]; then
  if [[ "$UPLOAD_IOS" == "1" ]]; then
    echo "    iOS:         uploaded to App Store Connect (build $RELEASE_IOS_BUILD) — no local .ipa kept"
  else
    echo "    iOS ipa:     $IOS_IPA (not uploaded — rerun without --no-upload, or upload manually)"
  fi
fi
[[ -n "$ANDROID_AAB" ]] && echo "    Android aab: $ANDROID_AAB  <-- upload this manually to the Play Console"
echo
echo "    app.json / package.json were modified on disk but NOT committed — review with 'git diff' and commit when ready."
