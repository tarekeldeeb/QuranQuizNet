// Dynamic Expo config.
//
// Google native sign-in needs three OAuth client IDs. Rather than maintaining
// them as separate env vars, we read them straight from the standard Firebase
// config files dropped into the project root:
//   - GoogleService-Info.plist  → iOS client ID
//   - google-services.json      → Android + Web client IDs
// The values are injected into `expo.extra.googleAuth`, which the app reads at
// runtime via expo-constants (see src/services/nativeOAuth.ts). An
// EXPO_PUBLIC_GOOGLE_*_CLIENT_ID env var, if set, overrides the file value.
//
// Both platforms' Google OAuth flow (see src/services/nativeOAuth.ts
// googleRedirectUri()) redirects to the app's own package/bundle-id scheme
// (e.g. 'net.quranquiz:/oauthredirect') — NOT a reversed-client-id scheme, which
// Google never sends the browser back to for this flow — so that's the URL
// scheme each platform needs to register to catch the browser redirect.
//
// Expo passes the normalized app.json in as `config`, so everything there is
// preserved; we only augment Android/iOS URL schemes and `extra`.

const fs = require('fs');
const path = require('path');

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** iOS client ID: env override, else the CLIENT_ID key in GoogleService-Info.plist. */
function googleIosClientId() {
  if (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID) return process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const plist = readFileSafe(path.join(__dirname, 'GoogleService-Info.plist'));
  // Match <key>CLIENT_ID</key> exactly (not <key>ANDROID_CLIENT_ID</key>).
  const m = plist && plist.match(/<key>CLIENT_ID<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1] : undefined;
}

/** SHA-1 (lowercase, no colons) of the local Android debug keystore, if one has been
 *  generated (`android/` is CNG output — gitignored, machine-specific). Used to tell
 *  apart multiple "Android" OAuth clients registered under the same package name: Google
 *  binds each to one signing certificate and rejects the auth request with
 *  `invalid_request` if the client_id's cert doesn't match the APK that's actually
 *  running, even though the redirect_uri looks identical across all of them. */
function debugKeystoreSha1() {
  const keystorePath = path.join(__dirname, 'android', 'app', 'debug.keystore');
  if (!fs.existsSync(keystorePath)) return null;
  try {
    const out = require('child_process').execFileSync(
      'keytool',
      ['-list', '-v', '-keystore', keystorePath, '-alias', 'androiddebugkey', '-storepass', 'android', '-keypass', 'android'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/SHA1:\s*([0-9A-Fa-f:]+)/);
    return m ? m[1].replace(/:/g, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Android (client_type 1) + Web (client_type 3) client IDs from google-services.json.
 *  `android/app/debug.keystore` is Expo's shared template file (see
 *  debugKeystoreSha1() above) — it's present in `android/` for *every* build
 *  variant, debug or release, so its presence alone can't tell them apart. The
 *  manual release flow (see the project-android-release-signing memory / README)
 *  always sets `QQ_RELEASE_STORE_FILE` etc. to point Gradle's release
 *  signingConfig at the real `net-quranquiz-ORIGINAL-2013-key.jks` instead of
 *  debug.keystore, so that env var doubles as the debug-vs-release signal here:
 *  release builds get the entry that does NOT match the debug cert (the one
 *  bound to the real signing key); everything else (expo run:android, expo
 *  start) prefers the entry that DOES match, so Google's cert check passes for
 *  local testing. Falls back to the first entry when there's nothing to compare
 *  against (e.g. no debug.keystore yet, or only one Android client registered). */
function googleClientIdsFromJson() {
  const raw = readFileSafe(path.join(__dirname, 'google-services.json'));
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
  const clients = (json && json.client && json.client[0] && json.client[0].oauth_client) || [];
  const androidClients = clients.filter((c) => c.client_type === 1);
  const debugSha1 = debugKeystoreSha1();
  const isReleaseBuild = !!process.env.QQ_RELEASE_STORE_FILE;
  const preferred = debugSha1 && (isReleaseBuild
    ? androidClients.find((c) => c.android_info && c.android_info.certificate_hash !== debugSha1)
    : androidClients.find((c) => c.android_info && c.android_info.certificate_hash === debugSha1));
  const android = (preferred || androidClients[0] || {}).client_id;
  const web = clients.find((c) => c.client_type === 3);
  return { android, web: web && web.client_id };
}

module.exports = ({ config }) => {
  const iosClientId = googleIosClientId();
  const fromJson = googleClientIdsFromJson();
  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || fromJson.android;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || fromJson.web;
  // Facebook native login redirects to fb<APP_ID>://authorize (the only custom
  // scheme Facebook accepts), so that scheme must be registered on both platforms.
  const facebookAppId = process.env.EXPO_PUBLIC_FACEBOOK_APP_ID;
  const facebookScheme = facebookAppId ? `fb${facebookAppId}` : null;
  // Android needs an explicit intent filter for the package-name scheme (iOS gets
  // it for free below via the hardcoded 'net.quranquiz' CFBundleURLScheme).
  const googleAndroidScheme = androidClientId ? ((config.android && config.android.package) || 'net.quranquiz') : null;

  return {
    ...config,
    plugins: [
      ...(config.plugins || []),
      './plugins/withFmtConstevalFix',
      './plugins/withAndroidReleaseSigning',
      './plugins/withEdgeToEdgeStatusBarCleanup',
    ],
    ios: {
      ...config.ios,
      infoPlist: {
        ...(config.ios && config.ios.infoPlist),
        CFBundleURLTypes: [
          {
            // App's own schemes ('net.quranquiz' doubles as the Google OAuth
            // redirect scheme — see the module comment above) and the Facebook
            // redirect scheme.
            CFBundleURLSchemes: [
              'quranquiz',
              'net.quranquiz',
              ...(facebookScheme ? [facebookScheme] : []),
            ],
          },
        ],
      },
    },
    android: {
      ...config.android,
      intentFilters: [
        ...((config.android && config.android.intentFilters) || []),
        // Google Android OAuth redirect (package-name scheme). Only added once the
        // Android client id is available (google-services.json has a client_type 1).
        ...(googleAndroidScheme
          ? [{
              action: 'VIEW',
              category: ['DEFAULT', 'BROWSABLE'],
              data: [{ scheme: googleAndroidScheme }],
            }]
          : []),
        // Facebook OAuth redirect (fb<APP_ID>://authorize).
        ...(facebookScheme
          ? [{
              action: 'VIEW',
              category: ['DEFAULT', 'BROWSABLE'],
              data: [{ scheme: facebookScheme }],
            }]
          : []),
      ],
    },
    extra: {
      ...(config.extra || {}),
      googleAuth: {
        iosClientId: iosClientId || null,
        androidClientId: androidClientId || null,
        webClientId: webClientId || null,
      },
    },
  };
};
