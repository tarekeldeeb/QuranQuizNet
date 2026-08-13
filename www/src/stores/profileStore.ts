// Profile store — mirrors www/_model_/profile.js
// Persisted via AsyncStorage (replaces localStorage).

import { create } from 'zustand';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SURA_IDX, SURA_NAME, LAST5_JUZ_IDX, LAST5_JUZ_NAME,
  QURAN_WORDS, JUZ2_AVG_WORDS, PART_WEIGHT_100,
  DAILYQUIZ_PARTS_COUNT, DAILYQUIZ_QPERPART_COUNT,
  DAILYQUIZ_MAXTIME, DAILYQUIZ_MINTIME,
  countedScore,
} from '../models/constants';
import * as Localization from 'expo-localization';
import { MasteryTier } from '../models/milestones';
import { pointsForWin, STREAK_FREEZE_EVERY_N_WINS } from '../models/pvpTiers';
import { TIPS, TIP_SHOW_CHANCE } from '../models/tips';
import type { ThemeMode } from '../theme/tokens';
import { changeLanguage } from '../i18n';
import { type Language, isSupportedLanguage, resolveDeviceLanguage } from '../i18n/languages';

export interface StudyPart {
  start: number;
  length: number;
  // Index 0: special-question points bucket. Indices 1–3: per-level correct/
  // question counts. Index 4: beginner (level-0) correct/question counts.
  // Older saved profiles may have length-4 arrays; reads guard with `?? 0`.
  numCorrect: number[];
  numQuestions: number[];
  name: string;
  checked: boolean;
}

export interface ScoreRecord {
  date: number;
  score: number;
}

export interface ProfileSocial {
  uid?: string;
  displayName?: string;
  photoURL?: string;
  email?: string;
  isAnonymous?: boolean;
}

export interface ProfileVersion {
  db: number;
  app: number;
  profile: number;
}

// PvP (1v1) record — deliberately separate from the main score/leaderboard so
// client-authoritative match results can never inflate the surfaces people
// already compete on.
export interface PvpRecord {
  wins: number;
  losses: number;
  draws: number;
  // Journey-map progress (see models/pvpTiers.ts) — one-way: only a win adds
  // points, a loss/draw never subtracts, so the avatar never retreats.
  points: number;
  // Consecutive wins; resets to 0 on a loss/draw. Feeds pointsForWin()'s bonus.
  winStreak: number;
  // Earned every STREAK_FREEZE_EVERY_N_WINS wins; spent by the (not yet built)
  // streak-alert flow to save a dying daily streak.
  streakFreezeTokens: number;
}

// A daily-quiz submission that reached endDailyQuiz() but hasn't yet been
// confirmed written to /daily/head_submit (the in-session retries in
// submitDailyResultWithRetry all failed) — persisted so a later app open or
// quiz-screen visit can retry it instead of silently losing the score.
export interface DailySubmitPayload {
  score: number;
  name: string;
  uid: string;
  country?: string;
  date: string; // 'YYYY-MM-DD' this submission was for
}

export interface QORef {
  level: number;
  qType: { id: number; score: number };
  currentPart: number;
  startIdx: number;
}

export const CORRECT_RATIO_RANGE = {
  EMPTY: 0,
  HIGH: 1,
  MID: 2,
  LOW: 3,
} as const;

/** Translate a CORRECT_RATIO_RANGE value into models/milestones.ts's string
 * tier — the one place that enum crosses into the (deliberately decoupled)
 * MasteryTier vocabulary used by the khatam-star mastery icons. */
export function tierFromRatioRange(range: number): MasteryTier {
  switch (range) {
    case CORRECT_RATIO_RANGE.HIGH: return 'HIGH';
    case CORRECT_RATIO_RANGE.MID:  return 'MID';
    case CORRECT_RATIO_RANGE.LOW:  return 'LOW';
    default:                       return 'EMPTY';
  }
}

// The start/length a study part at index i SHOULD have, derived live from
// SURA_IDX/LAST5_JUZ_IDX. Single source of truth shared by makeDefaultParts()
// and repairPartBounds() below, so the two can never drift apart from each
// other — only from a saved profile whose parts predate a SURA_IDX fix.
function partBoundsFor(i: number): { start: number; length: number } {
  if (i === 0) return { start: 1, length: SURA_IDX[0] };
  if (i < 45) return { start: SURA_IDX[i - 1], length: SURA_IDX[i] - SURA_IDX[i - 1] };
  const j = i - 45; // 0..4 within the last-5-juz block
  return { start: LAST5_JUZ_IDX[j], length: LAST5_JUZ_IDX[j + 1] - LAST5_JUZ_IDX[j] };
}

function makeDefaultParts(): StudyPart[] {
  const parts: StudyPart[] = [];
  // First part: Al-Fatiha (full first sura)
  parts.push({
    ...partBoundsFor(0),
    numCorrect: [0, 0, 0, 0, 0],
    numQuestions: [0, 0, 0, 0, 0],
    name: 'سورة ' + SURA_NAME[0],
    checked: true,
  });
  // Suras 1-44 (index 1..44)
  for (let i = 1; i < 45; i++) {
    parts.push({
      ...partBoundsFor(i),
      numCorrect: [0, 0, 0, 0, 0],
      numQuestions: [0, 0, 0, 0, 0],
      name: 'سورة ' + SURA_NAME[i],
      checked: false,
    });
  }
  // Last 5 juz
  for (let i = 0; i < 5; i++) {
    parts.push({
      ...partBoundsFor(45 + i),
      numCorrect: [0, 0, 0, 0, 0],
      numQuestions: [0, 0, 0, 0, 0],
      name: 'جزء ' + LAST5_JUZ_NAME[i],
      checked: false,
    });
  }
  parts[49].checked = true; // Juz 'Amma (last juz)
  return parts;
}

// A saved profile's part boundaries are baked in at creation time from
// SURA_IDX/LAST5_JUZ_IDX (see makeDefaultParts above). When those constants
// are later corrected — as happened in 06e720e, a ~1-24 word/sura tokenization
// fix — an existing profile's persisted start/length silently drifts out of
// sync and never heals on its own (load() reads it back verbatim). Re-derive
// and patch in place on every load instead of trusting a one-shot version
// flag, so this self-heals for this fix and any future SURA_IDX correction
// alike. numCorrect/numQuestions/checked/name are untouched — only the word
// range moves.
function repairPartBounds(parts: StudyPart[]): { parts: StudyPart[]; changed: boolean } {
  if (parts.length !== 50) return { parts, changed: false }; // unexpected shape; leave alone
  let changed = false;
  const repaired = parts.map((p, i) => {
    const { start, length } = partBoundsFor(i);
    if (p.start === start && p.length === length) return p;
    changed = true;
    return { ...p, start, length };
  });
  return { parts: changed ? repaired : parts, changed };
}

// Copy a counts array and ensure it has 5 slots (older profiles stored 4), so
// the beginner slot (index 4) is always writable.
function padCounts(arr: number[]): number[] {
  const out = [...arr];
  while (out.length < 5) out.push(0);
  return out;
}

function calculatePartScore(p: StudyPart): number {
  // Points come only from correct answers; wrong answers never subtract.
  // Index 0 = special-question points; index 4 = beginner (level-0) correct count
  // worth 5 each.
  return (
    (p.numCorrect[0] ?? 0) +
    (p.numCorrect[1] ?? 0) * 10 +
    (p.numCorrect[2] ?? 0) * 20 +
    (p.numCorrect[3] ?? 0) * 30 +
    (p.numCorrect[4] ?? 0) * 5
  );
}

function getCorrectRatio(p: StudyPart | undefined): number {
  if (!p) return 0; // parts can be empty mid-logout, before this screen unmounts
  // Levels 1–3 plus beginner (index 4) count toward accuracy.
  const correct = (p.numCorrect[1] ?? 0) + (p.numCorrect[2] ?? 0) + (p.numCorrect[3] ?? 0) + (p.numCorrect[4] ?? 0);
  const questions = (p.numQuestions[1] ?? 0) + (p.numQuestions[2] ?? 0) + (p.numQuestions[3] ?? 0) + (p.numQuestions[4] ?? 0);
  return questions === 0 ? 0 : correct / questions;
}

export interface ProfileState {
  // Data
  uid: string;
  lastUpdate: number;
  lastSync: number;
  lastSeed: number;
  level: number;
  specialEnabled: boolean;
  scores: ScoreRecord[];
  parts: StudyPart[];
  social: ProfileSocial;
  version: ProfileVersion;
  loaded: boolean;
  streak: number;
  bestStreak: number;
  lastPlayDate: string;
  lastDailyCompletedDate: string;   // 'YYYY-MM-DD' of the last completed daily quiz
  lastDailyScore: number;           // the graded score (0-100) from that completed daily quiz
  pendingDailySubmit: DailySubmitPayload | null; // completed today, not yet confirmed written
  country: string;                  // 2-letter ISO country code detected from IP (not persisted)
  pvp: PvpRecord;                   // 1v1 win/loss/draw record (trophies)
  tipIndex: number;                 // position in models/tips.ts's TIPS array
  lastTipRollDate: string;          // 'YYYY-MM-DD' of the last daily tip roll
  // The tip currently up for display (i18n key), or null. Never persisted —
  // driven live by rollForTip()/dismissTip() so TipBanner can render off it
  // directly instead of a one-shot local effect; this also makes it
  // console-debuggable (see the __DEV__ exposure below rollForTip()).
  pendingTipKey: string | null;
  // Device/UI preference, not user data — stored under its own key (see
  // THEME_KEY) so it survives sign-out/delete instead of resetting with the
  // rest of the profile. Defaults to dark (وضع الليل is the app's default look).
  themeMode: ThemeMode;
  language: Language;

  // Actions
  load(): Promise<boolean>;
  saveAll(): Promise<void>;
  saveParts(): Promise<void>;
  saveSettings(): Promise<void>;
  reset(): Promise<void>;
  delete(): Promise<void>;
  setSocial(social: ProfileSocial): Promise<void>;
  setLastSeed(seed: number): void;
  addCorrect(qo: QORef): Promise<void>;
  addIncorrect(qo: QORef): Promise<void>;
  // Returns true iff it actually recorded a new day's play (false the second
  // time it's called on the same day) — callers use this to decide whether a
  // fresh push to Firebase is worth doing.
  recordPlay(): boolean;
  useStreakFreeze(): boolean;
  markDailyCompleted(score?: number): void;
  setPendingDailySubmit(payload: DailySubmitPayload | null): void;
  setCountry(code: string): void;
  addPvpResult(outcome: 'win' | 'loss' | 'draw'): void;
  // Once-per-calendar-day roll for whether a feature-discovery tip should
  // show. Returns the next tip's i18n key on a hit, null otherwise (already
  // rolled today, missed the roll, or the TIPS pool is exhausted). On a hit,
  // also sets pendingTipKey so TipBanner picks it up.
  // `force`: debug-only — skips both the daily gate and the probability
  // roll, e.g. from a console: useProfileStore.getState().rollForTip(true).
  rollForTip(force?: boolean): string | null;
  dismissTip(): void;
  setThemeMode(mode: ThemeMode): void;
  setLanguage(lang: Language): void;

  // Computed getters (call these as functions)
  getScore(): number;
  getTotalStudyLength(): number;
  getTotalCorrect(): number;
  getPercentTotalStudy(): string;
  getPercentTotalRatio(): string;
  getSparsePoint(cntTot: number): { idx: number; part: number };
  getCorrectRatioRange(i: number): number;
  isSurasSpecialQuestionEligible(): boolean;
  getDailyQuizStudyPartsWeights(): number[];
  getDailyQuizScore(correct: number, time: number): number;
  getTopGoodParts(): string[];
  getTopBadParts(): string[];
  getWeakCheckedParts(limit: number): { index: number; name: string }[];
  getPartIndexOf(wordIdx: number): number;
  updateScoreRecord(): boolean;
  syncTo(remote: Partial<ProfileState>): Promise<void>;

  levels: { value: number; text: string; comment: string; disabled: boolean }[];
}

const KEYS = {
  uid: 'prf_uid',
  lastUpdate: 'prf_lastUpdate',
  lastSync: 'prf_lastSync',
  lastSeed: 'prf_lastSeed',
  level: 'prf_level',
  specialEnabled: 'prf_specialEnabled',
  scores: 'prf_scores',
  parts: 'prf_parts',
  version: 'prf_version',
  social: 'prf_social',
  streak: 'prf_streak',
  bestStreak: 'prf_bestStreak',
  lastPlayDate: 'prf_lastPlayDate',
  lastDailyCompletedDate: 'prf_lastDailyDate',
  pvp: 'prf_pvp',
  lastDailyScore: 'prf_lastDailyScore',
  pendingDailySubmit: 'prf_pendingDailySubmit',
  tipIndex: 'prf_tipIndex',
  lastTipRollDate: 'prf_lastTipRollDate',
};

// Deliberately outside KEYS: delete() wipes every KEYS entry on sign-out, but
// the theme is a device preference, not profile data — it should survive that.
const THEME_KEY = 'prf_themeMode';
// Deliberately outside KEYS: device preference that survives sign-out/delete.
const LANGUAGE_KEY = 'prf_language';

const EMPTY_PVP: PvpRecord = { wins: 0, losses: 0, draws: 0, points: 0, winStreak: 0, streakFreezeTokens: 0 };

// `?lang=ar` / `?lang=en` on a web URL (e.g. a shared/campaign link) should
// override both the persisted preference and the device locale, and stick
// like an explicit in-app choice — not just for that one page load. Native
// `window` has no `.location` (see Analytics.tsx), so this only ever fires
// on web.
function getUrlLang(): Language | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const lang = new URLSearchParams(window.location.search).get('lang');
  return lang && isSupportedLanguage(lang) ? lang : null;
}

async function saveKey(key: string, value: unknown) {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}
async function loadKey<T>(key: string, def: T): Promise<T> {
  const v = await AsyncStorage.getItem(key);
  if (v === null) return def;
  try { return JSON.parse(v) as T; } catch { return def; }
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  uid: '0',
  lastUpdate: 0,
  lastSync: 0,
  lastSeed: 0,
  level: 1,
  specialEnabled: false,
  scores: [{ date: Date.now(), score: 0 }],
  parts: [],
  social: {},
  version: { db: 1.0, app: 2.0, profile: 1.0 },
  loaded: false,
  streak: 0,
  bestStreak: 0,
  lastPlayDate: '',
  lastDailyCompletedDate: '',
  lastDailyScore: 0,
  pendingDailySubmit: null,
  country: '',
  pvp: EMPTY_PVP,
  tipIndex: 0,
  lastTipRollDate: '',
  pendingTipKey: null,
  themeMode: 'dark',
  language: 'ar',

  // text/comment are i18next translation keys, not display text — every
  // consumer must call t(lvl.text)/t(lvl.comment) at render time (same
  // pattern as questionnaire.ts's Q_TYPE.txt).
  levels: [
    { value: 0, text: 'levels.beginner.text',   comment: 'levels.beginner.comment',   disabled: false },
    { value: 1, text: 'levels.elementary.text', comment: 'levels.elementary.comment', disabled: false },
    { value: 2, text: 'levels.secondary.text',  comment: 'levels.secondary.comment',  disabled: false },
    { value: 3, text: 'levels.advanced.text',   comment: 'levels.advanced.comment',   disabled: true },
  ],

  async load() {
    // Independent of the uid branch below — a device preference, present (or
    // not) regardless of whether a profile has ever been signed into.
    const themeMode = await loadKey<ThemeMode>(THEME_KEY, 'dark');

    const rawLanguage = await AsyncStorage.getItem(LANGUAGE_KEY);
    const urlLang = getUrlLang();
    let language: Language;
    if (urlLang) {
      language = urlLang;
      await saveKey(LANGUAGE_KEY, language);
    } else if (rawLanguage === null) {
      language = resolveDeviceLanguage(Localization.getLocales()[0]?.languageCode);
      await saveKey(LANGUAGE_KEY, language);
    } else {
      try {
        const parsed = JSON.parse(rawLanguage);
        language = typeof parsed === 'string' && isSupportedLanguage(parsed) ? parsed : 'ar';
      } catch {
        language = 'ar';
      }
    }
    changeLanguage(language);

    const uid = await loadKey<string>(KEYS.uid, '-1');
    if (uid === '-1') {
      const parts = makeDefaultParts();
      const seed = Math.floor(Math.random() * (QURAN_WORDS - 1));
      set({ parts, lastSeed: seed, loaded: true, themeMode, language });
      await get().saveAll();
      return false;
    }
    const [lastUpdate, lastSync, lastSeed, level, specialEnabled, scores, parts, version, social, streak, bestStreak, lastPlayDate, lastDailyCompletedDate, pvp, lastDailyScore, pendingDailySubmit, tipIndex, lastTipRollDate] =
      await Promise.all([
        loadKey<number>(KEYS.lastUpdate, 0),
        loadKey<number>(KEYS.lastSync, 0),
        loadKey<number>(KEYS.lastSeed, 0),
        loadKey<number>(KEYS.level, 1),
        loadKey<boolean>(KEYS.specialEnabled, false),
        loadKey<ScoreRecord[]>(KEYS.scores, [{ date: Date.now(), score: 0 }]),
        loadKey<StudyPart[]>(KEYS.parts, makeDefaultParts()),
        loadKey<ProfileVersion>(KEYS.version, { db: 1, app: 2, profile: 1 }),
        loadKey<ProfileSocial>(KEYS.social, {}),
        loadKey<number>(KEYS.streak, 0),
        loadKey<number>(KEYS.bestStreak, 0),
        loadKey<string>(KEYS.lastPlayDate, ''),
        loadKey<string>(KEYS.lastDailyCompletedDate, ''),
        loadKey<PvpRecord>(KEYS.pvp, EMPTY_PVP),
        loadKey<number>(KEYS.lastDailyScore, 0),
        loadKey<DailySubmitPayload | null>(KEYS.pendingDailySubmit, null),
        loadKey<number>(KEYS.tipIndex, 0),
        loadKey<string>(KEYS.lastTipRollDate, ''),
      ]);
    const { parts: fixedParts, changed: partsRepaired } = repairPartBounds(parts);
    set({
      uid, lastUpdate, lastSync, lastSeed, level, specialEnabled, scores, parts: fixedParts, version, social,
      streak, bestStreak: Math.max(bestStreak, streak), lastPlayDate, lastDailyCompletedDate,
      // Merge over EMPTY_PVP: an older saved profile's pvp record predates the
      // points/winStreak/streakFreezeTokens fields, so a raw load would leave
      // them undefined.
      pvp: { ...EMPTY_PVP, ...pvp },
      lastDailyScore, pendingDailySubmit, tipIndex, lastTipRollDate, loaded: true, themeMode, language,
    });
    // Persist the repair so it doesn't have to be recomputed (and re-diffed
    // against `parts`) on every future load, and so the fix reaches Firebase
    // on the next push instead of a stale copy overwriting it back down on
    // another device via syncTo().
    if (partsRepaired) await saveKey(KEYS.parts, fixedParts);
    return true;
  },

  async saveAll() {
    const s = get();
    await AsyncStorage.multiSet([
      [KEYS.uid,            JSON.stringify(s.uid)],
      [KEYS.lastUpdate,     JSON.stringify(s.lastUpdate)],
      [KEYS.lastSync,       JSON.stringify(s.lastSync)],
      [KEYS.lastSeed,       JSON.stringify(s.lastSeed)],
      [KEYS.level,          JSON.stringify(s.level)],
      [KEYS.specialEnabled, JSON.stringify(s.specialEnabled)],
      [KEYS.scores,         JSON.stringify(s.scores)],
      [KEYS.parts,          JSON.stringify(s.parts)],
      [KEYS.version,        JSON.stringify(s.version)],
      [KEYS.social,         JSON.stringify(s.social)],
      [KEYS.streak,                    JSON.stringify(s.streak)],
      [KEYS.bestStreak,                JSON.stringify(s.bestStreak)],
      [KEYS.lastPlayDate,              JSON.stringify(s.lastPlayDate)],
      [KEYS.lastDailyCompletedDate,     JSON.stringify(s.lastDailyCompletedDate)],
      [KEYS.pvp,                       JSON.stringify(s.pvp)],
      [KEYS.lastDailyScore,            JSON.stringify(s.lastDailyScore)],
      [KEYS.pendingDailySubmit,        JSON.stringify(s.pendingDailySubmit)],
      [KEYS.tipIndex,                  JSON.stringify(s.tipIndex)],
      [KEYS.lastTipRollDate,           JSON.stringify(s.lastTipRollDate)],
    ]);
  },

  async saveParts() {
    await saveKey(KEYS.parts, get().parts);
  },

  async saveSettings() {
    await Promise.all([
      saveKey(KEYS.level, get().level),
      saveKey(KEYS.specialEnabled, get().specialEnabled),
    ]);
  },

  async reset() {
    const parts = makeDefaultParts();
    const seed = Math.floor(Math.random() * (QURAN_WORDS - 1));
    set({ parts, lastSeed: seed, scores: [{ date: Date.now(), score: 0 }] });
    await get().saveAll();
  },

  async delete() {
    await AsyncStorage.multiRemove(Object.values(KEYS));
    set({
      uid: '0',
      lastUpdate: 0, lastSync: 0, lastSeed: 0,
      level: 1, specialEnabled: false,
      scores: [{ date: Date.now(), score: 0 }],
      parts: [],
      social: {},
      streak: 0, bestStreak: 0, lastPlayDate: '',
      lastDailyCompletedDate: '',
      pvp: EMPTY_PVP,
      lastDailyScore: 0,
      pendingDailySubmit: null,
      tipIndex: 0,
      lastTipRollDate: '',
      pendingTipKey: null,
      loaded: false,
    });
  },

  async setSocial(social: ProfileSocial) {
    set({ social, uid: social.uid ?? get().uid });
    await Promise.all([saveKey(KEYS.social, social), saveKey(KEYS.uid, get().uid)]);
  },

  setLastSeed(seed: number) {
    set({ lastSeed: seed });
    saveKey(KEYS.lastSeed, seed);
  },

  recordPlay(): boolean {
    const today = new Date().toISOString().split('T')[0];
    const { lastPlayDate, streak, bestStreak, pvp: curPvp } = get();
    if (lastPlayDate === today) return false;
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const newStreak = lastPlayDate === yesterday ? streak + 1 : 1;
    const newBest = Math.max(bestStreak, newStreak);
    const pvpEarned = newStreak > 0 && newStreak % 7 === 0;
    const pvp: PvpRecord = pvpEarned
      ? { ...curPvp, streakFreezeTokens: (curPvp.streakFreezeTokens ?? 0) + 1 }
      : curPvp;
    const now = Date.now();
    set({ streak: newStreak, bestStreak: newBest, lastPlayDate: today, pvp, lastUpdate: now });
    saveKey(KEYS.streak, newStreak);
    saveKey(KEYS.bestStreak, newBest);
    saveKey(KEYS.lastPlayDate, today);
    saveKey(KEYS.lastUpdate, now);
    if (pvpEarned) {
      saveKey(KEYS.pvp, pvp);
    }
    return true;
  },

  useStreakFreeze(): boolean {
    const { pvp: curPvp } = get();
    const tokens = curPvp?.streakFreezeTokens ?? 0;
    if (tokens <= 0) return false;
    const today = new Date().toISOString().split('T')[0];
    const pvp: PvpRecord = {
      ...curPvp,
      streakFreezeTokens: tokens - 1,
    };
    const now = Date.now();
    set({ lastPlayDate: today, pvp, lastUpdate: now });
    saveKey(KEYS.lastPlayDate, today);
    saveKey(KEYS.pvp, pvp);
    saveKey(KEYS.lastUpdate, now);
    return true;
  },

  markDailyCompleted(score?: number) {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();
    const patch: { lastDailyCompletedDate: string; lastDailyScore?: number; lastUpdate: number } =
      { lastDailyCompletedDate: today, lastUpdate: now };
    if (score !== undefined) patch.lastDailyScore = score;
    set(patch);
    saveKey(KEYS.lastDailyCompletedDate, today);
    saveKey(KEYS.lastUpdate, now);
    if (score !== undefined) saveKey(KEYS.lastDailyScore, score);
  },

  setPendingDailySubmit(payload) {
    set({ pendingDailySubmit: payload });
    saveKey(KEYS.pendingDailySubmit, payload);
  },

  setCountry(code: string) {
    set({ country: code });
  },

  setThemeMode(mode: ThemeMode) {
    // Bumping lastUpdate (in addition to the standalone THEME_KEY) lets this
    // preference ride the same syncTo()/pushProfile() freshness comparison as
    // the rest of the profile, so it also follows the signed-in account
    // across devices — see syncTo() below. Only ever called from an explicit
    // settings toggle, never from routine auth-identity mirroring, so it's
    // safe to treat every call as a genuinely fresh local edit.
    const now = Date.now();
    set({ themeMode: mode, lastUpdate: now });
    saveKey(THEME_KEY, mode);
    saveKey(KEYS.lastUpdate, now);
  },

  setLanguage(lang: Language) {
    // See setThemeMode's comment — same reasoning for syncing this preference.
    const now = Date.now();
    set({ language: lang, lastUpdate: now });
    saveKey(LANGUAGE_KEY, lang);
    saveKey(KEYS.lastUpdate, now);
    changeLanguage(lang);
  },

  addPvpResult(outcome) {
    const cur = get().pvp;
    const winStreak = outcome === 'win' ? cur.winStreak + 1 : 0;
    const wins = cur.wins + (outcome === 'win' ? 1 : 0);
    const pvp: PvpRecord = {
      wins,
      losses: cur.losses + (outcome === 'loss' ? 1 : 0),
      draws:  cur.draws  + (outcome === 'draw' ? 1 : 0),
      // One-way journey progress: only a win ever adds points (see pvpTiers.ts).
      points: cur.points + (outcome === 'win' ? pointsForWin(winStreak) : 0),
      winStreak,
      streakFreezeTokens: cur.streakFreezeTokens
        + (outcome === 'win' && wins % STREAK_FREEZE_EVERY_N_WINS === 0 ? 1 : 0),
    };
    const now = Date.now();
    set({ pvp, lastUpdate: now });
    saveKey(KEYS.pvp, pvp);
    saveKey(KEYS.lastUpdate, now);
  },

  rollForTip(force = false): string | null {
    const today = new Date().toISOString().split('T')[0];
    const { lastTipRollDate, tipIndex } = get();
    if (!force && lastTipRollDate === today) return null; // already rolled today
    // Stamp today's roll regardless of outcome, so this only ever fires once
    // a day even on a miss.
    set({ lastTipRollDate: today });
    saveKey(KEYS.lastTipRollDate, today);
    if (!force && Math.random() >= TIP_SHOW_CHANCE) return null;
    let i = tipIndex;
    while (i < TIPS.length && !TIPS[i].i18nKey) i++; // skip retired placeholders
    if (i >= TIPS.length) return null; // pool exhausted
    const nextIndex = i + 1;
    const key = TIPS[i].i18nKey;
    set({ tipIndex: nextIndex, pendingTipKey: key });
    saveKey(KEYS.tipIndex, nextIndex);
    return key;
  },

  dismissTip() {
    set({ pendingTipKey: null });
  },

  async addCorrect(qo: QORef) {
    const cp = qo.currentPart;
    const oldParts = get().parts;
    if (cp < oldParts.length) {
      const p = oldParts[cp];
      const nc = padCounts(p.numCorrect);
      const nq = padCounts(p.numQuestions);
      if (qo.qType.id > 1) {
        nc[0] += qo.qType.score;
        nq[0] += 1;
      } else if (qo.level === 0) {
        // Beginner level: a correct answer counts at index 4 (worth +5 in score)
        // so it also shows up in the part's correct/total and accuracy.
        nc[4] += 1;
        nq[4] += 1;
      } else {
        nc[qo.level] += 1;
        nq[qo.level] += 1;
      }
      const now = Date.now();
      const parts = oldParts.map((x, i) =>
        i === cp ? { ...x, numCorrect: nc, numQuestions: nq } : x,
      );
      set({ parts, lastUpdate: now });
      await Promise.all([
        saveKey(KEYS.parts, parts),
        saveKey(KEYS.lastUpdate, now),
      ]);
    }
  },

  async addIncorrect(qo: QORef) {
    const cp = qo.currentPart;
    const oldParts = get().parts;
    if (cp < oldParts.length) {
      const p = oldParts[cp];
      const nq = padCounts(p.numQuestions);
      if (qo.qType.id > 1) {
        nq[0] += 1;
      } else if (qo.level === 0) {
        // Beginner level has no score penalty, but the attempt still counts
        // toward the part's total/accuracy.
        nq[4] += 1;
      } else {
        nq[qo.level] += 1;
      }
      const now = Date.now();
      const parts = oldParts.map((x, i) =>
        i === cp ? { ...x, numQuestions: nq } : x,
      );
      set({ parts, lastUpdate: now });
      await Promise.all([
        saveKey(KEYS.parts, parts),
        saveKey(KEYS.lastUpdate, now),
      ]);
    }
  },

  getScore() {
    // Wrong answers no longer subtract, so the score can only grow. Clamp at 0 so
    // any previously-stored negative total recovers to zero.
    return Math.max(0, Math.round(get().parts.reduce((acc, p) => acc + calculatePartScore(p), 0)));
  },

  getTotalStudyLength() {
    return get().parts.reduce((acc, p) => acc + (p.checked ? p.length : 0), 0);
  },

  getTotalCorrect() {
    return get().parts.reduce(
      (acc, p) => acc + (p.checked ? p.numCorrect.reduce((a, b) => a + b, 0) : 0), 0,
    );
  },

  getPercentTotalStudy() {
    const tot = get().parts.reduce(
      (acc, p) => acc + (p.numCorrect.reduce((a, b) => a + b, 0) > 0 ? p.length : 0), 0,
    );
    return Math.round((tot * 100) / QURAN_WORDS) + '%';
  },

  getPercentTotalRatio() {
    let totCorrect = 0, totQuestions = 0;
    for (const p of get().parts) {
      totCorrect  += p.numCorrect[1]  + p.numCorrect[2]  + p.numCorrect[3];
      totQuestions += p.numQuestions[1] + p.numQuestions[2] + p.numQuestions[3];
    }
    return Math.round(totQuestions === 0 ? 0 : (100 * totCorrect) / totQuestions) + '%';
  },

  getSparsePoint(cntTot: number) {
    const parts = get().parts;
    let length = 0;
    for (let i = 0; i < parts.length; i++) {
      const pLength = parts[i].checked ? parts[i].length : 0;
      if (cntTot < length + pLength) {
        return { idx: parts[i].start + cntTot - length, part: i };
      }
      length += pLength;
    }
    const last = parts.length - 1;
    return { idx: parts[last].start, part: last };
  },

  getCorrectRatioRange(i: number) {
    const p = get().parts[i];
    if (!p) return CORRECT_RATIO_RANGE.EMPTY;
    const questions = countedScore(p.numQuestions as unknown as number[]);
    if (questions === 0) return CORRECT_RATIO_RANGE.EMPTY;
    const ratio = getCorrectRatio(p);
    if (ratio >= 0.8) return CORRECT_RATIO_RANGE.HIGH;
    if (ratio >= 0.5) return CORRECT_RATIO_RANGE.MID;
    return CORRECT_RATIO_RANGE.LOW;
  },

  isSurasSpecialQuestionEligible() {
    const parts = get().parts;
    for (let i = parts.length - 1; i >= parts.length - 5; i--) {
      if (parts[i]?.checked) return true;
    }
    let s = 0;
    for (let j = parts.length - 6; j > 0; j--) {
      if (parts[j]?.checked) s++;
      if (s >= 7) return true;
    }
    return false;
  },

  getDailyQuizStudyPartsWeights() {
    const { parts } = get();
    const sparse: number[] = new Array(DAILYQUIZ_PARTS_COUNT).fill(0);
    const totalStudyLength = get().getTotalStudyLength();
    const totalStudyWeight = Math.ceil(totalStudyLength / JUZ2_AVG_WORDS);
    let sum = 0;
    for (let i = 0; i < DAILYQUIZ_PARTS_COUNT; i++) {
      if (i === 0 || !parts[i]?.checked) {
        sparse[i] = 0;
      } else {
        const Wn = Math.ceil((DAILYQUIZ_QPERPART_COUNT * PART_WEIGHT_100[i]) / (totalStudyWeight * 100));
        sparse[i] = Wn > 0 ? Wn : 0;
      }
      sum += sparse[i];
    }
    if (sum === 0) {
      // No eligible parts → fall back to the last juz only.
      sparse[DAILYQUIZ_PARTS_COUNT - 1] = DAILYQUIZ_QPERPART_COUNT;
      return sparse;
    }
    const correction = DAILYQUIZ_QPERPART_COUNT - sum;
    if (correction !== 0) {
      for (let i = DAILYQUIZ_PARTS_COUNT - 1; i >= 0; i--) {
        if (sparse[i] !== 0) { sparse[i] += correction; break; }
      }
    }
    return sparse;
  },

  getDailyQuizScore(correct: number, time: number) {
    let score = 10 * correct;
    // Speed penalty: 0 (fast, at/under MINTIME) → 5 (slow, at/over MAXTIME).
    // Floored at 0 so a sub-MINTIME run can't turn the penalty into a bonus,
    // and capped at 1 so an over-MAXTIME run can't subtract more than 5.
    const speedFactor = Math.min(
      Math.max((time - DAILYQUIZ_MINTIME) / (DAILYQUIZ_MAXTIME - DAILYQUIZ_MINTIME), 0),
      1,
    );
    score -= 5 * speedFactor;
    score -= 5 * (1 - get().getTotalStudyLength() / QURAN_WORDS);
    score = Math.min(Math.max(score, 0), 100);
    return parseFloat(score.toFixed(2));
  },

  getTopGoodParts() {
    const top = Array<string>(5).fill('-');
    const { parts } = get();
    Array.from({ length: 50 }, (_, i) => i)
      .map((i) => ({ i, ratio: getCorrectRatio(parts[i]), range: get().getCorrectRatioRange(i) }))
      .filter((o) => o.range === CORRECT_RATIO_RANGE.HIGH)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 5)
      .forEach((o, i) => { top[i] = parts[o.i].name; });
    return top;
  },

  getTopBadParts() {
    const top = Array<string>(5).fill('-');
    const { parts } = get();
    Array.from({ length: 50 }, (_, i) => i)
      .map((i) => ({ i, ratio: getCorrectRatio(parts[i]), range: get().getCorrectRatioRange(i) }))
      .filter((o) => o.range === CORRECT_RATIO_RANGE.MID || o.range === CORRECT_RATIO_RANGE.LOW)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 5)
      .forEach((o, i) => { top[i] = parts[o.i].name; });
    return top;
  },

  // Enabled (checked) study parts only, ordered worst-quality first (lowest
  // correct ratio), capped to `limit`. Drives the quiz chooser so the user is
  // nudged toward the suras that most need review. Unattempted parts (ratio 0)
  // sort to the top as "needs practice". Index 0 (Al-Fatiha, see
  // makeDefaultParts) is always excluded — it's too short to make a good
  // review quiz.
  getWeakCheckedParts(limit: number) {
    return get().parts
      .map((p, index) => ({ index, name: p.name, checked: p.checked, ratio: getCorrectRatio(p) }))
      .filter((o) => o.checked && o.index !== 0)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, limit)
      .map(({ index, name }) => ({ index, name }));
  },

  getPartIndexOf(wordIdx: number): number {
    const { parts } = get();
    for (let i = 0; i < parts.length; i++) {
      if (wordIdx >= parts[i].start && wordIdx < parts[i].start + parts[i].length) {
        return i;
      }
    }
    return parts.length - 1;
  },

  updateScoreRecord() {
    const { scores } = get();
    const now = Date.now();
    const score = get().getScore();
    const dayOf = (t: number) => new Date(t).toISOString().split('T')[0];
    const today = dayOf(now);
    const last = scores[scores.length - 1];

    let next: ScoreRecord[];
    if (last && dayOf(last.date) === today) {
      // One point per calendar day: refresh today's snapshot in place so the
      // latest bar always reflects the current score (instead of a stale 0).
      next = [...scores];
      next[next.length - 1] = { date: now, score };
    } else {
      next = [...scores, { date: now, score }];
    }
    // Cap history so the array can't grow unbounded over the years.
    const MAX_RECORDS = 365;
    if (next.length > MAX_RECORDS) next = next.slice(next.length - MAX_RECORDS);

    // Bump lastUpdate so this change is treated as "newer" and actually syncs
    // up to Firebase on the next push (updateScoreRecord alone used not to).
    set({ scores: next, lastUpdate: now });
    saveKey(KEYS.scores, next);
    saveKey(KEYS.lastUpdate, now);
    return true;
  },

  async syncTo(remote) {
    if (!remote.uid || remote.uid !== get().uid) return;
    const remoteUpdate = (remote.lastUpdate ?? 0);
    const localUpdate = get().lastUpdate;
    // Only overwrite local if never synced, OR remote data is genuinely newer than local.
    // This prevents a session's quiz answers (saved locally) from being overwritten by
    // the older Firebase copy when the app restarts before the next push.
    if (get().lastSync === 0 || remoteUpdate > localUpdate) {
      const now = Date.now();
      const cur = get();
      const nextThemeMode = remote.themeMode ?? cur.themeMode;
      const nextLanguage = remote.language ?? cur.language;
      set({
        lastUpdate: remoteUpdate, lastSync: now,
        lastSeed: remote.lastSeed ?? cur.lastSeed,
        level: remote.level ?? cur.level,
        specialEnabled: remote.specialEnabled ?? cur.specialEnabled,
        scores: remote.scores ?? cur.scores,
        parts: remote.parts ?? cur.parts,
        // Everything below rounds out the fields pushProfile() actually writes
        // (see firebase.ts pushCurrentProfile) — without this a second device
        // or a reinstall only recovered quiz progress, never PvP trophies,
        // streak, daily-quiz state, or the nickname/theme/language prefs.
        streak: remote.streak ?? cur.streak,
        bestStreak: Math.max(cur.bestStreak, remote.bestStreak ?? 0, remote.streak ?? 0),
        lastPlayDate: remote.lastPlayDate ?? cur.lastPlayDate,
        lastDailyCompletedDate: remote.lastDailyCompletedDate ?? cur.lastDailyCompletedDate,
        lastDailyScore: remote.lastDailyScore ?? cur.lastDailyScore,
        pvp: remote.pvp ? { ...EMPTY_PVP, ...remote.pvp } : cur.pvp,
        themeMode: nextThemeMode,
        language: nextLanguage,
        social: remote.social?.displayName
          ? { ...cur.social, displayName: remote.social.displayName }
          : cur.social,
      });
      await get().saveAll();
      // THEME_KEY/LANGUAGE_KEY live outside saveAll()'s KEYS map (see their
      // declaration above) — persist them explicitly, and re-apply the
      // language to i18next if it changed.
      await saveKey(THEME_KEY, nextThemeMode);
      await saveKey(LANGUAGE_KEY, nextLanguage);
      if (nextLanguage !== cur.language) changeLanguage(nextLanguage);
    }
  },
}));

// Debug convenience: exposes the store on the JS console (browser devtools on
// web, or the Hermes/remote debugger console on native) so state can be
// inspected/forced without rebuilding. e.g. to preview a tip on demand:
//   useProfileStore.getState().rollForTip(true)
if (__DEV__) {
  (globalThis as unknown as { useProfileStore: typeof useProfileStore }).useProfileStore = useProfileStore;
}
