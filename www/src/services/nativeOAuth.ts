// Native (iOS/Android) social sign-in via expo-auth-session.
//
// The Firebase JS SDK's popup helpers (signInWithPopup / linkWithPopup) only
// work on the web — on React Native they throw
// `auth/operation-not-supported-in-this-environment`. So on native we run the
// OAuth dance ourselves in the system browser via expo-auth-session, get back a
// provider token (Google id_token / Facebook access_token), and hand it to
// Firebase as a credential (signInWithCredential / linkWithCredential).
//
// This module is only imported on native (firebase.ts lazy-imports it behind a
// Platform check), so the web bundle never pulls in expo-auth-session.
//
// Client IDs come from EXPO_PUBLIC_* env vars (see .env.example). They are not
// secrets — they are public OAuth client identifiers — so inlining them into the
// bundle is fine.

import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  GoogleAuthProvider, FacebookAuthProvider, OAuthProvider, OAuthCredential,
} from 'firebase/auth';

// Required so the browser-based auth flow can dismiss its tab and return control
// to the app when the redirect fires. Safe to call at module load.
WebBrowser.maybeCompleteAuthSession();

const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const FACEBOOK_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://www.facebook.com/v19.0/dialog/oauth',
  tokenEndpoint: 'https://graph.facebook.com/v19.0/oauth/access_token',
};

type GoogleAuthExtra = {
  iosClientId?: string | null;
  androidClientId?: string | null;
  webClientId?: string | null;
};

/** Google client IDs injected by app.config.js from GoogleService-Info.plist /
 *  google-services.json (see expo.extra.googleAuth). */
function googleAuthConfig(): GoogleAuthExtra {
  return (Constants.expoConfig?.extra?.googleAuth ?? {}) as GoogleAuthExtra;
}

/** Pick the Google OAuth client ID for the running platform. Prefers the value
 *  from the Firebase config files; falls back to an EXPO_PUBLIC_* env override. */
function googleClientId(): string | undefined {
  const cfg = googleAuthConfig();
  return (Platform.select({
    ios: cfg.iosClientId || process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    android: cfg.androidClientId || process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
    default: cfg.webClientId || process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  }) as string | undefined) || undefined;
}

/**
 * The native Google flow redirects to the app's own package/bundle-id scheme
 * (e.g. `net.quranquiz:/oauthredirect`). Google binds the iOS/Android OAuth
 * client to that identifier, so it accepts this redirect and rejects any other
 * (including the reversed client-id scheme) with `invalid_request`. The scheme is
 * registered by default from the applicationId, so no extra config is needed.
 * Mirrors expo-auth-session's own Google provider.
 */
function googleRedirectUri(): string {
  const cfg = Constants.expoConfig;
  const appId =
    (Platform.OS === 'ios' ? cfg?.ios?.bundleIdentifier : cfg?.android?.package) ??
    'net.quranquiz';
  return AuthSession.makeRedirectUri({ native: `${appId}:/oauthredirect` });
}

/**
 * Run the Google OAuth flow in the system browser and return a Firebase
 * credential, or null if the user dismisses the browser. Throws if the client
 * ID is unconfigured or no token comes back.
 */
export async function acquireGoogleCredential(): Promise<OAuthCredential | null> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new Error('Google sign-in is not configured: add GoogleService-Info.plist / google-services.json to the project root (or set EXPO_PUBLIC_GOOGLE_*_CLIENT_ID).');
  }
  const redirectUri = googleRedirectUri();
  // Google's native (iOS/Android) OAuth clients are *public* clients and only
  // support the authorization-code + PKCE flow — the implicit id_token flow is
  // rejected with invalid_request. So request a code, then exchange it (with the
  // PKCE verifier; no client secret) for tokens and hand the id_token to Firebase.
  const request = new AuthSession.AuthRequest({
    clientId,
    scopes: ['openid', 'profile', 'email'],
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
  });
  // preferEphemeralSession: iOS's ASWebAuthenticationSession shares Safari's
  // cookie jar by default, so a Google sign-in here would leave persistent
  // accounts.google.com cookies behind — exactly the kind of cross-session
  // tracking Apple's App Tracking Transparency guideline (5.1.2(i)) requires
  // a permission prompt for. Forcing a private/ephemeral session means no
  // cookies survive the auth flow, so there's nothing to request permission
  // for. (Rejected under 5.1.2(i) on submission 54c6ee4c, 2026-08-03.)
  const result = await request.promptAsync(GOOGLE_DISCOVERY, { preferEphemeralSession: true });
  if (result.type !== 'success') return null; // cancelled / dismissed
  const code = result.params.code;
  if (!code) throw new Error('Google sign-in returned no authorization code.');

  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier ?? '' },
    },
    GOOGLE_DISCOVERY,
  );
  const idToken = tokens.idToken;
  if (!idToken) throw new Error('Google sign-in returned no id_token.');
  return GoogleAuthProvider.credential(idToken);
}

/**
 * Run the Facebook OAuth flow in the system browser and return a Firebase
 * credential, or null if the user dismisses the browser.
 *
 * Facebook's "Valid OAuth Redirect URIs" field only accepts https:// URLs, so an
 * arbitrary custom scheme (e.g. quranquiz://…) is rejected with "URL blocked".
 * The one custom scheme Facebook always accepts for native apps is
 * `fb<APP_ID>://authorize` — provided the iOS / Android platforms (bundle id,
 * package name + key hashes) are configured in the Facebook app dashboard.
 * The `fb<APP_ID>` scheme is registered in app.config.js (and the prebuilt
 * native projects) so the browser can return to the app.
 */
export async function acquireFacebookCredential(): Promise<OAuthCredential | null> {
  const appId = process.env.EXPO_PUBLIC_FACEBOOK_APP_ID;
  if (!appId) {
    throw new Error('Facebook sign-in is not configured: set EXPO_PUBLIC_FACEBOOK_APP_ID.');
  }
  const redirectUri = AuthSession.makeRedirectUri({ native: `fb${appId}://authorize` });
  const request = new AuthSession.AuthRequest({
    clientId: appId,
    scopes: ['public_profile', 'email'],
    redirectUri,
    responseType: AuthSession.ResponseType.Token,
    extraParams: { display: 'popup' },
    usePKCE: false, // implicit (token) flow — PKCE params don't apply
  });
  // See the matching comment in acquireGoogleCredential above — same fix,
  // same reason (facebook.com's login cookies otherwise persist in Safari's
  // shared cookie jar).
  const result = await request.promptAsync(FACEBOOK_DISCOVERY, { preferEphemeralSession: true });
  if (result.type !== 'success') return null;
  const accessToken = result.params.access_token;
  if (!accessToken) throw new Error('Facebook sign-in returned no access_token.');
  return FacebookAuthProvider.credential(accessToken);
}

export interface AppleCredentialResult {
  credential: OAuthCredential;
  // Apple only returns the user's name the very first time they authorize this
  // app (never again, even after a token refresh) — firebase.ts uses this to
  // set the Firebase displayName once, since the identity token itself carries
  // no name claim.
  fullName: AppleAuthentication.AppleAuthenticationFullName | null;
}

/**
 * Run Sign in with Apple (native AuthenticationServices UI) and return a
 * Firebase credential, or null if the user cancels. The nonce dance guards
 * against replay: a random raw nonce is hashed and sent to Apple, which
 * embeds the hash in the identity token; Firebase re-hashes the raw nonce
 * server-side to verify it matches.
 */
export async function acquireAppleCredential(): Promise<AppleCredentialResult | null> {
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  let appleCredential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    appleCredential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
    throw e;
  }

  const { identityToken, fullName } = appleCredential;
  if (!identityToken) throw new Error('Apple sign-in returned no identity token.');
  const credential = new OAuthProvider('apple.com').credential({ idToken: identityToken, rawNonce });
  return { credential, fullName };
}

export type SocialKind = 'google' | 'facebook';

/** Acquire a credential for the given provider kind. */
export function acquireCredential(kind: SocialKind): Promise<OAuthCredential | null> {
  return kind === 'google' ? acquireGoogleCredential() : acquireFacebookCredential();
}
