// Integration: the settings screen — level/special toggles and sign-out.
// The sign-out regression coverage (bug #2: navigating before signOut()
// resolves) moved here from me.test.tsx when sign-out moved off Home and
// behind the gear icon (see (app)/me.tsx + (app)/settings.tsx).
jest.mock('expo-constants', () => ({ expoConfig: { version: '2.0.0' } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
}));

const mockSignOut = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockDeleteAccount = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockWatchNotifPrefs = jest.fn((_uid: string, cb: (prefs: unknown) => void) => {
  cb({ invites: true, friendRequests: true, streakAlerts: true, dailyReady: true, friendActivity: true });
  return jest.fn();
});
const mockSetNotifPref = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockPushCurrentProfile = jest.fn((..._a: unknown[]) => Promise.resolve());

jest.mock('../../../src/services/firebase', () => ({
  signOut: (...a: unknown[]) => mockSignOut(...a),
  deleteAccount: (...a: unknown[]) => mockDeleteAccount(...a),
  watchNotifPrefs: (uid: string, cb: (prefs: unknown) => void) => mockWatchNotifPrefs(uid, cb),
  setNotifPref: (...a: unknown[]) => mockSetNotifPref(...a),
  pushCurrentProfile: (...a: unknown[]) => mockPushCurrentProfile(...a),
}));

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import SettingsScreen from '../settings';
import { useProfileStore } from '../../../src/stores/profileStore';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const renderSettings = () => render(<SafeAreaProvider initialMetrics={metrics}><SettingsScreen /></SafeAreaProvider>);

beforeEach(() => {
  mockPush.mockClear(); mockReplace.mockClear();
  mockSignOut.mockReset(); mockSignOut.mockResolvedValue(undefined);
  mockDeleteAccount.mockReset(); mockDeleteAccount.mockResolvedValue(undefined);
  mockPushCurrentProfile.mockClear();
  useProfileStore.setState({
    social: { uid: 'u1', displayName: 'طارق الديب', isAnonymous: false },
    level: 1,
    specialEnabled: false,
    themeMode: 'dark',
    language: 'ar',
    loaded: true,
  });
});

describe('Settings — sign out [bug #2]', () => {
  // Auto-confirm the "are you sure?" dialog by invoking the destructive button.
  function autoConfirmAlert() {
    return jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as { style?: string; onPress?: () => void }[] | undefined)
        ?.find((b) => b.style === 'destructive')?.onPress?.();
    });
  }

  it('does NOT navigate to /(auth) until signOut() has resolved', async () => {
    // Hold signOut open so we can observe that navigation waits for it.
    let resolveSignOut!: () => void;
    mockSignOut.mockReturnValue(new Promise<void>((r) => { resolveSignOut = r; }));
    const alertSpy = autoConfirmAlert();

    const { findByText } = renderSettings();
    fireEvent.press(await findByText('تسجيل الخروج'));

    // signOut is still pending → the auth-screen redirect must not have fired,
    // otherwise its auth listener would bounce back on the stale session.
    await act(async () => { await Promise.resolve(); });
    expect(mockReplace).not.toHaveBeenCalledWith('/(auth)');

    await act(async () => { resolveSignOut(); await Promise.resolve(); });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)'));
    expect(mockSignOut).toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});

describe('Settings — delete account', () => {
  it('does not call deleteAccount just from opening the confirmation sheet', async () => {
    const { findByText } = renderSettings();
    fireEvent.press(await findByText('حذف الحساب'));
    await findByText('حذف الحساب نهائياً؟'); // the sheet's own title, proves it opened
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('cancel closes the sheet without deleting anything', async () => {
    const { findByText, queryByText } = renderSettings();
    fireEvent.press(await findByText('حذف الحساب'));
    await findByText('حذف الحساب نهائياً؟');

    fireEvent.press(await findByText('إلغاء'));

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalledWith('/(auth)');
    await waitFor(() => expect(queryByText('حذف الحساب نهائياً؟')).toBeNull());
  });

  it('confirm deletes the account, clears local data, and redirects — waiting for deleteAccount to resolve first', async () => {
    let resolveDelete!: () => void;
    mockDeleteAccount.mockReturnValue(new Promise<void>((r) => { resolveDelete = r; }));

    const { findByText } = renderSettings();
    fireEvent.press(await findByText('حذف الحساب'));
    await findByText('حذف الحساب نهائياً؟');
    fireEvent.press(await findByText('حذف الحساب نهائياً')); // confirm button (no "؟" — distinct from the title)

    // deleteAccount is still pending → must not have navigated on a stale session.
    await act(async () => { await Promise.resolve(); });
    expect(mockReplace).not.toHaveBeenCalledWith('/(auth)');

    await act(async () => { resolveDelete(); await Promise.resolve(); });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)'));
    expect(mockDeleteAccount).toHaveBeenCalled();
  });

  it('shows a generic error and does not navigate when deleteAccount fails', async () => {
    mockDeleteAccount.mockRejectedValue(new Error('network blip'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { findByText } = renderSettings();
    fireEvent.press(await findByText('حذف الحساب'));
    await findByText('حذف الحساب نهائياً؟');
    fireEvent.press(await findByText('حذف الحساب نهائياً'));

    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expect(mockReplace).not.toHaveBeenCalledWith('/(auth)');
    expect(alertSpy).toHaveBeenCalledWith('خطأ', expect.any(String));

    alertSpy.mockRestore();
  });
});

describe('Appearance & language — push the change to the signed-in account', () => {
  it('pushes the profile after switching theme', async () => {
    const { findByText } = renderSettings();
    fireEvent.press(await findByText('فاتح'));
    expect(useProfileStore.getState().themeMode).toBe('light');
    expect(mockPushCurrentProfile).toHaveBeenCalled();
  });

  it('pushes the profile after switching language', async () => {
    const { findByText } = renderSettings();
    fireEvent.press(await findByText('العربية')); // open the dropdown
    fireEvent.press(await findByText('English'));
    expect(useProfileStore.getState().language).toBe('en');
    expect(mockPushCurrentProfile).toHaveBeenCalled();
  });
});
