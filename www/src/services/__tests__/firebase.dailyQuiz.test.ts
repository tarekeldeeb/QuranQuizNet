// Regression test for the daily-quiz "silently never uploaded" bug: the RTDB
// SDK throws *synchronously* on any undefined nested value passed to push()/
// set() — country (async IP geo-lookup, frequently not resolved yet) was
// occasionally undefined, which failed the write client-side, before any
// network call, identically on every retry. See project-daily-quiz-undefined-
// write-bug memory. submitDailyResult() now strips undefined keys first,
// matching the same hazard already handled in joinPvpQueue/writeMyPvpState.

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => [{}]),
  getApp: jest.fn(() => ({})),
}));

const mockPush = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockGet = jest.fn();
const mockRef = jest.fn((_db: unknown, path: string) => ({ path }));
jest.mock('firebase/database', () => ({
  getDatabase: jest.fn(() => ({})),
  ref: (db: unknown, path: string) => mockRef(db, path),
  push: (...a: unknown[]) => mockPush(...a),
  get: (...a: unknown[]) => mockGet(...a),
  set: jest.fn(),
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

jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({ currentUser: null })),
  initializeAuth: jest.fn(() => ({ currentUser: null })),
  onAuthStateChanged: jest.fn(),
  signInAnonymously: jest.fn(),
  signOut: jest.fn(),
}));

import { submitDailyResult } from '../firebase';

const DAILY_HEAD = { daily_random: 1, start_time: 0, submit_to_ref: 'head_submit', yesterday: 'reports/yday' };

beforeEach(() => {
  mockPush.mockClear();
  mockGet.mockClear();
  mockGet.mockResolvedValue({ val: () => DAILY_HEAD });
});

describe('submitDailyResult()', () => {
  it('strips an undefined country before pushing, instead of letting the SDK throw on it', async () => {
    const ok = await submitDailyResult({ score: 88, name: 'Sam', uid: 'u1', country: undefined });

    expect(ok).toBe(true);
    expect(mockRef).toHaveBeenCalledWith(expect.anything(), '/daily/head_submit');
    const payload = mockPush.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ score: 88, name: 'Sam', uid: 'u1' });
    expect('country' in payload).toBe(false);
  });

  it('still writes a provided country/city normally', async () => {
    const ok = await submitDailyResult({ score: 50, name: 'Sam', uid: 'u1', country: 'eg', city: 'Cairo' });

    expect(ok).toBe(true);
    const payload = mockPush.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ score: 50, name: 'Sam', uid: 'u1', country: 'eg', city: 'Cairo' });
  });

  it('returns false instead of throwing when the write itself fails', async () => {
    mockPush.mockImplementationOnce(() => { throw new Error('push failed'); });

    const ok = await submitDailyResult({ score: 10, name: 'Sam', uid: 'u1' });

    expect(ok).toBe(false);
  });

  it('returns false without attempting a push when the daily head is unavailable', async () => {
    mockGet.mockResolvedValue({ val: () => null });

    const ok = await submitDailyResult({ score: 10, name: 'Sam', uid: 'u1' });

    expect(ok).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
