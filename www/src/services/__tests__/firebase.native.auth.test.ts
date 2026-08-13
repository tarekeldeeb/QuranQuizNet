// Tests for the native (iOS/Android) social sign-in path in firebase.ts.
//
// On native, Firebase's popup helpers don't work, so sign-in goes through
// expo-auth-session (mocked here as ../nativeOAuth) to obtain a credential, then
// signInWithCredential / linkWithCredential. This mirrors the web flow:
//   - anonymous guest → link (fall back to sign-in if already in use)
//   - same-email collision → run the OTHER provider's flow, then link.

// Pin the platform to native so firebase.ts takes the expo-auth-session branch.
jest.mock('react-native', () => ({ Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default } }));

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => [{}]),
  getApp: jest.fn(() => ({})),
}));

jest.mock('firebase/database', () => ({
  getDatabase: jest.fn(() => ({})),
  ref: jest.fn(), set: jest.fn(), push: jest.fn(), get: jest.fn(),
}));

jest.mock('firebase/functions', () => ({
  getFunctions: jest.fn(() => ({})),
  httpsCallable: jest.fn(),
}));

jest.mock('firebase/auth', () => {
  const authState = { currentUser: null as null | { uid: string; isAnonymous: boolean } };
  class GoogleAuthProvider { setCustomParameters() { return this; } static credentialFromError = jest.fn(); }
  class FacebookAuthProvider { static credentialFromError = jest.fn(); }
  return {
    __authState: authState,
    getAuth: jest.fn(() => authState),
    onAuthStateChanged: jest.fn(),
    signInAnonymously: jest.fn(),
    signInWithPopup: jest.fn(),
    linkWithPopup: jest.fn(),
    signInWithCredential: jest.fn(),
    linkWithCredential: jest.fn(),
    updateProfile: jest.fn(),
    GoogleAuthProvider,
    FacebookAuthProvider,
    signOut: jest.fn(),
  };
});

// Mock the native OAuth module (expo-auth-session / expo-apple-authentication live behind it).
jest.mock('../nativeOAuth', () => ({ acquireCredential: jest.fn(), acquireAppleCredential: jest.fn() }));

import * as fbAuth from 'firebase/auth';
import * as nativeOAuth from '../nativeOAuth';
import { signInGoogle, signInFacebook, signInApple } from '../firebase';

const m = fbAuth as unknown as {
  __authState: { currentUser: null | { uid: string; isAnonymous: boolean } };
  signInWithCredential: jest.Mock;
  linkWithCredential: jest.Mock;
  updateProfile: jest.Mock;
};
const acquire = nativeOAuth.acquireCredential as jest.Mock;
const acquireApple = nativeOAuth.acquireAppleCredential as jest.Mock;

beforeEach(() => {
  m.__authState.currentUser = null;
  m.signInWithCredential.mockReset();
  m.linkWithCredential.mockReset();
  m.updateProfile.mockReset();
  acquire.mockReset();
  acquireApple.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('native social sign-in — fresh sign-in', () => {
  it('signs in with the acquired credential when no one is signed in', async () => {
    acquire.mockResolvedValue({ providerId: 'google.com' });
    m.signInWithCredential.mockResolvedValue({ user: { uid: 'g1' } });

    const user = await signInGoogle();

    expect(acquire).toHaveBeenCalledWith('google');
    expect(m.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(user).toEqual({ uid: 'g1' });
  });

  it('returns null (no sign-in) when the user dismisses the browser', async () => {
    acquire.mockResolvedValue(null);
    const user = await signInFacebook();
    expect(user).toBeNull();
    expect(m.signInWithCredential).not.toHaveBeenCalled();
  });
});

describe('native social sign-in — anonymous guest upgrade', () => {
  it('links the credential to preserve guest progress', async () => {
    m.__authState.currentUser = { uid: 'anon', isAnonymous: true };
    acquire.mockResolvedValue({ providerId: 'google.com' });
    m.linkWithCredential.mockResolvedValue({ user: { uid: 'anon', isAnonymous: false } });

    const user = await signInGoogle();

    expect(m.linkWithCredential).toHaveBeenCalledWith(m.__authState.currentUser, { providerId: 'google.com' });
    expect(m.signInWithCredential).not.toHaveBeenCalled();
    expect(user).toEqual({ uid: 'anon', isAnonymous: false });
  });

  it('falls back to sign-in when the social account already exists', async () => {
    m.__authState.currentUser = { uid: 'anon', isAnonymous: true };
    acquire.mockResolvedValue({ providerId: 'google.com' });
    m.linkWithCredential.mockRejectedValue({ code: 'auth/credential-already-in-use' });
    m.signInWithCredential.mockResolvedValue({ user: { uid: 'existing-google' } });

    const user = await signInGoogle();

    expect(m.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(user).toEqual({ uid: 'existing-google' });
  });
});

describe('native social sign-in — same-email collision (Facebook → Google linking)', () => {
  it('runs the Google flow, signs in, and links the pending Facebook credential', async () => {
    m.__authState.currentUser = null;
    const fbCred = { providerId: 'facebook.com' };
    const googleCred = { providerId: 'google.com' };
    acquire
      .mockResolvedValueOnce(fbCred)      // 1) the Facebook credential the user chose
      .mockResolvedValueOnce(googleCred); // 2) recovery: the existing Google credential
    m.signInWithCredential
      .mockRejectedValueOnce({ code: 'auth/account-exists-with-different-credential' }) // FB collides
      .mockResolvedValueOnce({ user: { uid: 'existing-google' } });                     // sign into Google
    m.linkWithCredential.mockResolvedValue({ user: { uid: 'existing-google' } });

    const user = await signInFacebook();

    expect(acquire.mock.calls.map((c) => c[0])).toEqual(['facebook', 'google']);
    expect(m.linkWithCredential).toHaveBeenCalledWith({ uid: 'existing-google' }, fbCred);
    expect(user).toEqual({ uid: 'existing-google' });
  });

  it('still signs in even if linking the pending credential fails', async () => {
    m.__authState.currentUser = null;
    acquire.mockResolvedValueOnce({ providerId: 'facebook.com' }).mockResolvedValueOnce({ providerId: 'google.com' });
    m.signInWithCredential
      .mockRejectedValueOnce({ code: 'auth/account-exists-with-different-credential' })
      .mockResolvedValueOnce({ user: { uid: 'existing-google' } });
    m.linkWithCredential.mockRejectedValue({ code: 'auth/provider-already-linked' });

    const user = await signInFacebook();
    expect(user).toEqual({ uid: 'existing-google' });
  });

  it('returns null if the user dismisses the recovery browser', async () => {
    m.__authState.currentUser = null;
    acquire.mockResolvedValueOnce({ providerId: 'facebook.com' }).mockResolvedValueOnce(null);
    m.signInWithCredential.mockRejectedValueOnce({ code: 'auth/account-exists-with-different-credential' });

    const user = await signInFacebook();
    expect(user).toBeNull();
  });
});

describe('signInApple (iOS)', () => {
  it('signs in with the acquired Apple credential', async () => {
    acquireApple.mockResolvedValue({ credential: { providerId: 'apple.com' }, fullName: null });
    m.signInWithCredential.mockResolvedValue({ user: { uid: 'a1', displayName: null } });

    const user = await signInApple();

    expect(m.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(user).toEqual({ uid: 'a1', displayName: null });
  });

  it('returns null when the user cancels the Apple sheet', async () => {
    acquireApple.mockResolvedValue(null);
    const user = await signInApple();
    expect(user).toBeNull();
    expect(m.signInWithCredential).not.toHaveBeenCalled();
  });

  it('links the credential to preserve guest progress, falling back to sign-in if already in use', async () => {
    m.__authState.currentUser = { uid: 'anon', isAnonymous: true };
    acquireApple.mockResolvedValue({ credential: { providerId: 'apple.com' }, fullName: null });
    m.linkWithCredential.mockRejectedValue({ code: 'auth/credential-already-in-use' });
    m.signInWithCredential.mockResolvedValue({ user: { uid: 'existing-apple', displayName: 'Existing' } });

    const user = await signInApple();

    expect(m.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(user).toEqual({ uid: 'existing-apple', displayName: 'Existing' });
  });

  it('sets the Firebase displayName from the one-time Apple fullName on first authorization', async () => {
    acquireApple.mockResolvedValue({
      credential: { providerId: 'apple.com' },
      fullName: { givenName: 'Ahmed', familyName: 'Ali' },
    });
    const user = { uid: 'a1', displayName: null };
    m.signInWithCredential.mockResolvedValue({ user });
    m.updateProfile.mockResolvedValue(undefined);

    await signInApple();

    expect(m.updateProfile).toHaveBeenCalledWith(user, { displayName: 'Ahmed Ali' });
  });

  it('does not touch displayName when Apple returns no name (subsequent sign-ins)', async () => {
    acquireApple.mockResolvedValue({ credential: { providerId: 'apple.com' }, fullName: null });
    m.signInWithCredential.mockResolvedValue({ user: { uid: 'a1', displayName: null } });

    await signInApple();

    expect(m.updateProfile).not.toHaveBeenCalled();
  });
});
