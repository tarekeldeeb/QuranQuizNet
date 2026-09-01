// Integration: the merged /me dashboard. Verifies the daily-card states
// (available / completed / unavailable) and that starting the daily quiz wires
// through to the questionnaire engine + navigation.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-constants', () => ({ expoConfig: { version: '2.0.0' } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSetOptions = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  useNavigation: () => ({ setOptions: mockSetOptions }),
}));

const mockGetDailyHead = jest.fn();
const mockSignOut = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockDeleteAccount = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockSignInGoogle = jest.fn((..._a: unknown[]) => Promise.resolve({ uid: 'g1' }));
const mockSignInFacebook = jest.fn((..._a: unknown[]) => Promise.resolve({ uid: 'f1' }));
const mockSignInApple = jest.fn((..._a: unknown[]) => Promise.resolve({ uid: 'a1' }));
const mockPushCurrentProfile = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('../../../src/services/firebase', () => ({
  getDailyHead: (...a: unknown[]) => mockGetDailyHead(...a),
  getTodayStandings: jest.fn(() => Promise.resolve([])),
  signOut: (...a: unknown[]) => mockSignOut(...a),
  deleteAccount: (...a: unknown[]) => mockDeleteAccount(...a),
  signInGoogle: (...a: unknown[]) => mockSignInGoogle(...a),
  signInFacebook: (...a: unknown[]) => mockSignInFacebook(...a),
  signInApple: (...a: unknown[]) => mockSignInApple(...a),
  pushCurrentProfile: (...a: unknown[]) => mockPushCurrentProfile(...a),
}));

const mockInitDailyQuiz = jest.fn();
jest.mock('../../../src/services/questionnaireService', () => ({
  initDailyQuiz: (...a: unknown[]) => mockInitDailyQuiz(...a),
}));

// expo-notifications reaches into native modules that aren't set up under jest —
// stub the whole service so it's never actually required.
jest.mock('../../../src/services/notifications', () => ({
  configureNotifications: jest.fn(),
  requestPermission: jest.fn(() => Promise.resolve(false)),
  hasPermission: jest.fn(() => Promise.resolve(false)),
  scheduleStreakReminder: jest.fn(() => Promise.resolve()),
  scheduleDailyReminder: jest.fn(() => Promise.resolve()),
}));

// Otherwise this fires a real fetch() to quranquiz.net/version.json on every render.
jest.mock('../../../src/services/updateCheck', () => ({
  useUpdateAvailable: () => ({ update: null, dismiss: jest.fn() }),
}));

import React from 'react';
import { Alert, Share } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import MeScreen from '../me';
import { useProfileStore, StudyPart } from '../../../src/stores/profileStore';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const renderMe = () => render(<SafeAreaProvider initialMetrics={metrics}><MeScreen /></SafeAreaProvider>);

function part(name: string, checked = true): StudyPart {
  return { start: 1, length: 10, numCorrect: [0, 2, 0, 0], numQuestions: [0, 2, 0, 0], name, checked };
}

const today = () => new Date().toISOString().split('T')[0];
const head = () => ({ daily_random: 42, start_time: Date.now(), submit_to_ref: 'head_submit', yesterday: '' });

beforeEach(() => {
  mockPush.mockClear(); mockReplace.mockClear(); mockSetOptions.mockClear();
  mockInitDailyQuiz.mockClear(); mockGetDailyHead.mockReset();
  mockSignOut.mockReset(); mockSignOut.mockResolvedValue(undefined);
  mockDeleteAccount.mockReset(); mockDeleteAccount.mockResolvedValue(undefined);
  mockSignInGoogle.mockReset(); mockSignInGoogle.mockResolvedValue({ uid: 'g1' });
  mockSignInFacebook.mockReset(); mockSignInFacebook.mockResolvedValue({ uid: 'f1' });
  mockSignInApple.mockReset(); mockSignInApple.mockResolvedValue({ uid: 'a1' });
  mockPushCurrentProfile.mockClear();
  // Full 50-part profile (45 suras + 5 juz), as in production — the daily-weights
  // computation indexes every part.
  const parts = Array.from({ length: 50 }, (_, i) => part(`جزء/سورة ${i}`, i < 3));
  useProfileStore.setState({
    parts,
    scores: [{ date: Date.now(), score: 0 }],
    social: { uid: 'u1', displayName: 'طارق الديب', isAnonymous: false },
    streak: 3,
    level: 1,
    lastDailyCompletedDate: '',
    loaded: true,
  });
});

describe('Me dashboard — daily card states', () => {
  it('greets the user in the header and shows their points on the page', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    const { queryAllByText } = renderMe();
    // The greeting now lives in the navigation header (see me.tsx's
    // navigation.setOptions effect), not inline on the page.
    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
    const lastOptions = mockSetOptions.mock.calls[mockSetOptions.mock.calls.length - 1][0];
    const header = render(lastOptions.headerTitle());
    expect(header.getByText(/مرحباً/)).toBeTruthy();
    expect(queryAllByText(/نقطة/).length).toBeGreaterThan(0);
  });

  it('shows the start button when a daily quiz is available and not completed', async () => {
    mockGetDailyHead.mockResolvedValue(head());
    const { findByText } = renderMe();
    expect(await findByText('ابدأ اختبار اليوم')).toBeTruthy();
  });

  it('shows the completed card when today’s daily is already done', async () => {
    useProfileStore.setState({ lastDailyCompletedDate: today() });
    mockGetDailyHead.mockResolvedValue(head());
    const { findByText } = renderMe();
    expect(await findByText(/أكملت اختبار اليوم/)).toBeTruthy();
  });

  it('shows the unavailable card when no daily is published', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    const { findByText } = renderMe();
    expect(await findByText('لا يوجد اختبار اليوم حتى الآن')).toBeTruthy();
  });

  it('starting the daily quiz inits the engine and navigates to /quiz', async () => {
    mockGetDailyHead.mockResolvedValue(head());
    const { findByText } = renderMe();
    fireEvent.press(await findByText('ابدأ اختبار اليوم'));
    await waitFor(() => expect(mockInitDailyQuiz).toHaveBeenCalled());
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/(app)/quiz' }));
  });
});

describe('Me dashboard — guest upgrade [bug #3]', () => {
  beforeEach(() => {
    // Render as an anonymous guest so the in-page upgrade card is shown.
    useProfileStore.setState({ social: { uid: 'anon', displayName: 'زائر(ة)', isAnonymous: true } });
  });

  it('shows the Google/Facebook upgrade buttons for a guest', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    const { findByLabelText } = renderMe();
    expect(await findByLabelText('المتابعة بحساب جوجل')).toBeTruthy();
    expect(await findByLabelText('المتابعة بحساب فيسبوك')).toBeTruthy();
  });

  it('shows the Apple upgrade button for a guest (iOS) and signs in on press', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    const { findByTestId } = renderMe();
    fireEvent(await findByTestId('apple-upgrade-button'), 'buttonPress');
    await waitFor(() => expect(mockSignInApple).toHaveBeenCalled());
  });

  it('surfaces an error (does not fail silently) when the upgrade is refused', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    mockSignInGoogle.mockRejectedValueOnce(new Error('refused'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { findByLabelText } = renderMe();
    fireEvent.press(await findByLabelText('المتابعة بحساب جوجل'));

    await waitFor(() => expect(mockSignInGoogle).toHaveBeenCalled());
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('خطأ', expect.any(String)));
    alertSpy.mockRestore();
  });
});

// Sign-out and delete-account moved from settings.test.tsx when those actions
// moved out of settings.tsx and into the drawer menu on the Me screen.
//
// The drawer (DrawerMenu) is a Modal that starts hidden — RNTL doesn't render
// Modal children until visible=true. The hamburger button lives in the
// navigation header via navigation.setOptions, so it doesn't appear in the
// main component tree. We open the drawer by extracting the headerLeft
// element from the mocked setOptions and directly invoking its onPress,
// which calls setDrawerOpen(true) on the original MeScreen instance via
// closure — the state update makes the Modal visible in the main tree.
async function openDrawer() {
  await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
  const lastOptions = mockSetOptions.mock.calls[mockSetOptions.mock.calls.length - 1][0] as {
    headerLeft?: () => React.ReactElement;
  };
  const headerLeftEl = lastOptions.headerLeft?.();
  await act(async () => { (headerLeftEl?.props as { onPress?: () => void })?.onPress?.(); });
}

describe('Me dashboard — sign out [bug #2]', () => {
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
    mockGetDailyHead.mockResolvedValue(null);

    const { findByText } = renderMe();
    await openDrawer();
    fireEvent.press(await findByText('تسجيل الخروج'));

    // signOut is still pending → the auth-screen redirect must not have fired.
    await act(async () => { await Promise.resolve(); });
    expect(mockReplace).not.toHaveBeenCalledWith('/(auth)');

    await act(async () => { resolveSignOut(); await Promise.resolve(); });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)'));
    expect(mockSignOut).toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});

describe('Me dashboard — delete account', () => {
  it('does not call deleteAccount just from opening the confirmation sheet', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    const { findByText } = renderMe();
    await openDrawer();
    fireEvent.press(await findByText('حذف الحساب'));
    await findByText('حذف الحساب نهائياً؟'); // sheet title proves it opened
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('cancel closes the sheet without deleting anything', async () => {
    mockGetDailyHead.mockResolvedValue(null);
    const { findByText, queryByText } = renderMe();
    await openDrawer();
    fireEvent.press(await findByText('حذف الحساب'));
    await findByText('حذف الحساب نهائياً؟');

    fireEvent.press(await findByText('إلغاء'));

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalledWith('/(auth)');
    await waitFor(() => expect(queryByText('حذف الحساب نهائياً؟')).toBeNull());
  });

  it('confirm deletes the account and redirects — waiting for deleteAccount to resolve first', async () => {
    let resolveDelete!: () => void;
    mockDeleteAccount.mockReturnValue(new Promise<void>((r) => { resolveDelete = r; }));
    mockGetDailyHead.mockResolvedValue(null);

    const { findByText } = renderMe();
    await openDrawer();
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
    mockGetDailyHead.mockResolvedValue(null);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { findByText } = renderMe();
    await openDrawer();
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

// Regression: sharing the daily score duplicated the link. Share.share() was
// given the link both embedded in `message` and again as a separate `url`
// field — share targets that surface both (e.g. iMessage) pasted it twice.
// The fix drops the redundant `url` field.
describe('Me dashboard — daily score share', () => {
  it('shares the score with the link only once, not also as a separate `url`', async () => {
    useProfileStore.setState({ lastDailyCompletedDate: today(), lastDailyScore: 42 });
    mockGetDailyHead.mockResolvedValue(head());
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });

    const { findByTestId } = renderMe();
    fireEvent.press(await findByTestId('daily-score-share-button'));

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const arg = shareSpy.mock.calls[0][0] as { message?: string; url?: string };
    expect(arg.message).toContain('https://quranquiz.net');
    expect(arg.url).toBeUndefined();
    shareSpy.mockRestore();
  });
});
