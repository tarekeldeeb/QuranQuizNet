// Integration: the settings screen — level/special toggles and notifications.
// Sign-out and delete-account coverage moved to me.test.tsx when those actions
// moved out of settings and into the drawer menu on the Me (home) screen.
jest.mock('expo-constants', () => ({ expoConfig: { version: '2.0.0' } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
}));

const mockWatchNotifPrefs = jest.fn((_uid: string, cb: (prefs: unknown) => void) => {
  cb({ invites: true, friendRequests: true, streakAlerts: true, dailyReady: true, friendActivity: true });
  return jest.fn();
});
const mockSetNotifPref = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockPushCurrentProfile = jest.fn((..._a: unknown[]) => Promise.resolve());

jest.mock('../../../src/services/firebase', () => ({
  watchNotifPrefs: (uid: string, cb: (prefs: unknown) => void) => mockWatchNotifPrefs(uid, cb),
  setNotifPref: (...a: unknown[]) => mockSetNotifPref(...a),
  pushCurrentProfile: (...a: unknown[]) => mockPushCurrentProfile(...a),
}));

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import SettingsScreen from '../settings';
import { useProfileStore } from '../../../src/stores/profileStore';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const renderSettings = () => render(<SafeAreaProvider initialMetrics={metrics}><SettingsScreen /></SafeAreaProvider>);

beforeEach(() => {
  mockPush.mockClear(); mockReplace.mockClear();
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
