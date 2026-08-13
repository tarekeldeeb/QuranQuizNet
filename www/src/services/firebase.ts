// Firebase integration — mirrors www/profile/firebasecontrol.js and _model_/services.js (FB factory)
// Uses Firebase JS SDK v10 modular API — works on iOS, Android, and web.

import { Platform } from 'react-native';
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getAuth, initializeAuth, onAuthStateChanged, signInAnonymously,
  signInWithPopup, linkWithPopup, signInWithCredential, linkWithCredential,
  GoogleAuthProvider, FacebookAuthProvider, AuthProvider, AuthCredential, OAuthCredential,
  signOut as fbSignOut, updateProfile, User, Auth,
} from 'firebase/auth';
// getReactNativePersistence is only exported from Firebase's React Native build;
// the app's tsconfig resolves the web/node types, so the type isn't visible here.
// It's present at runtime on native via Metro's "react-native" entry point.
// @ts-expect-error — RN-only export, absent from the resolved web types
import { getReactNativePersistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDatabase, ref, set, push, get as dbGet, update, remove,
  onValue, onDisconnect, runTransaction, serverTimestamp, Database,
} from 'firebase/database';
import { getFunctions, httpsCallable, Functions } from 'firebase/functions';
import type { SocialKind } from './nativeOAuth';
import type { PvpQueueEntry, PvpMatchMeta, PvpPlayerState, PvpMatchResult, MatchScopePart } from './pvpService';
import { useProfileStore, tierFromRatioRange } from '../stores/profileStore';
import { quizCodeOf } from '../models/quizCode';
import { computeJuzMap, encodePublicJuzMap, type PublicJuzMap } from '../models/juzMap';

// Config comes from EXPO_PUBLIC_* env vars (see .env / .env.example), so the
// values are not hard-coded in source. Note: EXPO_PUBLIC_* vars are still
// inlined into the client bundle — the Firebase web apiKey is a public project
// identifier, not a secret; protect data via Firebase Security Rules / App Check.
const FIREBASE_CONFIG = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};
// ─────────────────────────────────────────────────────────────────────────────

let app: FirebaseApp;
let auth: Auth;
let db: Database;

export function getFirebaseApp(): FirebaseApp {
  if (!getApps().length) {
    app = initializeApp(FIREBASE_CONFIG);
  } else {
    app = getApp();
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    if (Platform.OS === 'web') {
      auth = getAuth(getFirebaseApp());
    } else {
      // Native: wire Auth to AsyncStorage so the session survives app restarts.
      // initializeAuth throws "auth/already-initialized" if called twice (e.g. on
      // Fast Refresh) — fall back to getAuth to recover the existing instance.
      try {
        auth = initializeAuth(getFirebaseApp(), {
          persistence: getReactNativePersistence(AsyncStorage),
        });
      } catch {
        auth = getAuth(getFirebaseApp());
      }
    }
  }
  return auth;
}

export function getFirebaseDb(): Database {
  if (!db) db = getDatabase(getFirebaseApp());
  return db;
}

let fns: Functions;
export function getFirebaseFunctions(): Functions {
  if (!fns) fns = getFunctions(getFirebaseApp());
  return fns;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

export async function signInAnon(): Promise<User | null> {
  try {
    const result = await signInAnonymously(getFirebaseAuth());
    return result.user;
  } catch (e) {
    console.error('signInAnon error:', e);
    return null;
  }
}

// Popup outcomes that mean "the user backed out" — not real failures, so we
// stay silent (return null without surfacing an error to the caller's UI).
const BENIGN_POPUP_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
]);

function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Always show the Google account chooser instead of silently reusing the one
  // already signed in to the browser.
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

function credentialFromError(provider: AuthProvider, err: unknown): OAuthCredential | null {
  if (provider instanceof GoogleAuthProvider) return GoogleAuthProvider.credentialFromError(err as never);
  if (provider instanceof FacebookAuthProvider) return FacebookAuthProvider.credentialFromError(err as never);
  return null;
}

/** The "other" social provider — used to resolve same-email account collisions.
 *  This app only has Google + Facebook, so if a sign-in collides on email the
 *  existing account must be the other provider. */
function otherProvider(provider: AuthProvider): AuthProvider {
  return provider instanceof FacebookAuthProvider ? googleProvider() : new FacebookAuthProvider();
}

/**
 * Resolve `auth/account-exists-with-different-credential`: the user tried one
 * provider but their email is already registered with the other. Sign them into
 * the existing provider, then link the credential they just tried so either one
 * works next time. Returns the signed-in user (or null if they dismiss the popup).
 */
async function linkExistingAccount(auth: Auth, provider: AuthProvider, error: unknown): Promise<User | null> {
  const pendingCred = credentialFromError(provider, error);
  if (!pendingCred) throw error;
  const result = await signInWithPopup(auth, otherProvider(provider));
  // Best-effort link; if it fails (e.g. already linked) the user is still signed in.
  await linkWithCredential(result.user, pendingCred).catch((e) => console.warn('link pending credential failed:', e));
  return result.user;
}

/**
 * Sign in (or, for a guest, upgrade) with a social provider.
 *
 * - Anonymous guest: link the provider so local progress is preserved; if that
 *   social account already exists, sign straight into it.
 * - Same email registered with the other provider
 *   (`auth/account-exists-with-different-credential`): sign into the existing
 *   provider and link the new credential.
 *
 * Throws on real errors so the caller can show a message; returns null only when
 * the user dismisses a popup.
 */
async function socialSignIn(provider: AuthProvider, kind: SocialKind): Promise<User | null> {
  // Native (iOS/Android) can't use Firebase's popup flow — it throws
  // `auth/operation-not-supported-in-this-environment`. Run the OAuth flow in the
  // system browser instead and sign in / link with the resulting credential.
  if (Platform.OS !== 'web') return nativeSocialSignIn(kind);

  const auth = getFirebaseAuth();
  const current = auth.currentUser;
  try {
    if (current?.isAnonymous) {
      try {
        const linked = await linkWithPopup(current, provider);
        return linked.user;
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        // The social account is already registered — sign into it directly.
        if (code === 'auth/credential-already-in-use') {
          const cred = credentialFromError(provider, e);
          if (cred) {
            const result = await signInWithCredential(auth, cred);
            return result.user;
          }
        }
        throw e;
      }
    }
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === 'auth/account-exists-with-different-credential') {
      try {
        return await linkExistingAccount(auth, provider, e);
      } catch (e2: unknown) {
        if (BENIGN_POPUP_CODES.has((e2 as { code?: string }).code ?? '')) return null;
        console.error('socialSignIn link error:', e2);
        throw e2;
      }
    }
    if (BENIGN_POPUP_CODES.has(code ?? '')) return null;
    console.error('socialSignIn error:', e);
    throw e;
  }
}

// ─── Native (iOS/Android) credential-based sign-in ──────────────────────────────

/**
 * Sign in / link on native using a credential obtained from the system-browser
 * OAuth flow. Mirrors the web `socialSignIn` logic:
 *  - Anonymous guest → link to preserve progress; if the social account already
 *    exists, sign straight into it.
 *  - Same email registered with the other provider
 *    (`auth/account-exists-with-different-credential`) → run the other provider's
 *    flow, sign into it, then link this credential so either one works next time.
 *
 * Throws on real errors; returns null when the user dismisses the browser.
 */
async function nativeSocialSignIn(kind: SocialKind): Promise<User | null> {
  // Lazy require so the native-only OAuth code (and its expo-auth-session deps,
  // whose module side-effects run on load) is never executed on web. The `import
  // type` keeps this fully typed without a runtime ESM import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const oauth = require('./nativeOAuth') as typeof import('./nativeOAuth');
  const auth = getFirebaseAuth();
  const credential = await oauth.acquireCredential(kind);
  if (!credential) return null; // user dismissed the browser

  const current = auth.currentUser;
  if (current?.isAnonymous) {
    try {
      const linked = await linkWithCredential(current, credential);
      return linked.user;
    } catch (e: unknown) {
      // The social account already exists — sign into it directly.
      if ((e as { code?: string }).code === 'auth/credential-already-in-use') {
        const result = await signInWithCredential(auth, credential);
        return result.user;
      }
      throw e;
    }
  }

  try {
    const result = await signInWithCredential(auth, credential);
    return result.user;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'auth/account-exists-with-different-credential') {
      return nativeLinkExistingAccount(auth, oauth, kind, credential);
    }
    throw e;
  }
}

/** Native counterpart of `linkExistingAccount`: the email already belongs to the
 *  other provider, so sign into that one and link the credential just attempted. */
async function nativeLinkExistingAccount(
  auth: Auth,
  oauth: typeof import('./nativeOAuth'),
  kind: SocialKind,
  pendingCred: AuthCredential,
): Promise<User | null> {
  const otherKind: SocialKind = kind === 'google' ? 'facebook' : 'google';
  const otherCred = await oauth.acquireCredential(otherKind);
  if (!otherCred) return null; // user dismissed the recovery browser
  const result = await signInWithCredential(auth, otherCred);
  // Best-effort link; the user is signed in regardless.
  await linkWithCredential(result.user, pendingCred).catch((e) => console.warn('native link pending credential failed:', e));
  return result.user;
}

export function signInGoogle(): Promise<User | null> {
  return socialSignIn(googleProvider(), 'google');
}

export function signInFacebook(): Promise<User | null> {
  return socialSignIn(new FacebookAuthProvider(), 'facebook');
}

/** Races a promise against a timeout so a hung native/network call surfaces as
 *  a real error instead of leaving the UI silently stuck forever. Clears the
 *  timer once the race settles so it doesn't linger for the full duration. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function linkOrSignInApple(auth: Auth, current: User, credential: AuthCredential): Promise<User> {
  try {
    return (await linkWithCredential(current, credential)).user;
  } catch (e: unknown) {
    // The Apple account is already registered — sign into it directly.
    if ((e as { code?: string }).code === 'auth/credential-already-in-use') {
      return (await signInWithCredential(auth, credential)).user;
    }
    throw e;
  }
}

/**
 * Sign in with Apple — iOS only. Apple's native AuthenticationServices sheet
 * has no counterpart on Android/web, and Apple requires this option only for
 * iOS apps that offer other third-party sign-in (App Store guideline 4.8).
 *
 * Unlike signInGoogle/signInFacebook, an email collision with an existing
 * Google/Facebook account is not auto-linked here (just surfaced as a normal
 * thrown error): Apple's private-relay email rarely matches the other
 * provider's real address, so that recovery path isn't worth building for
 * this rare case.
 */
export async function signInApple(): Promise<User | null> {
  if (Platform.OS !== 'ios') return null;
  // Lazy require — see nativeSocialSignIn above for why.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const oauth = require('./nativeOAuth') as typeof import('./nativeOAuth');
  const auth = getFirebaseAuth();
  const result = await oauth.acquireAppleCredential();
  if (!result) return null; // user cancelled
  const { credential, fullName } = result;

  const current = auth.currentUser;
  const exchange = current?.isAnonymous
    ? linkOrSignInApple(auth, current, credential)
    : signInWithCredential(auth, credential).then((r) => r.user);
  const user = await withTimeout(exchange, 15000, 'Apple sign-in timed out talking to Firebase.');

  // Apple only returns the user's name on their very first authorization, and
  // the identity token itself carries no name claim, so Firebase never sets
  // displayName on its own — set it here while we still have it.
  if (!user.displayName && (fullName?.givenName || fullName?.familyName)) {
    const displayName = [fullName.givenName, fullName.familyName].filter(Boolean).join(' ');
    await updateProfile(user, { displayName }).catch((e) => console.warn('apple displayName update failed:', e));
  }
  return user;
}

export async function signOut(): Promise<void> {
  await fbSignOut(getFirebaseAuth());
}

/**
 * Permanently deletes the signed-in user's RTDB profile and Auth account, via
 * the `deleteaccount` callable (see functions/index.js). Deletion runs
 * server-side with the Admin SDK specifically to avoid the client Auth SDK's
 * own deleteUser(), which throws auth/requires-recent-login on any session
 * older than a few minutes — a check anonymous/guest accounts can never
 * satisfy (no credential to re-present) and that otherwise forces a
 * sign-out/sign-in round trip even for social accounts. The callable only
 * needs a valid ID token, not a recent one, so this works regardless of
 * session age.
 *
 * The Auth SDK doesn't notice its own user was deleted server-side until its
 * next token refresh, so sign out locally right after to reflect it
 * immediately (matching what deleteUser() used to do synchronously).
 */
export async function deleteAccount(): Promise<void> {
  const current = getFirebaseAuth().currentUser;
  if (!current) return;
  const call = httpsCallable(getFirebaseFunctions(), 'deleteaccount');
  await call();
  await fbSignOut(getFirebaseAuth()).catch(() => {});
}

export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), callback);
}

// ─── Profile sync ─────────────────────────────────────────────────────────────

export async function fetchRemoteProfile(uid: string): Promise<unknown | null> {
  try {
    const dbRef = ref(getFirebaseDb(), `/users/${uid}`);
    const snap = await dbGet(dbRef);
    return snap.val();
  } catch {
    return null;
  }
}

export async function pushProfile(uid: string, profile: unknown): Promise<void> {
  try {
    await set(ref(getFirebaseDb(), `/users/${uid}`), profile);
  } catch (e) {
    console.error('pushProfile error:', e);
  }
}

/**
 * Pushes the full local profile store up to /users/{uid} for whichever user
 * is currently signed in. No-op for anonymous guests (and when signed out) —
 * guest progress deliberately stays local-only until they upgrade to a real
 * account (see app/(app)/_layout.tsx's onAuthChange handler).
 *
 * This is the single source of truth for what "the synced profile" contains —
 * every call site (auth sign-in, a PvP match ending, a streak update, a daily
 * quiz completing, a nickname/theme/language change) should push through here
 * rather than hand-building the payload, so profileStore.syncTo()'s merge
 * logic always has a matching field to read back.
 */
export interface PublicStats {
  name?: string;
  score: number;
  streak: number;
  level: number;
  country?: string;
  // 30-juz coverage snapshot (see models/juzMap.ts) — lets a friend's row on
  // the /friends screen open a read-only view of this user's progression
  // map. Gated by the same friends-only .read rule as the rest of publicStats.
  juzMap?: PublicJuzMap;
}

/**
 * Pushes public leaderboard stats ({ name, score, streak, level, country,
 * juzMap }) to /publicStats/{uid}. No-op for anonymous guests and signed-out
 * users.
 */
export async function pushPublicStats(): Promise<void> {
  try {
    const user = getFirebaseAuth().currentUser;
    if (!user || user.isAnonymous) return;
    const s = useProfileStore.getState();
    const juzMap = encodePublicJuzMap(
      computeJuzMap(s.parts, (i) => tierFromRatioRange(s.getCorrectRatioRange(i))),
    );
    const raw: Record<string, unknown> = {
      name: s.social.displayName || undefined,
      score: s.getScore(),
      streak: s.streak,
      level: s.level,
      country: s.country ? s.country : undefined,
      juzMap,
    };
    for (const key of Object.keys(raw)) {
      if (raw[key] === undefined) delete raw[key];
    }
    await set(ref(getFirebaseDb(), `/publicStats/${user.uid}`), raw);
  } catch (e) {
    console.error('pushPublicStats error:', e);
  }
}

export async function pushCurrentProfile(): Promise<void> {
  const user = getFirebaseAuth().currentUser;
  if (!user || user.isAnonymous) return;
  const s = useProfileStore.getState();
  await pushProfile(user.uid, {
    uid: s.uid,
    lastSeed: s.lastSeed,
    lastUpdate: s.lastUpdate,
    lastSync: Date.now(),
    level: s.level,
    specialEnabled: s.specialEnabled,
    scores: s.scores,
    parts: s.parts,
    streak: s.streak,
    bestStreak: s.bestStreak,
    lastPlayDate: s.lastPlayDate,
    lastDailyCompletedDate: s.lastDailyCompletedDate,
    lastDailyScore: s.lastDailyScore,
    pvp: s.pvp,
    themeMode: s.themeMode,
    language: s.language,
    // Only the editable nickname, not the whole social object — uid/photoURL/
    // email/isAnonymous are already authoritative from Firebase Auth itself,
    // and re-mirroring them into RTDB risks a stale copy overwriting Auth's
    // current values on some other device's next syncTo().
    social: { displayName: s.social.displayName },
  });
  await pushPublicStats();
}

export async function savePushToken(
  uid: string,
  token: string,
  platform: string,
  tz: string,
  lang?: string,
): Promise<void> {
  try {
    const language = lang ?? useProfileStore.getState().language;
    await set(ref(getFirebaseDb(), `/pushTokens/${uid}`), {
      token,
      platform,
      tz,
      lang: language,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.error('savePushToken error:', e);
  }
}

// ─── Daily quiz ───────────────────────────────────────────────────────────────

export interface DailyHead {
  daily_random: number;
  start_time: number;
  submit_to_ref: string;
  yesterday: string;
}

export async function getDailyHead(): Promise<DailyHead | null> {
  try {
    const snap = await dbGet(ref(getFirebaseDb(), '/daily/head'));
    return snap.val() as DailyHead | null;
  } catch (e) {
    console.error('getDailyHead error:', e);
    return null;
  }
}

export async function submitDailyResult(score: {
  score: number;
  name: string;
  country?: string;
  city?: string;
  uid: string;
}): Promise<boolean> {
  try {
    const head = await getDailyHead();
    if (!head) return false;
    // Same undefined-value hazard as joinPvpQueue/writeMyPvpState — country
    // (geo-detection may not have resolved yet) is frequently absent, and the
    // RTDB SDK throws synchronously on any undefined nested value, which was
    // silently and *permanently* failing the submission (retries hit the same
    // undefined every time — no amount of network reliability fixes this).
    const clean: Record<string, unknown> = { ...score };
    for (const key of Object.keys(clean)) {
      if (clean[key] === undefined) delete clean[key];
    }
    await push(ref(getFirebaseDb(), `/daily/${head.submit_to_ref}`), clean);
    return true;
  } catch (e) {
    console.error('submitDailyResult error:', e);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Same as submitDailyResult, but retries a few times with backoff — covers a
 * transient network blip or RTDB hiccup right as the daily quiz ends, so a
 * completed quiz isn't silently dropped from today's standings. Callers
 * should still handle a final `false` (e.g. queue it for a later retry).
 */
export async function submitDailyResultWithRetry(
  score: { score: number; name: string; country?: string; city?: string; uid: string },
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await submitDailyResult(score)) return true;
    if (i < attempts - 1) await delay(1000 * (i + 1));
  }
  return false;
}

/**
 * Retries a daily-quiz submission that didn't confirm the first time (see
 * endDailyQuiz in quiz.tsx) — called opportunistically on app start and on
 * the quiz screen's daily-quiz check. A single attempt per call is enough
 * since those are already recurring retry points; only marks the quiz
 * completed once the write is actually confirmed.
 */
export async function flushPendingDailySubmit(): Promise<void> {
  const profile = useProfileStore.getState();
  const pending = profile.pendingDailySubmit;
  if (!pending) return;
  const today = new Date().toISOString().split('T')[0];
  if (pending.date !== today) {
    // The day has rotated — resubmitting now would land in the wrong
    // cohort, so the score is lost rather than corrupting today's board.
    profile.setPendingDailySubmit(null);
    return;
  }
  const ok = await submitDailyResultWithRetry({
    score: pending.score, name: pending.name, uid: pending.uid, country: pending.country,
  }, 1);
  if (ok) {
    profile.markDailyCompleted(pending.score);
    profile.setPendingDailySubmit(null);
    void pushCurrentProfile();
  }
}

export async function getYesterdayReport(): Promise<unknown[]> {
  try {
    const head = await getDailyHead();
    const path = head?.yesterday ?? '/daily/reports/yday';
    const snap = await dbGet(ref(getFirebaseDb(), path.startsWith('/') ? path : `/daily/${path}`));
    return (snap.val() as unknown[]) ?? [];
  } catch {
    return [];
  }
}

// Top 10 for the current calendar month — the Cloud Function (functions/index.js)
// resets this automatically on the first daily rotation of a new month.
export async function getMonthlyTopReport(): Promise<unknown[]> {
  try {
    const snap = await dbGet(ref(getFirebaseDb(), '/daily/reports/month'));
    return (snap.val() as unknown[]) ?? [];
  } catch {
    return [];
  }
}

export interface LeaderboardEntry { name?: string; score: number; uid?: string; country?: string; days?: number }

/**
 * Live top-10-of-yesterday feed (was a one-time getYesterdayReport() read).
 * Resolves the (rarely-changing) target path once via getDailyHead(), then
 * wires an onValue listener to it. Returns an unsubscribe function.
 */
export async function subscribeYesterdayReport(
  cb: (entries: LeaderboardEntry[]) => void,
): Promise<() => void> {
  const head = await getDailyHead();
  const path = head?.yesterday ?? '/daily/reports/yday';
  const fullPath = path.startsWith('/') ? path : `/daily/${path}`;
  return onValue(
    ref(getFirebaseDb(), fullPath),
    (snap) => cb((snap.val() as LeaderboardEntry[]) ?? []),
    () => cb([]),
  );
}

/**
 * Live this-month standings: cumulative per-uid totals (score summed over the
 * user's best daily submission each day, plus a days-played count), sorted
 * best-first and unbounded — full coverage, so own-rank works like اليوم.
 * Falls back to the legacy top-10 array at reports/month when the totals node
 * doesn't exist yet (the first post-deploy cron run hasn't happened).
 */
export function subscribeMonthlyTopReport(cb: (entries: LeaderboardEntry[]) => void): () => void {
  return onValue(
    ref(getFirebaseDb(), '/daily/reports/month_totals'),
    (snap) => {
      const val = snap.val() as Record<string, LeaderboardEntry> | null;
      if (val) {
        const list = Object.values(val);
        list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        cb(list);
        return;
      }
      dbGet(ref(getFirebaseDb(), '/daily/reports/month'))
        .then((legacy) => cb((legacy.val() as LeaderboardEntry[]) ?? []))
        .catch(() => cb([]));
    },
    () => cb([]),
  );
}

/**
 * Live feed of *today's* in-progress submissions (unbounded — every entry
 * submitted so far today, not just a top-N slice), sorted best-first. This is
 * the only endpoint with full participant coverage, so it's what powers the
 * "your rank + neighbors" view even when the user is outside the top 10.
 */
export function subscribeTodayStandings(cb: (entries: LeaderboardEntry[]) => void): () => void {
  return onValue(
    ref(getFirebaseDb(), '/daily/head_submit'),
    (snap) => {
      const val = snap.val() as Record<string, LeaderboardEntry> | null;
      const list = val ? Object.values(val) : [];
      list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      cb(list);
    },
    () => cb([]),
  );
}

/** One-shot read of today's live standings — see subscribeTodayStandings. */
export async function getTodayStandings(): Promise<LeaderboardEntry[]> {
  try {
    const snap = await dbGet(ref(getFirebaseDb(), '/daily/head_submit'));
    const val = snap.val() as Record<string, LeaderboardEntry> | null;
    const list = val ? Object.values(val) : [];
    list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return list;
  } catch {
    return [];
  }
}

export async function reportQuestion(card: unknown): Promise<void> {
  try {
    await push(ref(getFirebaseDb(), '/reports/'), { q: card });
  } catch (e) {
    console.error('reportQuestion error:', e);
  }
}

// ─── PvP live matchmaking ─────────────────────────────────────────────────────
//
// Client-driven matchmaking + live match sync over RTDB — see pvpService.ts for
// the plain data shapes and compatibility/claim rules; this module only does the
// reads/writes. Setup calls (join/claim/create/presence) intentionally let errors
// propagate so pvp.tsx can react (e.g. fall back to the bot); only best-effort
// cleanup/race paths swallow them.

const pvpQueueRef = (uid: string) => ref(getFirebaseDb(), `/pvp/queue/${uid}`);
const pvpMatchMetaRef = (matchId: string) => ref(getFirebaseDb(), `/pvp/matches/${matchId}/meta`);
const pvpMatchPlayerRef = (matchId: string, uid: string) =>
  ref(getFirebaseDb(), `/pvp/matches/${matchId}/players/${uid}`);
const pvpMatchResultRef = (matchId: string) => ref(getFirebaseDb(), `/pvp/matches/${matchId}/result`);

/** Join the matchmaking queue as `uid`, arming auto-cleanup if this client
 *  disconnects mid-search (app kill, tab close, network loss). Returns the `ts`
 *  written (plain client clock — the anti-race claim rule only needs rough
 *  ordering, tolerant of a couple seconds of skew, so a round trip through
 *  serverTimestamp() isn't worth the extra async step for callers). */
export async function joinPvpQueue(
  uid: string,
  entry: Omit<PvpQueueEntry, 'ts' | 'matchId'>,
): Promise<number> {
  const r = pvpQueueRef(uid);
  const ts = Date.now();
  await onDisconnect(r).remove();
  // Optional fields (photoURL/country) are frequently absent — e.g. guest
  // accounts have no photoURL, and geo-detection may not have resolved yet.
  // The RTDB SDK throws synchronously if `set()` is given any `undefined`
  // nested value, which was silently aborting the whole 15s search.
  const payload: Record<string, unknown> = { ...entry, ts, matchId: null };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  await set(r, payload);
  return ts;
}

export async function leavePvpQueue(uid: string): Promise<void> {
  try {
    await onDisconnect(pvpQueueRef(uid)).cancel();
    await remove(pvpQueueRef(uid));
  } catch (e) {
    console.error('leavePvpQueue error:', e);
  }
}

/** Live view of the whole queue, keyed by uid. Returns an unsubscribe fn. */
export function watchPvpQueue(cb: (entries: Record<string, PvpQueueEntry>) => void): () => void {
  return onValue(ref(getFirebaseDb(), '/pvp/queue'), (snap) => {
    cb((snap.val() as Record<string, PvpQueueEntry>) ?? {});
  });
}

/** Watch my own queue entry, to notice when another client claims me
 *  (writes a matchId onto it). */
export function watchOwnQueueEntry(uid: string, cb: (entry: PvpQueueEntry | null) => void): () => void {
  return onValue(pvpQueueRef(uid), (snap) => cb(snap.val() as PvpQueueEntry | null));
}

/** Anti-race claim: succeeds only if the candidate's matchId is still null.
 *  Returns true if this client won the claim. */
export async function claimMatch(candidateUid: string, matchId: string): Promise<boolean> {
  const result = await runTransaction(
    ref(getFirebaseDb(), `/pvp/queue/${candidateUid}/matchId`),
    (current) => (current === null ? matchId : undefined),
  );
  return result.committed;
}

export async function createPvpMatch(matchId: string, meta: PvpMatchMeta): Promise<void> {
  await set(pvpMatchMetaRef(matchId), meta);
}

export async function getPvpMatchMeta(matchId: string): Promise<PvpMatchMeta | null> {
  const snap = await dbGet(pvpMatchMetaRef(matchId));
  return (snap.val() as PvpMatchMeta | null) ?? null;
}

/** Arm match presence for `uid`: mark connected, and have the server flip it back
 *  (with a timestamp) if this client drops without cleaning up. */
export async function armPvpPresence(matchId: string, uid: string): Promise<void> {
  const connectedRef = ref(getFirebaseDb(), `/pvp/matches/${matchId}/players/${uid}/connected`);
  const lastSeenRef = ref(getFirebaseDb(), `/pvp/matches/${matchId}/players/${uid}/lastSeen`);
  await onDisconnect(connectedRef).set(false);
  await onDisconnect(lastSeenRef).set(serverTimestamp());
  await set(connectedRef, true);
}

export function watchPvpPlayer(
  matchId: string,
  uid: string,
  cb: (state: PvpPlayerState | null) => void,
): () => void {
  return onValue(pvpMatchPlayerRef(matchId, uid), (snap) => cb(snap.val() as PvpPlayerState | null));
}

export async function writeMyPvpState(
  matchId: string,
  uid: string,
  patch: Partial<PvpPlayerState>,
): Promise<void> {
  // Same undefined-value hazard as joinPvpQueue — strip before writing.
  const clean: Record<string, unknown> = { ...patch };
  for (const key of Object.keys(clean)) {
    if (clean[key] === undefined) delete clean[key];
  }
  await update(pvpMatchPlayerRef(matchId, uid), clean);
}

/** Best-effort, write-once: if the opponent's result already landed, the security
 *  rule rejects this write and we silently accept theirs instead. */
export async function writePvpResult(matchId: string, result: PvpMatchResult): Promise<void> {
  try {
    await set(pvpMatchResultRef(matchId), result);
  } catch {
    // Opponent's result already landed first — expected race outcome, not an error.
  }
}

export function watchPvpResult(matchId: string, cb: (result: PvpMatchResult | null) => void): () => void {
  return onValue(pvpMatchResultRef(matchId), (snap) => cb(snap.val() as PvpMatchResult | null));
}

// ─── Quiz Codes & Friends ───────────────────────────────────────────────────

export interface FriendRequestEntry {
  ts: number;
  fromName: string;
  fromPhotoURL?: string;
}

export interface FriendEntry {
  since: number;
  name?: string;
  photoURL?: string;
}

/**
 * Computes and registers a deterministic Quiz Code for a signed-in profile.
 * Performs a best-effort write to `/quizCodes/{code}`.
 */
export async function registerQuizCode(uid: string): Promise<string> {
  const code = quizCodeOf(uid);
  try {
    await set(ref(getFirebaseDb(), `/quizCodes/${code}`), uid);
  } catch (e) {
    console.error('registerQuizCode error:', e);
  }
  return code;
}

/**
 * Resolves a Quiz Code to a target user UID. Returns null if not found.
 */
export async function resolveQuizCode(code: string): Promise<string | null> {
  try {
    const snap = await dbGet(ref(getFirebaseDb(), `/quizCodes/${code.toUpperCase()}`));
    return (snap.val() as string) ?? null;
  } catch (e) {
    console.error('resolveQuizCode error:', e);
    return null;
  }
}

/**
 * Writes a friend request to `/friendRequests/{targetUid}/{myUid}` using
 * my own profile display fields.
 */
export async function sendFriendRequest(
  targetUid: string,
  myUid: string,
  fromName: string,
  fromPhotoURL?: string,
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      fromName,
    };
    if (fromPhotoURL) payload.fromPhotoURL = fromPhotoURL;
    await set(ref(getFirebaseDb(), `/friendRequests/${targetUid}/${myUid}`), payload);
    return true;
  } catch (e) {
    console.error('sendFriendRequest error:', e);
    return false;
  }
}

/**
 * Listens for incoming friend requests at `/friendRequests/{myUid}`.
 */
export function watchFriendRequests(
  myUid: string,
  cb: (requests: Record<string, FriendRequestEntry>) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/friendRequests/${myUid}`), (snap) => {
    cb((snap.val() as Record<string, FriendRequestEntry>) ?? {});
  });
}

/**
 * Accepts an incoming friend request from `fromUid`.
 *
 * CRITICAL WRITE ORDER REQUIRED BY RTDB RULES:
 * (a) write /friends/{fromUid}/{myUid} FIRST (their side of mirror; only writable while pending request exists)
 * (b) write /friends/{myUid}/{fromUid} (my own side)
 * (c) remove /friendRequests/{myUid}/{fromUid}
 */
export async function acceptFriendRequest(
  fromUid: string,
  myUid: string,
  myName: string,
  myPhotoURL?: string,
  fromName?: string,
  fromPhotoURL?: string,
): Promise<boolean> {
  try {
    const dbInstance = getFirebaseDb();
    const now = Date.now();

    // (a) Write to /friends/{fromUid}/{myUid} FIRST
    const targetFriendPayload: Record<string, unknown> = { since: now, name: myName };
    if (myPhotoURL) targetFriendPayload.photoURL = myPhotoURL;
    await set(ref(dbInstance, `/friends/${fromUid}/${myUid}`), targetFriendPayload);

    // (b) Write to /friends/{myUid}/{fromUid}
    const myFriendPayload: Record<string, unknown> = { since: now };
    if (fromName) myFriendPayload.name = fromName;
    if (fromPhotoURL) myFriendPayload.photoURL = fromPhotoURL;
    await set(ref(dbInstance, `/friends/${myUid}/${fromUid}`), myFriendPayload);

    // (c) Remove /friendRequests/{myUid}/{fromUid}
    await remove(ref(dbInstance, `/friendRequests/${myUid}/${fromUid}`));

    return true;
  } catch (e) {
    console.error('acceptFriendRequest error:', e);
    return false;
  }
}

/**
 * Declines an incoming friend request by removing `/friendRequests/{myUid}/{fromUid}`.
 */
export async function declineFriendRequest(fromUid: string, myUid: string): Promise<boolean> {
  try {
    await remove(ref(getFirebaseDb(), `/friendRequests/${myUid}/${fromUid}`));
    return true;
  } catch (e) {
    console.error('declineFriendRequest error:', e);
    return false;
  }
}

/**
 * Removes a mutual friendship: deletes both `/friends/{myUid}/{otherUid}` and
 * `/friends/{otherUid}/{myUid}`. Unlike acceptFriendRequest, write order
 * doesn't matter here — the RTDB rule lets each side delete its own mirror
 * entry unconditionally, so a partial failure (e.g. offline mid-call) just
 * leaves the other side to clean up next time either of them opens the list.
 */
export async function removeFriend(myUid: string, otherUid: string): Promise<boolean> {
  try {
    const dbInstance = getFirebaseDb();
    await remove(ref(dbInstance, `/friends/${myUid}/${otherUid}`));
    await remove(ref(dbInstance, `/friends/${otherUid}/${myUid}`));
    return true;
  } catch (e) {
    console.error('removeFriend error:', e);
    return false;
  }
}

/**
 * Listens for active friends at `/friends/{myUid}`.
 */
export function watchFriends(
  myUid: string,
  cb: (friends: Record<string, FriendEntry>) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/friends/${myUid}`), (snap) => {
    cb((snap.val() as Record<string, FriendEntry>) ?? {});
  });
}

// ─── PvP Invites ─────────────────────────────────────────────────────────────

export interface PvpInviteEntry {
  ts?: number;
  status: 'pending' | 'accepted';
  level?: number;
  scope?: MatchScopePart[];
  fromName?: string;
  fromPhotoURL?: string;
  matchId?: string;
}

export async function sendPvpInvite(
  recipientUid: string,
  myUid: string,
  myName: string,
  myPhotoURL: string | undefined,
  level: number,
  scope: MatchScopePart[],
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      status: 'pending',
      level,
      scope,
      fromName: myName,
    };
    if (myPhotoURL) payload.fromPhotoURL = myPhotoURL;
    await set(ref(getFirebaseDb(), `/pvp/invites/${recipientUid}/${myUid}`), payload);
    return true;
  } catch (e) {
    console.error('sendPvpInvite error:', e);
    return false;
  }
}

export function watchPvpInvite(
  recipientUid: string,
  fromUid: string,
  cb: (invite: PvpInviteEntry | null) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/pvp/invites/${recipientUid}/${fromUid}`), (snap) => {
    cb((snap.val() as PvpInviteEntry | null) ?? null);
  });
}

export function watchIncomingPvpInvites(
  myUid: string,
  cb: (invites: Record<string, PvpInviteEntry>) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/pvp/invites/${myUid}`), (snap) => {
    cb((snap.val() as Record<string, PvpInviteEntry>) ?? {});
  });
}

export async function acceptPvpInvite(
  recipientUid: string,
  fromUid: string,
  matchId: string,
): Promise<boolean> {
  try {
    await set(ref(getFirebaseDb(), `/pvp/invites/${recipientUid}/${fromUid}`), {
      status: 'accepted',
      matchId,
    });
    return true;
  } catch (e) {
    console.error('acceptPvpInvite error:', e);
    return false;
  }
}

export async function declinePvpInvite(recipientUid: string, fromUid: string): Promise<boolean> {
  try {
    await remove(ref(getFirebaseDb(), `/pvp/invites/${recipientUid}/${fromUid}`));
    return true;
  } catch (e) {
    console.error('declinePvpInvite error:', e);
    return false;
  }
}

// ─── Presence ────────────────────────────────────────────────────────────────

export interface PresenceState {
  online?: boolean;
  lastSeen?: number;
}

/**
 * Called from the auth-state listener right as a user signs in, which can
 * race the RTDB socket's own auth handshake (it re-authenticates off a
 * separate internal token listener a beat behind `onAuthStateChanged`,
 * especially right after `signInWithCredential` swaps in a different uid).
 * That shows up as a transient PERMISSION_DENIED on the very first write, so
 * one retry after a short delay is given before treating it as a real error.
 */
export async function armPresence(uid: string, attempts = 2): Promise<void> {
  const presenceRef = ref(getFirebaseDb(), `/presence/${uid}`);
  for (let i = 0; i < attempts; i++) {
    try {
      await onDisconnect(presenceRef).set({
        online: false,
        lastSeen: serverTimestamp(),
      });
      await set(presenceRef, {
        online: true,
        lastSeen: serverTimestamp(),
      });
      return;
    } catch (e) {
      if (i < attempts - 1) {
        await delay(800);
        continue;
      }
      console.error('armPresence error:', e);
    }
  }
}

export function watchPresence(
  uid: string,
  cb: (state: PresenceState | null) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/presence/${uid}`), (snap) => {
    cb((snap.val() as PresenceState | null) ?? null);
  });
}

export function watchPublicStats(
  uid: string,
  cb: (stats: PublicStats | null) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/publicStats/${uid}`), (snap) => {
    cb((snap.val() as PublicStats | null) ?? null);
  });
}

// ─── Notification Preferences ────────────────────────────────────────────────

export type NotifCategory = 'invites' | 'friendRequests' | 'streakAlerts' | 'dailyReady' | 'friendActivity';

export type NotifPrefs = Record<NotifCategory, boolean>;

export async function getNotifPrefs(uid: string): Promise<NotifPrefs> {
  try {
    const snap = await dbGet(ref(getFirebaseDb(), `/notifPrefs/${uid}`));
    const val = snap.val() as Record<string, boolean> | null;
    return {
      invites: val?.invites !== false,
      friendRequests: val?.friendRequests !== false,
      streakAlerts: val?.streakAlerts !== false,
      dailyReady: val?.dailyReady !== false,
      friendActivity: val?.friendActivity !== false,
    };
  } catch (e) {
    console.error('getNotifPrefs error:', e);
    return { invites: true, friendRequests: true, streakAlerts: true, dailyReady: true, friendActivity: true };
  }
}

export async function setNotifPref(
  uid: string,
  category: NotifCategory,
  enabled: boolean,
): Promise<void> {
  try {
    await set(ref(getFirebaseDb(), `/notifPrefs/${uid}/${category}`), enabled);
  } catch (e) {
    console.error('setNotifPref error:', e);
  }
}

export function watchNotifPrefs(
  uid: string,
  cb: (prefs: NotifPrefs) => void,
): () => void {
  return onValue(ref(getFirebaseDb(), `/notifPrefs/${uid}`), (snap) => {
    const val = snap.val() as Record<string, boolean> | null;
    cb({
      invites: val?.invites !== false,
      friendRequests: val?.friendRequests !== false,
      streakAlerts: val?.streakAlerts !== false,
      dailyReady: val?.dailyReady !== false,
      friendActivity: val?.friendActivity !== false,
    });
  });
}



