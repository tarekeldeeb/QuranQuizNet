// pushCurrentProfile() is the single place that builds the payload written to
// /users/{uid} — every "push after X" call site (auth sign-in, PvP match end,
// streak update, daily quiz completion, theme/language change) goes through
// it. This covers its two contracts: it no-ops for anonymous/signed-out users
// (guest progress stays local-only — see app/(app)/_layout.tsx), and for a
// real account it writes the full synced-field surface profileStore.syncTo()
// expects to read back on a second device.

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => [{}]),
  getApp: jest.fn(() => ({})),
}));

const mockSet = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockRef = jest.fn((_db: unknown, path: string) => ({ path }));
jest.mock('firebase/database', () => ({
  getDatabase: jest.fn(() => ({})),
  ref: (db: unknown, path: string) => mockRef(db, path),
  set: (...a: unknown[]) => mockSet(...a),
  push: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  onValue: jest.fn(),
  onDisconnect: jest.fn(() => ({ remove: jest.fn(), set: jest.fn(), cancel: jest.fn() })),
  runTransaction: jest.fn(),
  serverTimestamp: jest.fn(),
}));

jest.mock('firebase/functions', () => ({
  getFunctions: jest.fn(() => ({})),
  httpsCallable: jest.fn(),
}));

jest.mock('firebase/auth', () => {
  const authState = { currentUser: null as null | { uid: string; isAnonymous: boolean } };
  return {
    __authState: authState,
    getAuth: jest.fn(() => authState),
    initializeAuth: jest.fn(() => authState),
    onAuthStateChanged: jest.fn(),
    signInAnonymously: jest.fn(),
    signOut: jest.fn(),
  };
});

import * as fbAuth from 'firebase/auth';
import { pushCurrentProfile } from '../firebase';
import { useProfileStore, type ProfileState } from '../../stores/profileStore';

const m = fbAuth as unknown as { __authState: { currentUser: null | { uid: string; isAnonymous: boolean } } };

beforeEach(() => {
  mockSet.mockClear();
  mockRef.mockClear();
  m.__authState.currentUser = null;
  useProfileStore.setState({
    uid: 'u1',
    lastSeed: 42,
    lastUpdate: 123,
    level: 2,
    specialEnabled: true,
    scores: [{ date: 1, score: 10 }],
    parts: [],
    streak: 5,
    bestStreak: 8,
    lastPlayDate: '2026-07-26',
    lastDailyCompletedDate: '2026-07-26',
    lastDailyScore: 77,
    pvp: { wins: 2, losses: 1, draws: 0, points: 30, winStreak: 1, streakFreezeTokens: 0 },
    themeMode: 'light',
    language: 'en',
    social: { uid: 'u1', displayName: 'Nickname', photoURL: 'x', email: 'a@b.com', isAnonymous: false },
  });
});

describe('pushCurrentProfile()', () => {
  it('no-ops when signed out', async () => {
    m.__authState.currentUser = null;
    await pushCurrentProfile();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('no-ops for an anonymous guest (progress stays local-only until upgrade)', async () => {
    m.__authState.currentUser = { uid: 'guest1', isAnonymous: true };
    await pushCurrentProfile();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('writes the full synced-field surface for a signed-in account, keyed by /users/{uid} and /publicStats/{uid}', async () => {
    m.__authState.currentUser = { uid: 'u1', isAnonymous: false };
    await pushCurrentProfile();

    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockRef).toHaveBeenNthCalledWith(1, expect.anything(), '/users/u1');
    expect(mockRef).toHaveBeenNthCalledWith(2, expect.anything(), '/publicStats/u1');
    const payload = mockSet.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      uid: 'u1',
      lastSeed: 42,
      level: 2,
      specialEnabled: true,
      streak: 5,
      bestStreak: 8,
      lastPlayDate: '2026-07-26',
      lastDailyCompletedDate: '2026-07-26',
      lastDailyScore: 77,
      pvp: { wins: 2, losses: 1, draws: 0, points: 30, winStreak: 1, streakFreezeTokens: 0 },
      themeMode: 'light',
      language: 'en',
      // Only the nickname — not photoURL/email/isAnonymous, which stay
      // authoritative from Firebase Auth itself (see pushCurrentProfile's
      // own comment in firebase.ts).
      social: { displayName: 'Nickname' },
    });
    expect((payload.social as Record<string, unknown>).photoURL).toBeUndefined();
    expect((payload.social as Record<string, unknown>).email).toBeUndefined();

    const publicStatsPayload = mockSet.mock.calls[1][1] as Record<string, unknown>;
    expect(publicStatsPayload).toEqual({
      name: 'Nickname',
      score: 0,
      streak: 5,
      level: 2,
      // Empty parts list here → every juz cell is outside the study plan.
      juzMap: { tiers: 'O'.repeat(30), coverage: new Array(30).fill(0) },
    });
  });
});

// ── Guardrail: every ProfileState data field must be classified ────────────
//
// This is what should have caught bestStreak/lastDailyCompletedDate/
// lastDailyScore/themeMode/language silently staying local-only for months
// (see the "Full profile cloud sync" memory) — adding a field to ProfileState
// without deciding what happens to it here is now a TypeScript compile error,
// not a silent gap that ships.
//
// Three buckets:
//  - 'synced':      pushed to Firebase AND merged back down by syncTo()'s
//                    generic `remote.x ?? local.x` (or documented custom
//                    merge) — covered by the round-trip test below.
//  - 'push-only':   written to Firebase but deliberately NOT applied the
//                    generic way (uid is the join key; lastUpdate/lastSync
//                    are meta clocks with their own special handling in
//                    syncTo) — still required in the payload, just exempt
//                    from the generic round-trip check.
//  - 'local-only':  never leaves the device. Requires a reason.

// All plain-data keys of ProfileState — every action/getter is function-typed
// and so is excluded automatically, without needing to hand-list them.
type DataKey<T> = { [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? never : K }[keyof T];
type ProfileDataKey = DataKey<ProfileState>;

type FieldStatus =
  | { kind: 'synced' }
  | { kind: 'push-only'; reason: string }
  | { kind: 'local-only'; reason: string };

// `satisfies` (not `:`) so TypeScript both (a) enforces every ProfileDataKey
// is present here, and (b) keeps each entry's literal `kind`, which the
// SyncedKey type below relies on to know which fields need round-trip fixtures.
const FIELD_STATUS = {
  uid: { kind: 'push-only', reason: 'the join key syncTo compares against; must match to sync at all, never overwritten from remote' },
  lastUpdate: { kind: 'push-only', reason: "the freshness clock itself — syncTo sets it to remote's value directly, not via the generic merge" },
  lastSync: { kind: 'push-only', reason: 'regenerated locally as Date.now() on every push/sync, never taken from remote' },

  lastSeed: { kind: 'synced' },
  level: { kind: 'synced' },
  specialEnabled: { kind: 'synced' },
  scores: { kind: 'synced' },
  parts: { kind: 'synced' },
  streak: { kind: 'synced' },
  bestStreak: { kind: 'synced' },
  lastPlayDate: { kind: 'synced' },
  lastDailyCompletedDate: { kind: 'synced' },
  lastDailyScore: { kind: 'synced' },
  pvp: { kind: 'synced' },
  themeMode: { kind: 'synced' },
  language: { kind: 'synced' },
  // Only .displayName actually round-trips (uid/photoURL/email/isAnonymous
  // stay authoritative from Firebase Auth — see pushCurrentProfile's comment).
  social: { kind: 'synced' },

  version: { kind: 'local-only', reason: 'unused legacy field, never read or mutated' },
  loaded: { kind: 'local-only', reason: 'in-memory load-state flag, meaningless across devices' },
  pendingDailySubmit: { kind: 'local-only', reason: "this device's own unconfirmed-write retry queue, not an account fact" },
  country: { kind: 'local-only', reason: 'redetected from IP on every launch, never persisted' },
  levels: { kind: 'local-only', reason: 'static levels catalog, never mutated' },
  tipIndex: { kind: 'local-only', reason: 'feature-discovery nudge cadence tied to this device\'s sessions, not an account fact — a reinstall/second device should not skip or replay tips' },
  lastTipRollDate: { kind: 'local-only', reason: 'same as tipIndex — the once-a-day roll gate is local session state' },
  pendingTipKey: { kind: 'local-only', reason: 'never persisted at all — ephemeral "currently displayed" pointer for TipBanner, meaningless outside this session' },
} satisfies Record<ProfileDataKey, FieldStatus>;

type SyncedKey = { [K in ProfileDataKey]: (typeof FIELD_STATUS)[K]['kind'] extends 'synced' ? K : never }[ProfileDataKey];

const ALL_KEYS = Object.keys(FIELD_STATUS) as ProfileDataKey[];
const PUSHED_KEYS = ALL_KEYS.filter((k) => FIELD_STATUS[k].kind !== 'local-only');
const SYNCED_KEYS = ALL_KEYS.filter((k) => FIELD_STATUS[k].kind === 'synced') as SyncedKey[];

describe('cloud-sync field coverage guardrail', () => {
  it('pushCurrentProfile writes exactly the fields classified synced/push-only', async () => {
    m.__authState.currentUser = { uid: 'u1', isAnonymous: false };
    await pushCurrentProfile();
    const payload = mockSet.mock.calls[0][1] as Record<string, unknown>;
    expect(new Set(Object.keys(payload))).toEqual(new Set(PUSHED_KEYS));
  });

  describe('syncTo() applies every field classified "synced" from a newer remote copy', () => {
    // Record<SyncedKey, unknown>: if a field is ever reclassified to 'synced'
    // without adding fixtures here, these object literals fail to compile.
    const BEFORE: Record<SyncedKey, unknown> = {
      lastSeed: 1,
      level: 0,
      specialEnabled: false,
      scores: [{ date: 1, score: 0 }],
      parts: [],
      streak: 0,
      bestStreak: 0,
      lastPlayDate: '',
      lastDailyCompletedDate: '',
      lastDailyScore: 0,
      pvp: { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 0 },
      themeMode: 'dark',
      language: 'ar',
      social: { uid: 'u1', displayName: 'Old Name', isAnonymous: false },
    };
    const AFTER: Record<SyncedKey, unknown> = {
      lastSeed: 999,
      level: 3,
      specialEnabled: true,
      scores: [{ date: 2, score: 500 }],
      parts: [{ start: 1, length: 5, numCorrect: [1, 1, 1, 1, 1], numQuestions: [1, 1, 1, 1, 1], name: 'x', checked: true }],
      streak: 9,
      bestStreak: 12,
      lastPlayDate: '2026-07-20',
      lastDailyCompletedDate: '2026-07-20',
      lastDailyScore: 88,
      pvp: { wins: 3, losses: 1, draws: 0, points: 40, winStreak: 2, streakFreezeTokens: 1 },
      themeMode: 'light',
      language: 'en',
      social: { displayName: 'New Name' },
    };

    beforeEach(async () => {
      useProfileStore.setState({ uid: 'u1', lastSync: 0, lastUpdate: 0, ...BEFORE } as Partial<ProfileState>);
      await useProfileStore.getState().syncTo({ uid: 'u1', lastUpdate: 1_000_000, ...AFTER } as Partial<ProfileState>);
    });

    // One labeled sub-test per synced field (rather than a single loop) so a
    // failure names exactly which field syncTo() forgot to read — a generic
    // "did it change at all" check, not the exact merged value: some fields
    // overwrite outright, others merge (bestStreak takes a max, social keeps
    // uid/isAnonymous local) — those exact rules are covered by
    // profileStore.lifecycle.test.ts.
    it.each(SYNCED_KEYS)('propagates "%s"', (key) => {
      const after = useProfileStore.getState()[key];
      expect(JSON.stringify(after)).not.toEqual(JSON.stringify(BEFORE[key]));
    });
  });
});
