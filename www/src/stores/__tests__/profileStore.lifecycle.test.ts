// Lifecycle across states: daily-completion stamping, logout/delete clearing
// (and rendering safely on the resulting empty parts), and syncing a remote
// profile back down on login.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useProfileStore, StudyPart, CORRECT_RATIO_RANGE } from '../profileStore';
import { TIPS } from '../../models/tips';
import { SURA_IDX, LAST5_JUZ_IDX } from '../../models/constants';

const store = () => useProfileStore.getState();
const today = () => new Date().toISOString().split('T')[0];

function part(name: string, checked = true): StudyPart {
  return {
    start: 1, length: 10,
    numCorrect: [0, 0, 0, 0], numQuestions: [0, 0, 0, 0],
    name, checked,
  };
}

describe('daily completion gating', () => {
  it('markDailyCompleted stamps today (YYYY-MM-DD)', () => {
    useProfileStore.setState({ lastDailyCompletedDate: '' });
    store().markDailyCompleted();
    expect(store().lastDailyCompletedDate).toBe(today());
  });
});

describe('logout / delete', () => {
  it('clears parts, scores and social', async () => {
    useProfileStore.setState({
      parts: [part('A')],
      scores: [{ date: Date.now(), score: 99 }],
      social: { uid: 'u1', displayName: 'Tester', isAnonymous: false },
    });
    await store().delete();
    expect(store().parts).toEqual([]);
    expect(store().social).toEqual({});
    expect(store().loaded).toBe(false);
  });

  it('renders safely with empty parts (no crash mid-logout)', async () => {
    await store().delete(); // parts === []
    expect(store().getScore()).toBe(0);
    // getTopBadParts iterates 50 fixed indices over an empty array — must not throw
    expect(() => store().getTopBadParts()).not.toThrow();
    expect(store().getTopBadParts().every((n) => n === '-')).toBe(true);
    expect(store().getCorrectRatioRange(0)).toBe(CORRECT_RATIO_RANGE.EMPTY);
  });
});

describe('syncTo: restore a remote profile on login', () => {
  it('overwrites local with newer remote data (first sync)', async () => {
    useProfileStore.setState({
      uid: 'u1', lastSync: 0, lastUpdate: 0,
      level: 0, scores: [{ date: 1, score: 0 }], parts: [part('local')],
    });
    await store().syncTo({
      uid: 'u1',
      lastUpdate: 1_000_000,
      level: 2,
      scores: [{ date: 2, score: 250 }],
      parts: [part('remote-1'), part('remote-2')],
    });
    expect(store().level).toBe(2);
    expect(store().scores[store().scores.length - 1].score).toBe(250);
    expect(store().parts).toHaveLength(2);
  });

  it('ignores a remote profile belonging to a different uid', async () => {
    useProfileStore.setState({ uid: 'u1', level: 1, lastSync: 0 });
    await store().syncTo({ uid: 'OTHER', level: 2, lastUpdate: 9_999_999 });
    expect(store().level).toBe(1); // unchanged
  });

  it('does not overwrite newer local data with an older remote copy', async () => {
    useProfileStore.setState({
      uid: 'u1', lastSync: 123, lastUpdate: 5_000_000, level: 1,
    });
    await store().syncTo({ uid: 'u1', lastUpdate: 1_000_000, level: 2 });
    expect(store().level).toBe(1); // local is newer ⇒ kept
  });

  // Everything pushCurrentProfile() (firebase.ts) writes must round-trip back
  // down here on a fresh device/reinstall — not just quiz progress.
  it('restores streak, PvP, daily-quiz state, theme, language and nickname from a newer remote copy', async () => {
    useProfileStore.setState({
      uid: 'u1', lastSync: 0, lastUpdate: 0,
      streak: 0, bestStreak: 0, lastPlayDate: '',
      lastDailyCompletedDate: '', lastDailyScore: 0,
      pvp: { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 0 },
      themeMode: 'dark', language: 'ar',
      social: { uid: 'u1', displayName: 'Old Name', isAnonymous: false },
    });
    await store().syncTo({
      uid: 'u1',
      lastUpdate: 1_000_000,
      streak: 9,
      bestStreak: 12,
      lastPlayDate: '2026-07-20',
      lastDailyCompletedDate: '2026-07-20',
      lastDailyScore: 88,
      pvp: { wins: 3, losses: 1, draws: 0, points: 40, winStreak: 2, streakFreezeTokens: 1 },
      themeMode: 'light',
      language: 'en',
      social: { displayName: 'New Name' },
    });
    expect(store().streak).toBe(9);
    expect(store().bestStreak).toBe(12);
    expect(store().lastPlayDate).toBe('2026-07-20');
    expect(store().lastDailyCompletedDate).toBe('2026-07-20');
    expect(store().lastDailyScore).toBe(88);
    expect(store().pvp).toEqual({ wins: 3, losses: 1, draws: 0, points: 40, winStreak: 2, streakFreezeTokens: 1 });
    expect(store().themeMode).toBe('light');
    expect(store().language).toBe('en');
    // uid/isAnonymous stay authoritative from Firebase Auth's own mirror, not RTDB.
    expect(store().social).toEqual({ uid: 'u1', displayName: 'New Name', isAnonymous: false });
  });

  it('keeps the higher bestStreak even if remote never recorded one (older saved profile)', async () => {
    useProfileStore.setState({
      uid: 'u1', lastSync: 0, lastUpdate: 0, bestStreak: 5,
    });
    await store().syncTo({ uid: 'u1', lastUpdate: 1_000_000, streak: 3 });
    expect(store().bestStreak).toBe(5);
  });
});

describe('sura-boundary repair on load (06e720e SURA_IDX correction)', () => {
  // A pre-fix profile's parts carry the OLD (buggy) SURA_IDX-derived start/length
  // baked in at creation time. load() must re-derive them from the current
  // constants in place, without touching anything else.
  function staleParts(): StudyPart[] {
    return Array.from({ length: 50 }, (_, i) => ({
      start: 999_000 + i, // deliberately not anything SURA_IDX/LAST5_JUZ_IDX would produce
      length: 5,
      numCorrect: [1, 2, 3, 4, 5],
      numQuestions: [5, 5, 5, 5, 5],
      name: `part-${i}`,
      checked: i % 2 === 0,
    }));
  }

  it('rewrites stale start/length to match current SURA_IDX, leaving scores/checked/name untouched', async () => {
    await AsyncStorage.setItem('prf_uid', JSON.stringify('u1'));
    await AsyncStorage.setItem('prf_parts', JSON.stringify(staleParts()));

    await store().load();

    const parts = store().parts;
    expect(parts).toHaveLength(50);
    expect(parts[0]).toMatchObject({ start: 1, length: SURA_IDX[0] });
    expect(parts[1]).toMatchObject({ start: SURA_IDX[0], length: SURA_IDX[1] - SURA_IDX[0] });
    expect(parts[45]).toMatchObject({ start: LAST5_JUZ_IDX[0], length: LAST5_JUZ_IDX[1] - LAST5_JUZ_IDX[0] });
    parts.forEach((p, i) => {
      expect(p.numCorrect).toEqual([1, 2, 3, 4, 5]);
      expect(p.numQuestions).toEqual([5, 5, 5, 5, 5]);
      expect(p.name).toBe(`part-${i}`);
      expect(p.checked).toBe(i % 2 === 0);
    });

    // The fix is written back, not just held in memory — so it also reaches
    // Firebase on the next push instead of a stale copy re-drifting it later.
    const persisted = JSON.parse((await AsyncStorage.getItem('prf_parts'))!) as StudyPart[];
    expect(persisted[0].start).toBe(1);
    expect(persisted[0].length).toBe(SURA_IDX[0]);
  });

  it('is idempotent: re-loading an already-correct profile leaves parts unchanged', async () => {
    useProfileStore.setState({ uid: 'u2' });
    await store().reset(); // makeDefaultParts() + saveAll() — already on current bounds
    const before = store().parts;

    await store().load();

    expect(store().parts).toEqual(before);
  });
});

describe('recordPlay(): return value signals whether a push is worth doing', () => {
  it('returns true the first time today, false on a second call the same day', () => {
    useProfileStore.setState({ lastPlayDate: '', streak: 0, bestStreak: 0 });
    expect(store().recordPlay()).toBe(true);
    expect(store().recordPlay()).toBe(false);
  });
});

describe('streak freeze tokens', () => {
  it('awards a streak freeze token in recordPlay on 7-day multiples', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    useProfileStore.setState({
      streak: 6,
      bestStreak: 6,
      lastPlayDate: yesterday,
      pvp: { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 0 },
    });

    store().recordPlay();

    expect(store().streak).toBe(7);
    expect(store().lastPlayDate).toBe(today());
    expect(store().pvp.streakFreezeTokens).toBe(1);
  });

  it('does not award a streak freeze token in recordPlay on non-multiple of 7 days', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    useProfileStore.setState({
      streak: 5,
      bestStreak: 5,
      lastPlayDate: yesterday,
      pvp: { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 0 },
    });

    store().recordPlay();

    expect(store().streak).toBe(6);
    expect(store().lastPlayDate).toBe(today());
    expect(store().pvp.streakFreezeTokens).toBe(0);
  });

  it('useStreakFreeze decrements token and sets lastPlayDate without changing streak', () => {
    useProfileStore.setState({
      streak: 10,
      bestStreak: 10,
      lastPlayDate: '2026-01-01',
      pvp: { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 2 },
    });

    const res = store().useStreakFreeze();

    expect(res).toBe(true);
    expect(store().pvp.streakFreezeTokens).toBe(1);
    expect(store().lastPlayDate).toBe(today());
    expect(store().streak).toBe(10);
    expect(store().bestStreak).toBe(10);
  });

  it('useStreakFreeze returns false and changes nothing if no tokens available', () => {
    useProfileStore.setState({
      streak: 5,
      bestStreak: 5,
      lastPlayDate: '2026-01-01',
      pvp: { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 0 },
    });

    const res = store().useStreakFreeze();

    expect(res).toBe(false);
    expect(store().pvp.streakFreezeTokens).toBe(0);
    expect(store().lastPlayDate).toBe('2026-01-01');
    expect(store().streak).toBe(5);
  });
});

describe('rollForTip(): feature-discovery tip nudge', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rolls at most once per calendar day', () => {
    useProfileStore.setState({ lastTipRollDate: '', tipIndex: 0 });
    jest.spyOn(Math, 'random').mockReturnValue(0); // guaranteed hit if it does roll
    expect(store().rollForTip()).not.toBeNull();
    expect(store().rollForTip()).toBeNull(); // already rolled today
  });

  it('on a hit, returns tips in order, advances tipIndex, and sets pendingTipKey', () => {
    useProfileStore.setState({ lastTipRollDate: '', tipIndex: 0, pendingTipKey: null });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(store().rollForTip()).toBe(TIPS[0].i18nKey);
    expect(store().tipIndex).toBe(1);
    expect(store().pendingTipKey).toBe(TIPS[0].i18nKey);
  });

  it('dismissTip() clears pendingTipKey', () => {
    useProfileStore.setState({ pendingTipKey: TIPS[0].i18nKey });
    store().dismissTip();
    expect(store().pendingTipKey).toBeNull();
  });

  it('force=true bypasses both the daily gate and the probability roll', () => {
    const todayStr = today();
    useProfileStore.setState({ lastTipRollDate: todayStr, tipIndex: 0 });
    jest.spyOn(Math, 'random').mockReturnValue(0.999); // would normally miss
    expect(store().rollForTip(true)).toBe(TIPS[0].i18nKey);
    expect(store().tipIndex).toBe(1);
  });

  it('on a miss, stamps lastTipRollDate but leaves tipIndex unchanged', () => {
    useProfileStore.setState({ lastTipRollDate: '', tipIndex: 2 });
    jest.spyOn(Math, 'random').mockReturnValue(0.999); // above TIP_SHOW_CHANCE
    expect(store().rollForTip()).toBeNull();
    expect(store().tipIndex).toBe(2);
    expect(store().lastTipRollDate).toBe(today());
  });

  it('returns null forever once the tip pool is exhausted', () => {
    useProfileStore.setState({ lastTipRollDate: '', tipIndex: TIPS.length });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(store().rollForTip()).toBeNull();
    expect(store().tipIndex).toBe(TIPS.length);
  });

  it('round-trips tipIndex/lastTipRollDate through saveAll() and load()', async () => {
    useProfileStore.setState({ uid: 'u1', tipIndex: 3, lastTipRollDate: '2026-01-01' });
    await store().saveAll();

    useProfileStore.setState({ tipIndex: 0, lastTipRollDate: '' });
    await store().load();

    expect(store().tipIndex).toBe(3);
    expect(store().lastTipRollDate).toBe('2026-01-01');
  });
});
