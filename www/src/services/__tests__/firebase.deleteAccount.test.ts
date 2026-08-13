// Regression coverage for the account-deletion loop bug: deleteAccount() used
// to call the client Auth SDK's own deleteUser(), which throws
// auth/requires-recent-login on any session older than a few minutes — a
// check anonymous/guest accounts can never satisfy (no credential to
// re-present) and that otherwise forced a sign-out/sign-in round trip for
// social accounts too, without ever actually completing. Deletion now runs
// server-side via the `deleteaccount` callable (functions/index.js), which
// only needs a valid ID token, not a recent one.
jest.mock('react-native', () => ({ Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default } }));

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => [{}]),
  getApp: jest.fn(() => ({})),
}));

jest.mock('firebase/database', () => ({
  getDatabase: jest.fn(() => ({})),
}));

jest.mock('firebase/functions', () => ({
  getFunctions: jest.fn(() => ({})),
  httpsCallable: jest.fn(),
}));

jest.mock('firebase/auth', () => {
  const authState = { currentUser: null as null | { uid: string } };
  return {
    __authState: authState,
    getAuth: jest.fn(() => authState),
    onAuthStateChanged: jest.fn(),
    signOut: jest.fn(() => Promise.resolve()),
  };
});

import * as fbFunctions from 'firebase/functions';
import * as fbAuth from 'firebase/auth';
import { deleteAccount } from '../firebase';

const mFns = fbFunctions as unknown as { httpsCallable: jest.Mock };
const mAuth = fbAuth as unknown as {
  __authState: { currentUser: null | { uid: string } };
  signOut: jest.Mock;
};

beforeEach(() => {
  mAuth.__authState.currentUser = null;
  mAuth.signOut.mockClear();
  mFns.httpsCallable.mockReset();
});

describe('deleteAccount — server-side deletion, no recent-login requirement', () => {
  it('calls the deleteaccount callable and signs out locally on success', async () => {
    mAuth.__authState.currentUser = { uid: 'u1' };
    const callable = jest.fn(() => Promise.resolve());
    mFns.httpsCallable.mockReturnValue(callable);

    await deleteAccount();

    expect(mFns.httpsCallable).toHaveBeenCalledWith(expect.anything(), 'deleteaccount');
    expect(callable).toHaveBeenCalledTimes(1);
    expect(mAuth.signOut).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no one is signed in', async () => {
    mAuth.__authState.currentUser = null;

    await deleteAccount();

    expect(mFns.httpsCallable).not.toHaveBeenCalled();
    expect(mAuth.signOut).not.toHaveBeenCalled();
  });

  it('propagates a callable failure and does not sign out', async () => {
    mAuth.__authState.currentUser = { uid: 'u1' };
    const callable = jest.fn(() => Promise.reject(new Error('internal')));
    mFns.httpsCallable.mockReturnValue(callable);

    await expect(deleteAccount()).rejects.toThrow('internal');
    expect(mAuth.signOut).not.toHaveBeenCalled();
  });
});
