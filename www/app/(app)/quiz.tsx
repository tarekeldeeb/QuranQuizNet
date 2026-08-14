// Main quiz screen — mirrors www/quiz/quizCtrl.js + www/one/oneCtrl.js
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, FlatList, ActivityIndicator, StyleSheet, Text,
  Modal, TextInput, ScrollView, Share, Animated, Platform, AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useFocusEffect, useRouter, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import AsyncStorage from '@react-native-async-storage/async-storage';
import QuizCard, { CardData, reachesNewSuraContent } from '../../src/components/QuizCard';
import MistakesReview from '../../src/components/MistakesReview';
import QuizSettingsBar, { ScopeMode } from '../../src/components/QuizSettingsBar';
import { useTranslation } from 'react-i18next';
import { useDirection, rowDir, alignDir, mirror } from '../../src/theme/direction';
import PressScale from '../../src/components/PressScale';
import Ring from '../../src/components/Ring';
import Confetti from '../../src/components/Confetti';
import { useTheme, localeNum, radii } from '../../src/theme/tokens';
import { useProfileStore, tierFromRatioRange } from '../../src/stores/profileStore';
import * as QS from '../../src/services/questionnaireService';
import * as FB from '../../src/services/firebase';
import { trackEvent } from '../../src/services/analytics';
import { requestPermission, scheduleStreakReminder, registerPushToken } from '../../src/services/notifications';
import {
  randperm, shuffleByPerm, deepCopy, countedScore,
  DAILYQUIZ_CHECKEVERY, DAILYQUIZ_CHECKAFTER, DAILYQUIZ_QPERPART_COUNT,
  DEFAULT_GUEST_NAME, translatePartName, getSuraIdx,
} from '../../src/models/constants';
import { ayaNumberOf, wordOffsetInAya } from '../../src/db/idb';
import { QuestionObject } from '../../src/models/questionnaire';
import { MistakeRecord, buildMistakeRecord } from '../../src/models/mistakes';
import {
  decideFocusFromContext, isAnswerable, shouldSuspendNormalRun,
  shouldShowSummary, shouldRestoreNormalRunAfterDaily, decideSessionComplete,
} from '../../src/models/quizFlow';
import { describeLiveRank } from '../../src/models/dailyRank';
import { detectMilestones } from '../../src/models/milestones';
import { hapticCorrect, hapticIncorrect } from '../../src/services/haptics';
import { playCorrectSound, playIncorrectSound } from '../../src/services/sound';
import { wordAtScopeOffset, MatchScopePart } from '../../src/services/pvpService';

interface ActiveCard {
  round: number;
  shuffle: number[];           // perm of 0-4; shuffle[i]=0 means option i is correct
  shuffledOptions: string[];
  flipTrigger: number;
  isCorrect: boolean;
  // Which shuffled-option index the player picked at the final round (null
  // when skipped/timed out) — drives QuizCard's post-answer reveal.
  pickedIndex: number | null;
}

function makeActive(qo: QuestionObject, round = 0): ActiveCard {
  const shuffle = randperm(5);
  return {
    round,
    shuffle,
    shuffledOptions: shuffleByPerm(qo.txt.op[round] ?? ['', '', '', '', ''], shuffle),
    flipTrigger: 0,
    isCorrect: false,
    pickedIndex: null,
  };
}

// react-native-web has no native animation driver (RCTAnimation is a native-only
// module) — passing useNativeDriver: true there is a no-op that also spams the
// console every frame, so only ask for it off-web.
const NATIVE_DRIVER = Platform.OS !== 'web';

// Ask for notification permission the first time the user finishes a quiz
// session — a proven-engaged moment, not a jarring cold-launch prompt. Gated by
// an AsyncStorage flag so it only ever runs once; no-op (false) on web.
const NOTIF_PROMPT_KEY = 'notif_prompt_shown';
async function maybeRequestNotificationPermission() {
  try {
    const shown = await AsyncStorage.getItem(NOTIF_PROMPT_KEY);
    if (shown) return;
    await AsyncStorage.setItem(NOTIF_PROMPT_KEY, '1');
    const granted = await requestPermission();
    trackEvent('notif_permission_result', { outcome: granted ? 'granted' : 'denied' });
    if (granted) {
      scheduleStreakReminder(useProfileStore.getState().streak);
      registerPushToken(useProfileStore.getState().uid);
    }
  } catch { /* permission prompt is best-effort */ }
}

// Module-level session cache. expo-router can unmount an inactive tab on web, so
// component state/refs do NOT survive leaving to another tab (e.g. Me) and back.
export type QuizMode = 'daily' | 'weak_review' | 'shared' | 'custom' | 'random';

// This module object outlives remounts, letting us resume the in-progress run.
interface SessionCache {
  active: boolean;       // a run is in progress and resumable
  dailyMode: boolean;
  dailyEnded: boolean;
  cards: CardData[];
  activeCard: ActiveCard | null;
  score: number;
  cardCounter: number;
  sessionCorrect: number;
  sessionAnswered: number;   // questions answered this run (correct + incorrect)
  mistakes: MistakeRecord[];
  combo: number;             // consecutive correct answers this run (resets on a miss)
  dailyScore: number;
  dailyTime: number;
  lastNonce: string | undefined;   // consumed deep-link nonce (survives remount)
  lastStart: string | undefined;   // consumed ?start=<wordIdx> deep-link (shared question)
  customPart: number | null;       // selected sura/juz part index, or null = whole profile
  weakReviewParts: number[] | null; // snapshotted weak parts for weakReview mode
  // A normal (non-daily) session suspended while a daily quiz runs. The daily
  // quiz uses its own empty card stack; this lets the normal run reappear after.
  normalSnapshot: NormalSnapshot | null;
}
// Suspended normal session — its own card stack plus the engine state (active
// question + seed) needed to keep answering where it left off.
interface NormalSnapshot {
  cards: CardData[];
  active: ActiveCard | null;
  cardCounter: number;
  sessionCorrect: number;
  sessionAnswered: number;
  mistakes: MistakeRecord[];
  customPart: number | null;
  weakReviewParts: number[] | null;
  qo: QuestionObject;   // the live question when the normal run was suspended
  seed: number;         // questionnaire seed at suspension (= active question idx)
  sessionMode: QuizMode;
  sessionStartScore: number;
  flushedAnswered: number;
  flushedCorrect: number;
}
const sessionCache: SessionCache = {
  active: false, dailyMode: false, dailyEnded: false,
  cards: [], activeCard: null, score: 0,
  cardCounter: 0, sessionCorrect: 0, sessionAnswered: 0, mistakes: [], combo: 0, dailyScore: 0, dailyTime: 0,
  lastNonce: undefined, lastStart: undefined, customPart: null, weakReviewParts: null, normalSnapshot: null,
};

export default function QuizScreen() {
  const params = useLocalSearchParams<{ customPart?: string; dailyMode?: string; nonce?: string; chooser?: string; start?: string; lvl?: string }>();
  const { t } = useTranslation();
  const { isRTL, language } = useDirection();
  const profile = useProfileStore();
  const router = useRouter();
  const navigation = useNavigation();
  const { colors } = useTheme();

  const [cards, setCards] = useState<CardData[]>(() => sessionCache.cards);
  const [active, setActive] = useState<ActiveCard | null>(() => sessionCache.activeCard);
  const [score, setScore] = useState(() => sessionCache.score);
  // Consecutive-correct combo counter (resets on any miss) — pure feedback
  // "juice", displayed as a small badge while a run is in progress.
  const [combo, setCombo] = useState(() => sessionCache.combo);
  const [loading, setLoading] = useState(true);
  const [dailyMode, setDailyMode] = useState(() => params.dailyMode === '1' || sessionCache.dailyMode);
  const [timerValue, setTimerValue] = useState(0);
  const [timerMax, setTimerMax] = useState(0);
  const [reportVisible, setReportVisible] = useState(false);
  const [reportCard, setReportCard] = useState<CardData | null>(null);
  const [reportMsg, setReportMsg] = useState('');
  const [dailyEndVisible, setDailyEndVisible] = useState(false);
  const [dailyFinalScore, setDailyFinalScore] = useState(0);
  const [dailyMistakes, setDailyMistakes] = useState<MistakeRecord[]>([]);
  // Post-win engagement: a live rank-comparison line against today's actual
  // participants (the same cohort the league screen's اليوم tab shows), fetched
  // once the daily quiz ends (null while loading/unavailable).
  const [dailyRankLine, setDailyRankLine] = useState<string | null>(null);
  // Non-blocking "today's quiz is ready" banner — set by checkForDailyQuiz(),
  // shown above the cards, dismissed by the user tapping either action.
  const [dailyBannerHead, setDailyBannerHead] = useState<FB.DailyHead | null>(null);
  // Progress-milestone toast (e.g. "🏅 أتقنت سورة البقرة!") — fires at most one
  // at a time; a fresh milestone replaces whatever's currently showing.
  const [milestoneToast, setMilestoneToast] = useState<string | null>(null);
  const milestoneOpacity = useRef(new Animated.Value(0)).current;
  const milestoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Session chooser — shown when no mode or part is pre-set
  const [chooserVisible, setChooserVisible] = useState(
    params.dailyMode !== '1' && !params.customPart && !params.start,
  );
  // Post-session summary
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryMistakes, setSummaryMistakes] = useState<MistakeRecord[]>([]);
  // Mirror of customPartRef as state, so the read-only settings strip re-renders
  // when the active scope changes (refs alone don't trigger a render).
  const [customPartIndex, setCustomPartIndex] = useState<number | null>(() => sessionCache.customPart);
  const [weakReviewParts, setWeakReviewParts] = useState<number[] | null>(() => sessionCache.weakReviewParts);

  const listRef = useRef<FlatList>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cardCounterRef = useRef(sessionCache.cardCounter);
  const sessionCorrectRef = useRef(sessionCache.sessionCorrect);
  const sessionAnsweredRef = useRef(sessionCache.sessionAnswered);
  const sessionMistakesRef = useRef<MistakeRecord[]>(sessionCache.mistakes);
  const dailyScoreRef = useRef(sessionCache.dailyScore);
  const dailyTimeRef = useRef(sessionCache.dailyTime);
  const dailyTimeInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guard: prevents loadNextQuestion from re-entering after daily quiz ends
  const dailyEndedRef = useRef(sessionCache.dailyEnded);
  // Prevents loadNextQuestion from re-entering while a load is already in flight.
  const loadingNextRef = useRef(false);
  // An answered card is owed its next question (auto-advance scheduled). Lets
  // "حسناً" advance immediately and dedupes with the timer.
  const advancePendingRef = useRef(false);
  // True between the Nth-correct answer and the summary modal appearing, so the
  // OK-button stall-recovery doesn't skip past the pending summary.
  const summaryPendingRef = useRef(false);

  // Tracks the last navigation nonce we acted on, so a tab refocus (no new nonce)
  // does not restart a stale deep-linked sura. Restored from cache so a remount
  // doesn't treat a still-present nonce as a fresh deep-link.
  const lastNonceRef = useRef<string | undefined>(sessionCache.lastNonce);
  // Same idea for the shared-question link (/quiz?start=<wordIdx>): track the last
  // ?start value we acted on so a tab refocus doesn't restart it.
  const lastStartRef = useRef<string | undefined>(sessionCache.lastStart);
  // Word index for the *next* question to start at exactly (a shared question),
  // consumed once by loadNextQuestion; null ⇒ normal random selection.
  const pendingStartIdxRef = useRef<number | null>(null);
  // Level the shared question was created at (from ?lvl), so it reproduces exactly
  // regardless of the viewer's own level; null ⇒ use the viewer's level.
  const pendingStartLevelRef = useRef<number | null>(null);
  // True while a quiz run is in progress (and resumable). Lets us tell a genuine
  // in-progress session (return from the Me tab) apart from a fresh entry.
  const sessionActiveRef = useRef(sessionCache.active);
  // Mirror of dailyMode for use inside the focus callback (avoids stale closure).
  const dailyModeRef = useRef(sessionCache.dailyMode);
  // Selected sura/juz part for "custom part" mode. null ⇒ random across the
  // profile's enabled parts. When set, questions are drawn at random from within
  // this single part's word range only (bypassing the profile's part selection).
  const customPartRef = useRef<number | null>(sessionCache.customPart);
  const weakReviewPartsRef = useRef<number[] | null>(sessionCache.weakReviewParts);

  // Mirror the visible session into the module cache so it survives a remount.
  useEffect(() => {
    sessionCache.cards = cards;
    sessionCache.activeCard = active;
    sessionCache.score = score;
    sessionCache.dailyMode = dailyMode;
    sessionCache.combo = combo;
  }, [cards, active, score, dailyMode, combo]);

  const sessionModeRef = useRef<QuizMode>('random');
  const sessionStartScoreRef = useRef<number>(0);
  // How much of sessionAnswered/sessionCorrect a prior beacon (see the
  // background/tab-hide flush below) already reported, so a later flush sends
  // only the delta instead of double-counting.
  const flushedAnsweredRef = useRef(0);
  const flushedCorrectRef = useRef(0);

  // `final=false` is a best-effort beacon fired when the app is backgrounded or
  // the web tab is hidden — the only reliable signal that a session that never
  // hits an in-app "exit" action (closing the tab, killing the app, locking the
  // phone) is ending. It reports progress without tearing the session down, so
  // a user who returns and keeps playing is still tracked as one run once they
  // do eventually exit for real.
  function emitSessionComplete(dailyScoreOverride?: number, final: boolean = true) {
    const isDaily = sessionModeRef.current === 'daily';
    const decision = decideSessionComplete({
      sessionActive: sessionActiveRef.current,
      isDaily,
      final,
      answered: sessionAnsweredRef.current,
      correct: sessionCorrectRef.current,
      flushedAnswered: flushedAnsweredRef.current,
      flushedCorrect: flushedCorrectRef.current,
    });
    if (decision.endSession) sessionActiveRef.current = false;
    if (!decision.fire) return;

    const earnedScore = isDaily
      ? (dailyScoreOverride ?? dailyScoreRef.current)
      : Math.max(0, profile.getScore() - sessionStartScoreRef.current);

    trackEvent('quiz_session_complete', {
      mode: sessionModeRef.current,
      correct: decision.correctDelta,
      answered: decision.answeredDelta,
      score: earnedScore,
    });

    flushedAnsweredRef.current = sessionAnsweredRef.current;
    flushedCorrectRef.current = sessionCorrectRef.current;
    sessionStartScoreRef.current = profile.getScore();
  }

  // Guard against a stray setState after the screen unmounts mid-fade.
  useEffect(() => {
    return () => {
      if (milestoneTimerRef.current) clearTimeout(milestoneTimerRef.current);
      if (sessionActiveRef.current && sessionAnsweredRef.current > 0) {
        emitSessionComplete();
      }
    };
  }, []);

  // A React unmount only happens on in-app navigation (and only on web, where
  // expo-router unmounts inactive tabs — see the SessionCache comment above);
  // it never fires when someone just closes the tab, backgrounds the app, or
  // locks the phone mid-quiz, which is how most casual sessions actually end.
  // Without this, `quiz_session_complete` only fires via an explicit in-app
  // exit action, undercounting real completions.
  useEffect(() => {
    function flushIfLeaving() {
      if (sessionModeRef.current === 'daily') return; // daily has its own end-of-quiz flow
      emitSessionComplete(undefined, false);
    }
    if (Platform.OS === 'web') {
      const onVisibility = () => { if (document.visibilityState === 'hidden') flushIfLeaving(); };
      document.addEventListener('visibilitychange', onVisibility);
      return () => document.removeEventListener('visibilitychange', onVisibility);
    }
    const sub = AppState.addEventListener('change', (next) => { if (next === 'background') flushIfLeaving(); });
    return () => sub.remove();
  }, []);

  // Reclaim the header: show the live score while a run is in progress instead
  // of repeating the app's name on every tab (see (app)/_layout.tsx's default).
  const inRun = !chooserVisible && cards.length > 0;
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <Text style={{ color: '#fff', fontSize: 16, fontFamily: 'PlexArabic-Bold' }}>
          {inRun ? t('quiz.scorePoints', { count: localeNum(score, language) }) : t('quiz.startQuiz')}
        </Text>
      ),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRun, score, language, t]);

  // Reset all per-session state, then start a fresh run.
  //   { daily: true }        → daily quiz
  //   { partIndex: i }       → "custom part": random questions within sura/juz i
  //   { startIdx: w,         → shared question: first question starts at word w
  //     startLevel: n }        (at level n, if given), then random thereafter
  //   {}                     → random across the profile's enabled parts
  function startSession(opts: { daily?: boolean; partIndex?: number | null; startIdx?: number; startLevel?: number; weakReview?: boolean }) {
    const daily = !!opts.daily;
    if (sessionActiveRef.current && sessionAnsweredRef.current > 0) {
      if (!daily || !shouldSuspendNormalRun(sessionActiveRef.current, dailyModeRef.current)) {
        emitSessionComplete();
      }
    }
    if (daily) {
      // Entering the daily quiz: if a normal run is live, suspend it (with its
      // own card stack + engine state) so it can reappear once the daily ends.
      if (shouldSuspendNormalRun(sessionActiveRef.current, dailyModeRef.current)) {
        sessionCache.normalSnapshot = {
          cards: sessionCache.cards,
          active: sessionCache.activeCard,
          cardCounter: cardCounterRef.current,
          sessionCorrect: sessionCorrectRef.current,
          sessionAnswered: sessionAnsweredRef.current,
          mistakes: sessionMistakesRef.current,
          customPart: customPartRef.current,
          weakReviewParts: weakReviewPartsRef.current,
          qo: deepCopy(QS.qo),
          seed: profile.lastSeed,
          sessionMode: sessionModeRef.current,
          sessionStartScore: sessionStartScoreRef.current,
          flushedAnswered: flushedAnsweredRef.current,
          flushedCorrect: flushedCorrectRef.current,
        };
      }
    } else {
      // A fresh normal run replaces any previously suspended one.
      sessionCache.normalSnapshot = null;
    }
    clearTimers();
    setChooserVisible(false);
    setCards([]);
    setActive(null);
    setDailyMode(daily);
    dailyModeRef.current = daily;
    setDailyBannerHead(null); // no point advertising "today's quiz is ready" once it's started (or a fresh run begins)
    const weakParts = opts.weakReview
      ? profile.getWeakCheckedParts(5).map((p) => p.index)
      : null;
    weakReviewPartsRef.current = weakParts;
    setWeakReviewParts(weakParts);
    customPartRef.current = opts.weakReview ? null : (opts.partIndex ?? null);
    setCustomPartIndex(opts.weakReview ? null : (opts.partIndex ?? null));
    // A shared question forces the first question's start word (and level);
    // cleared after use.
    pendingStartIdxRef.current = opts.startIdx ?? null;
    pendingStartLevelRef.current = opts.startLevel ?? null;
    const mode: QuizMode = daily
      ? 'daily'
      : opts.weakReview
      ? 'weak_review'
      : opts.startIdx != null
      ? 'shared'
      : opts.partIndex != null
      ? 'custom'
      : 'random';
    sessionActiveRef.current = true;
    sessionModeRef.current = mode;
    sessionStartScoreRef.current = profile.getScore();
    cardCounterRef.current = 0;
    sessionCorrectRef.current = 0;
    sessionAnsweredRef.current = 0;
    sessionMistakesRef.current = [];
    flushedAnsweredRef.current = 0;
    flushedCorrectRef.current = 0;
    setCombo(0);
    dailyScoreRef.current = 0;
    dailyTimeRef.current = 0;
    dailyEndedRef.current = false;
    syncCacheFlags();
    trackEvent('quiz_start', {
      mode,
      level: profile.level,
      part: opts.partIndex ?? undefined,
    });
    if (profile.recordPlay()) void FB.pushCurrentProfile();
    // Re-arm the "don't lose your streak" reminder for tomorrow evening now that
    // today's play is recorded (no-op without permission, cleared if streak is 0).
    scheduleStreakReminder(useProfileStore.getState().streak);
    QS.initQuestionnaire(profile.lastSeed);
    setScore(profile.getScore());
    if (daily) {
      startDailyTimeTracker();
    }
    loadNextQuestion();
  }

  // Resume an in-progress session left running on this (persistent) tab — e.g.
  // after popping over to the Me tab to toggle suras. Cards + the current
  // question are preserved; any sura changes apply to subsequent questions.
  function resumeSession() {
    setLoading(false);
    setScore(profile.getScore());
    if (dailyModeRef.current && !dailyEndedRef.current) {
      // Daily is timed: re-arm the elapsed-time tracker and the question timer.
      startDailyTimeTracker();
      startTimer(12);
    }
  }

  // Recover a session that is flagged active but has no answerable question
  // (e.g. the first/next question failed to load earlier, or the engine's `qo`
  // was lost). Re-arms the engine and generates a question so the screen is
  // usable again rather than dead.
  function recoverStrandedSession() {
    if (dailyModeRef.current) {
      if (dailyEndedRef.current) { openChooser(); return; }
      // Daily still in progress but lost its question → re-arm and generate.
      setLoading(true);
      if (dailyTimeInterval.current == null) {
        startDailyTimeTracker();
      }
      loadNextQuestion();
      return;
    }
    // Normal session: re-seat the engine from the saved seed, then load.
    setLoading(true);
    QS.initQuestionnaire(profile.lastSeed);
    loadNextQuestion();
  }

  // Reset to the start chooser (random / specific sura).
  function openChooser() {
    if (sessionActiveRef.current && sessionAnsweredRef.current > 0) {
      emitSessionComplete();
    }
    clearTimers();
    setCards([]);
    setActive(null);
    setDailyMode(false);
    dailyModeRef.current = false;
    setDailyBannerHead(null);
    setCombo(0);
    customPartRef.current = null;
    setCustomPartIndex(null);
    weakReviewPartsRef.current = null;
    setWeakReviewParts(null);
    sessionActiveRef.current = false;
    dailyEndedRef.current = false;
    syncCacheFlags();
    setScore(profile.getScore());
    setChooserVisible(true);
  }

  // Bring back a normal run that was suspended for a daily quiz. Restores its
  // card stack and the engine state (active question + seed) so the user can
  // keep answering where it left off. Returns true if a suspended run existed.
  function restoreNormalSession(): boolean {
    const snap = sessionCache.normalSnapshot;
    if (!snap) return false;
    sessionCache.normalSnapshot = null;
    clearTimers();
    // Re-seat the questionnaire engine on the suspended normal question.
    QS.initQuestionnaire(snap.seed);
    QS.setQo(snap.qo);
    profile.setLastSeed(snap.seed);

    dailyModeRef.current = false;
    customPartRef.current = snap.customPart;
    weakReviewPartsRef.current = snap.weakReviewParts ?? null;
    sessionActiveRef.current = true;
    sessionModeRef.current = snap.sessionMode;
    sessionStartScoreRef.current = snap.sessionStartScore;
    dailyEndedRef.current = false;
    cardCounterRef.current = snap.cardCounter;
    sessionCorrectRef.current = snap.sessionCorrect;
    sessionAnsweredRef.current = snap.sessionAnswered;
    sessionMistakesRef.current = snap.mistakes ?? [];
    flushedAnsweredRef.current = snap.flushedAnswered;
    flushedCorrectRef.current = snap.flushedCorrect;
    dailyScoreRef.current = 0;
    dailyTimeRef.current = 0;

    setDailyMode(false);
    setCustomPartIndex(snap.customPart);
    setWeakReviewParts(snap.weakReviewParts ?? null);
    setCards(snap.cards);
    setActive(snap.active);
    setScore(profile.getScore());
    // The combo streak isn't part of the snapshot (kept simple) — the daily
    // quiz that just ran had its own combo anyway, so start the resumed run's
    // combo fresh rather than pretending to reconstruct the pre-suspend value.
    setCombo(0);
    syncCacheFlags();
    return true;
  }

  // Push the ref-held flags/counters into the module cache (refs alone don't
  // trigger the state-sync effect above).
  function syncCacheFlags() {
    sessionCache.active = sessionActiveRef.current;
    sessionCache.dailyMode = dailyModeRef.current;
    sessionCache.dailyEnded = dailyEndedRef.current;
    sessionCache.cardCounter = cardCounterRef.current;
    sessionCache.sessionCorrect = sessionCorrectRef.current;
    sessionCache.sessionAnswered = sessionAnsweredRef.current;
    sessionCache.mistakes = sessionMistakesRef.current;
    sessionCache.dailyScore = dailyScoreRef.current;
    sessionCache.dailyTime = dailyTimeRef.current;
    sessionCache.customPart = customPartRef.current;
    sessionCache.weakReviewParts = weakReviewPartsRef.current;
  }

  // ── on focus: decide what to show every time the screen is entered ─────────
  // Persistent tab ⇒ component stays mounted, so this is the only reliable hook
  // for re-offering the chooser / resuming / starting on re-entry.
  useFocusEffect(useCallback(() => {
    // Fresh shared-question link (/quiz?start=<wordIdx>). Acted on once per value
    // so a tab refocus (same URL) doesn't restart it — then it falls through to
    // the normal session logic (which will `resume`).
    if (params.start && params.start !== lastStartRef.current) {
      lastStartRef.current = params.start;
      sessionCache.lastStart = params.start;
      const idx = parseInt(params.start, 10);
      if (isFinite(idx) && idx > 0) {
        const lvl = params.lvl != null ? parseInt(params.lvl, 10) : NaN;
        const startLevel = isFinite(lvl) && lvl >= 0 && lvl <= 3 ? lvl : undefined;
        startSession({ startIdx: idx, startLevel });
        return () => { clearTimers(); };
      }
    }
    const action = decideFocusFromContext({
      pendingDailyStart: QS.pendingDailyStart,
      customPartParam: params.customPart,
      chooserParam: params.chooser,
      nonceParam: params.nonce,
      lastActedNonce: lastNonceRef.current,
      sessionActive: sessionActiveRef.current,
      hasActiveCard: !!sessionCache.activeCard,
      // Guards the dead-screen case where the engine's qo was reset/lost.
      engineAnswerable: isAnswerable(QS.qo),
      // A flipped card (flipTrigger > 0) has already been answered; resuming it
      // would strand the user, so treat it as needing recovery.
      activeCardFlipTrigger: sessionCache.activeCard?.flipTrigger ?? 0,
    });
    switch (action) {
      case 'start-daily':
        QS.clearPendingDailyStart();
        startSession({ daily: true });
        break;
      case 'start-part':
        // Fresh deep-link to a specific sura/juz (from home weak-sura or the Me list).
        lastNonceRef.current = params.nonce;
        sessionCache.lastNonce = params.nonce;
        startSession({ partIndex: parseInt(params.customPart!) });
        break;
      case 'resume':
        // Returning to a live session (e.g. from the Me tab) ⇒ keep the scroll.
        resumeSession();
        break;
      case 'recover':
        // Session flagged active but nothing to answer ⇒ re-arm instead of
        // stranding the user on a blank screen with no question.
        recoverStrandedSession();
        break;
      case 'chooser':
        // Plain entry with no live session, or an explicit "start a quiz"
        // request. Record the nonce so a tab refocus doesn't reopen the chooser
        // and wipe a session the user starts from it.
        lastNonceRef.current = params.nonce;
        sessionCache.lastNonce = params.nonce;
        openChooser();
        break;
    }
    return () => { clearTimers(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.customPart, params.nonce, params.chooser, params.start, params.lvl]));

  function clearTimers() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (dailyTimeInterval.current) clearInterval(dailyTimeInterval.current);
  }

  // Daily elapsed-time tracker — accumulates the time the daily score is graded
  // against. Paused while the user reviews a flipped card (between answering and
  // pressing "حسناً"), so review time isn't counted; resumed on the next question.
  function startDailyTimeTracker() {
    if (dailyTimeInterval.current) clearInterval(dailyTimeInterval.current);
    dailyTimeInterval.current = setInterval(() => {
      dailyTimeRef.current += 1000;
      sessionCache.dailyTime = dailyTimeRef.current;
    }, 1000);
  }
  function stopDailyTimeTracker() {
    if (dailyTimeInterval.current) { clearInterval(dailyTimeInterval.current); dailyTimeInterval.current = null; }
  }

  // ── load next question ────────────────────────────────────────────────────
  // Source of truth is the refs (dailyModeRef / customPartRef), set before each
  // call — avoids stale-closure issues with state.
  // Advance to the next question, deduped: whichever of the auto-advance timer
  // or the "حسناً" button fires first wins; the other becomes a no-op.
  function tryAdvance() {
    if (!advancePendingRef.current || loadingNextRef.current) return;
    advancePendingRef.current = false;
    loadNextQuestion();
  }

  async function loadNextQuestion() {
    const daily = dailyModeRef.current;
    // Guard: once the daily quiz has ended, the timer must not restart the loop
    if (daily && dailyEndedRef.current) return;
    if (loadingNextRef.current) return; // a load is already in flight
    loadingNextRef.current = true;
    setLoading(true);
    try {
      if (daily) {
        const hasMore = await QS.createNextDailyQ(
          profile.getSparsePoint.bind(profile),
          profile.getTotalStudyLength.bind(profile),
          profile.level,
          profile.getPartIndexOf.bind(profile),
        );
        if (!hasMore) {
          dailyEndedRef.current = true;
          await endDailyQuiz();
          return;
        }
      } else if (weakReviewPartsRef.current != null && weakReviewPartsRef.current.length > 0) {
        // Weak Review: draw a random word from across all snapshotted weak parts combined.
        const weakIndices = weakReviewPartsRef.current;
        const scope: MatchScopePart[] = weakIndices.map((i) => ({
          start: profile.parts[i].start,
          length: profile.parts[i].length,
          partIndex: i,
        }));
        const totalLen = scope.reduce((acc, p) => acc + p.length, 0);
        const sparsePoint = (n: number) => {
          const offset = totalLen > 0 ? (n - 1) % totalLen : 0;
          const idx = wordAtScopeOffset(scope, offset);
          const part = profile.getPartIndexOf(idx);
          return { idx, part };
        };
        const total = () => totalLen;
        await QS.createNextQ(
          undefined,
          sparsePoint,
          total,
          profile.level,
          profile.specialEnabled,
          profile.isSurasSpecialQuestionEligible(),
          profile.getPartIndexOf.bind(profile),
        );
      } else if (customPartRef.current != null) {
        // Custom Sura/Juz: draw a random word from within this part's range only.
        const pi = customPartRef.current;
        const part = profile.parts[pi];
        const sparsePoint = (n: number) => ({
          idx: part.start + ((n - 1) % part.length),
          part: pi,
        });
        const total = () => part.length;
        await QS.createNextQ(
          undefined,
          sparsePoint,
          total,
          profile.level,
          profile.specialEnabled,
          profile.isSurasSpecialQuestionEligible(),
          profile.getPartIndexOf.bind(profile),
        );
      } else if (pendingStartIdxRef.current != null) {
        // Shared question (/quiz?start=<wordIdx>): reproduce the exact question at
        // this word. Use createNormalQ directly so it can't be swapped for a
        // random "special" question. Consumed once — later questions go random.
        const startIdx = pendingStartIdxRef.current;
        const startLevel = pendingStartLevelRef.current;
        pendingStartIdxRef.current = null;
        pendingStartLevelRef.current = null;
        await QS.createNormalQ(
          startIdx,
          profile.getSparsePoint.bind(profile),
          profile.getTotalStudyLength.bind(profile),
          profile.level,
          startLevel ?? undefined,   // reproduce at the shared level when provided
          profile.getPartIndexOf.bind(profile),
        );
      } else {
        await QS.createNextQ(
          undefined,
          profile.getSparsePoint.bind(profile),
          profile.getTotalStudyLength.bind(profile),
          profile.level,
          profile.specialEnabled,
          profile.isSurasSpecialQuestionEligible(),
          profile.getPartIndexOf.bind(profile),
        );
      }
      profile.setLastSeed(QS.qo.startIdx);
      const aya = await ayaNumberOf(QS.qo.startIdx);
      const wordOffset = await wordOffsetInAya(QS.qo.startIdx);
      const newCard: CardData = {
        index: cards.length,
        qo: deepCopy(QS.qo),
        answerAya: aya,
        wordOffset,
        socialURL: `https://quranquiz.net/quiz?start=${QS.qo.startIdx}&lvl=${QS.qo.level}`,
      };
      setCards((prev) => [...prev, newCard]);
      setActive(makeActive(QS.qo));
      advancePendingRef.current = false; // a fresh, unanswered question is now active
      cardCounterRef.current++;
      syncCacheFlags();
      const cc = cardCounterRef.current;
      if (!daily && (cc - DAILYQUIZ_CHECKAFTER) % DAILYQUIZ_CHECKEVERY === 0) {
        checkForDailyQuiz();
      }
      // Start the per-question timer only after a question was successfully loaded,
      // and resume the elapsed-time tracker (paused while reviewing the prior card).
      if (daily) { startTimer(12); startDailyTimeTracker(); }
    } catch (e) {
      console.error('loadNextQuestion error:', e);
      // If the failure left the screen with nothing to answer, don't strand the
      // user — drop back to the chooser so there is always an available action.
      if (sessionCache.cards.length === 0) {
        sessionActiveRef.current = false;
        syncCacheFlags();
        setChooserVisible(true);
      }
    } finally {
      loadingNextRef.current = false;
      setLoading(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 200);
    }
  }

  // ── option selection ──────────────────────────────────────────────────────
  function selectOption(optionIndex: number) {
    if (!active) return;
    const isWrong = active.shuffle[optionIndex] !== 0;
    const isLastRound = active.round + 1 === QS.qo.rounds;

    if (isWrong) {
      handleIncorrect(optionIndex);
    } else if (isLastRound) {
      handleCorrect(optionIndex);
    } else {
      // advance round
      const newRound = active.round + 1;
      const newShuffle = randperm(5);
      const questionSoFar = QS.qo.txt.answer
        .split(' ')
        .slice(0, QS.qo.qLen + QS.qo.oLen * newRound)
        .join(' ');
      // update the last card's question text
      setCards((prev) => {
        const next = [...prev];
        const last = { ...next[next.length - 1] };
        last.qo = { ...last.qo, txt: { ...last.qo.txt, question: questionSoFar } };
        next[next.length - 1] = last;
        return next;
      });
      setActive({
        round: newRound,
        shuffle: newShuffle,
        shuffledOptions: shuffleByPerm(QS.qo.txt.op[newRound] ?? [], newShuffle),
        flipTrigger: 0,
        isCorrect: false,
        pickedIndex: null,
      });
      // The question grew a line — scroll so the options stay in view.
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
      if (dailyMode) startTimer(5);
    }
  }

  // Shared tail for both answer handlers: bump the answered counter, then either
  // break for the post-session summary (every Nth answered question) or schedule
  // the auto-advance to the next card.
  function afterAnswer() {
    sessionAnsweredRef.current++;
    syncCacheFlags();
    // The card is now flipped (answered). Stop the daily per-question timer so it
    // can't fire skipQ() on the already-answered card while we wait for the user,
    // and pause the elapsed-time tracker so card-review time isn't graded.
    clearTimer();
    if (dailyMode) stopDailyTimeTracker();
    if (shouldShowSummary(sessionAnsweredRef.current, dailyMode)) {
      profile.updateScoreRecord();
      maybeRequestNotificationPermission();
      setSummaryMistakes(sessionMistakesRef.current);
      sessionMistakesRef.current = [];
      syncCacheFlags();
      summaryPendingRef.current = true;
      setTimeout(() => { summaryPendingRef.current = false; setSummaryVisible(true); }, 650);
    } else {
      // Do NOT auto-create the next question. The next questionnaire is generated
      // only once the user reviews the flipped card and presses "حسناً" (OK),
      // which routes through onScrollDown → tryAdvance. Applies to both the normal
      // quiz and the daily quiz.
      advancePendingRef.current = true;
    }
  }

  // Show a milestone toast for ~3s (quick fade in/out), replacing whatever's
  // currently displayed. Cheap: no animation library needed beyond RN's own.
  function showMilestoneToast(text: string) {
    if (milestoneTimerRef.current) clearTimeout(milestoneTimerRef.current);
    setMilestoneToast(text);
    milestoneOpacity.setValue(0);
    Animated.timing(milestoneOpacity, { toValue: 1, duration: 200, useNativeDriver: NATIVE_DRIVER }).start();
    milestoneTimerRef.current = setTimeout(() => {
      Animated.timing(milestoneOpacity, { toValue: 0, duration: 300, useNativeDriver: NATIVE_DRIVER })
        .start(() => setMilestoneToast(null));
    }, 2800);
  }

  function handleCorrect(pickedIndex?: number) {
    // Snapshot this part's "counted" correct total + accuracy tier BEFORE the
    // update, so we can detect a just-crossed milestone after it lands.
    const partIdx = QS.qo.currentPart;
    const partBefore = profile.parts[partIdx];
    const beforeCorrect = partBefore ? countedScore(partBefore.numCorrect) : 0;
    const beforeTier = tierFromRatioRange(profile.getCorrectRatioRange(partIdx));

    profile.addCorrect(QS.qo);
    setScore(profile.getScore());
    if (dailyMode) dailyScoreRef.current++;
    sessionCorrectRef.current++;
    setCombo((c) => c + 1);
    syncCacheFlags();

    // profile.addCorrect() updates the Zustand store synchronously (its `set()`
    // call runs before the function's first await), so the store already
    // reflects the update here even though addCorrect's own promise is pending.
    const partAfter = useProfileStore.getState().parts[partIdx];
    if (partAfter) {
      const afterCorrect = countedScore(partAfter.numCorrect);
      const afterTier = tierFromRatioRange(useProfileStore.getState().getCorrectRatioRange(partIdx));
      const milestones = detectMilestones({
        partName: translatePartName(partAfter.name), beforeCorrect, afterCorrect, beforeTier, afterTier,
      });
      if (milestones.length > 0) showMilestoneToast(milestones[0].text);
    }

    hapticCorrect();
    playCorrectSound();
    // Store wasCorrect in the card so historical cards keep the right border color
    setCards((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], wasCorrect: true };
      return next;
    });
    setActive((a) => a ? { ...a, flipTrigger: a.flipTrigger + 1, isCorrect: true, pickedIndex: pickedIndex ?? a.shuffle.indexOf(0) } : null);
    afterAnswer();
  }

  function handleIncorrect(pickedIndex?: number) {
    profile.addIncorrect(QS.qo);
    setScore(profile.getScore());
    setCombo(0);
    hapticIncorrect();
    playIncorrectSound();
    setCards((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], wasCorrect: false };
      return next;
    });
    setActive((a) => a ? { ...a, flipTrigger: a.flipTrigger + 1, isCorrect: false, pickedIndex: pickedIndex ?? null } : null);

    const card = cards[cards.length - 1];
    if (card && active) {
      const round = active.round;
      const errorEnd = card.wordOffset + card.qo.qLen + (round + 1) * card.qo.oLen - 1;
      const hideTitle = !reachesNewSuraContent(card.qo.startIdx, card.qo.startIdx + (errorEnd - card.wordOffset));
      const suraNum = getSuraIdx(card.qo.startIdx) + 1;
      const correctText = QS.qo.txt.op[round]?.[0] ?? '';
      const pickedText = pickedIndex != null ? (active.shuffledOptions[pickedIndex] ?? '') : '';
      const mistake = buildMistakeRecord({
        id: `${card.index}-${round}`,
        qo: card.qo,
        round,
        wordOffset: card.wordOffset,
        aya: card.answerAya,
        suraNum,
        hideTitle,
        pickedText,
        correctText,
      });
      sessionMistakesRef.current.push(mistake);
      syncCacheFlags();
    }

    afterAnswer();
  }

  // Timeout or explicit "لا أعلم" — no option was picked, so only the correct
  // one flashes on reveal (no red marker).
  function skipQ() { handleIncorrect(); }

  // ── daily quiz ────────────────────────────────────────────────────────────
  // Was a blocking window.confirm/Alert.alert popping up mid-run every N
  // questions — interrupted whatever the user was doing to force a yes/no
  // decision. Now just surfaces a dismissible banner (dailyBannerHead) above
  // the cards; the current question flow is completely undisturbed until (and
  // unless) the user taps it.
  async function checkForDailyQuiz() {
    try {
      const today = new Date().toISOString().split('T')[0];
      // A prior completion is still awaiting confirmation (see endDailyQuiz) —
      // retry it now rather than re-offering a fresh quiz for the same day.
      if (profile.pendingDailySubmit) await FB.flushPendingDailySubmit();
      // Don't re-offer today's daily quiz to someone who already completed it,
      // and don't bother if we're already inside the daily quiz itself.
      const freshProfile = useProfileStore.getState();
      if (freshProfile.lastDailyCompletedDate === today) return;
      if (freshProfile.pendingDailySubmit?.date === today) return;
      if (dailyModeRef.current) return;
      const head = await FB.getDailyHead();
      if (!head) return;
      setDailyBannerHead(head);
    } catch (e) {
      console.error('checkForDailyQuiz error:', e);
    }
  }

  function startDailyFromBanner() {
    if (!dailyBannerHead) return;
    const head = dailyBannerHead;
    setDailyBannerHead(null);
    const weights = profile.getDailyQuizStudyPartsWeights();
    QS.initDailyQuiz(head.daily_random, profile.parts, weights);
    // pendingDailyStart is now set; useFocusEffect won't re-fire since we're
    // already on this screen — handle directly:
    QS.clearPendingDailyStart();
    startSession({ daily: true });
  }

  function dismissDailyBanner() {
    setDailyBannerHead(null);
  }

  async function endDailyQuiz() {
    clearTimers();
    setDailyMode(false);
    dailyModeRef.current = false;
    sessionActiveRef.current = false;
    dailyEndedRef.current = true;
    const finalScore = profile.getDailyQuizScore(
      dailyScoreRef.current,
      dailyTimeRef.current / 1000,
    );
    profile.updateScoreRecord();
    setDailyFinalScore(finalScore);
    setDailyRankLine(null);
    setDailyMistakes(sessionMistakesRef.current);
    sessionMistakesRef.current = [];
    syncCacheFlags();
    // Show the result screen immediately — don't make the user wait on the
    // network for a score they've already earned locally.
    setDailyEndVisible(true);
    trackEvent('daily_quiz_submit', {
      score: finalScore,
      correct: dailyScoreRef.current,
      time_sec: Math.round(dailyTimeRef.current / 1000),
    });
    emitSessionComplete(finalScore);

    const today = new Date().toISOString().split('T')[0];
    const social = profile.social;
    const payload = {
      score: finalScore,
      // A guest's own nickname (stored as displayName like a social user's)
      // takes priority over the generic default — first word only, matching
      // how a social display name is already truncated below.
      name: (social.displayName || DEFAULT_GUEST_NAME).split(' ')[0],
      uid: profile.uid,
      country: profile.country || undefined,
    };
    // Persist the pending submission *before* attempting the write, not just
    // on failure — the result screen above is already shown, so a user who
    // closes/backgrounds the app during the retry+backoff window (several
    // seconds on a bad connection) must not lose the completion with no
    // trace: flushPendingDailySubmit (app start + checkForDailyQuiz) can only
    // recover what was actually saved to disk before that happened.
    profile.setPendingDailySubmit({ ...payload, date: today });
    // Only mark the quiz "completed" once the write is actually confirmed —
    // a completion that never reaches /daily/head_submit shouldn't block a
    // retry (see checkForDailyQuiz + profileStore.flushPendingDailySubmit).
    const confirmed = await FB.submitDailyResultWithRetry(payload);
    if (confirmed) {
      profile.markDailyCompleted(finalScore);
      profile.setPendingDailySubmit(null);
      void FB.pushCurrentProfile();
    }
    // Best-effort rank comparison against today's live standings — read after
    // the score post so the fresh submission is included; falls back gracefully
    // if not (e.g. RTDB replication lag or a network hiccup).
    FB.getTodayStandings()
      .then((entries) => setDailyRankLine(describeLiveRank(entries, profile.uid)))
      .catch(() => setDailyRankLine(null));
  }

  async function shareScoreDaily() {
    trackEvent('share_tap', { surface: 'daily_score_quiz' });
    try {
      // message already embeds the url; don't also pass `url`, or share
      // targets that surface both (e.g. iMessage) duplicate it.
      await Share.share({
        message: t('quiz.dailyEnd.shareMsg', {
          score: dailyFinalScore,
          appName: t('common.appName'),
        }),
      });
    } catch { /* ignore */ }
  }

  function practiceWeakestSura() {
    const weak = profile.getWeakCheckedParts(1)[0];
    if (!weak) return;
    setDailyEndVisible(false);
    router.push({ pathname: '/(app)/quiz', params: { customPart: String(weak.index), nonce: String(Date.now()) } });
  }

  // ── timer ─────────────────────────────────────────────────────────────────
  function startTimer(seconds: number) {
    clearTimer();
    setTimerMax(seconds);
    setTimerValue(seconds);
    timerRef.current = setInterval(() => {
      setTimerValue((v) => {
        if (v <= 1) {
          clearTimer();
          skipQ();
          return 0;
        }
        return v - 1;
      });
    }, 1000);
  }

  function clearTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  function onScrollDown() {
    listRef.current?.scrollToEnd({ animated: true });
    if (dailyMode) startTimer(12);
    if (advancePendingRef.current) {
      // "حسناً" pressed before the auto-advance fired → advance now (deduped).
      tryAdvance();
    } else if (
      sessionActiveRef.current && !dailyEndedRef.current && !summaryVisible
      && !summaryPendingRef.current && !loadingNextRef.current
      && (active?.flipTrigger ?? 0) > 0
    ) {
      // Stall recovery: the visible card is answered but nothing will advance it
      // (auto-advance already consumed/failed). Don't dead-end — load the next.
      loadNextQuestion();
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  function openReport(card: CardData) {
    setReportCard(card);
    setReportMsg('');
    setReportVisible(true);
  }

  async function submitReport() {
    if (reportCard) await FB.reportQuestion({ card: reportCard, msg: reportMsg });
    setReportVisible(false);
  }

  // ── render ────────────────────────────────────────────────────────────────
  // Read-only summary of the settings driving the current run.
  const scopeMode: ScopeMode = dailyMode ? 'daily' : weakReviewParts != null ? 'weakReview' : customPartIndex != null ? 'custom' : 'random';
  const levelTextKey = profile.levels.find((l) => l.value === profile.level)?.text;
  const levelText = levelTextKey ? t(levelTextKey) : '';
  const scopeNames =
    scopeMode === 'daily' ? []
    : scopeMode === 'weakReview' ? (weakReviewParts ?? []).map((i) => translatePartName(profile.parts[i]?.name ?? '—'))
    : scopeMode === 'custom' ? [translatePartName(profile.parts[customPartIndex!]?.name ?? '—')]
    : profile.parts.filter((p) => p.checked).map((p) => translatePartName(p.name));
  const showSettingsBar = !chooserVisible && cards.length > 0;

  const sessionAccuracy = sessionAnsweredRef.current > 0
    ? Math.round((sessionCorrectRef.current / sessionAnsweredRef.current) * 100)
    : 0;
  const weakestPart = profile.getTopBadParts()[0];

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['bottom']}>
      {loading && cards.length === 0 && !chooserVisible && (
        <View style={[s.loadingOverlay, { backgroundColor: colors.paper }]}>
          <ActivityIndicator size="large" color={colors.ink} />
        </View>
      )}

      {/* Non-blocking "today's quiz is ready" banner — tap to start, or dismiss
          and keep answering the current run undisturbed. Replaces the old
          window.confirm/Alert.alert that used to interrupt the run outright. */}
      {dailyBannerHead && !dailyMode && (
        <PressScale style={[s.dailyBanner, { backgroundColor: colors.gold, flexDirection: rowDir(isRTL) }]} onPress={startDailyFromBanner}>
          <Ionicons name="star" size={16} color={colors.navy} />
          <Text style={[s.dailyBannerTxt, { color: colors.navy, textAlign: alignDir(isRTL) }]}>{t('league.dailyReady')}</Text>
          <PressScale onPress={dismissDailyBanner} hitSlop={8} style={s.dailyBannerClose}>
            <Ionicons name="close" size={16} color={colors.navy} />
          </PressScale>
        </PressScale>
      )}

      {/* Progress-milestone celebration — a brief, non-blocking toast (fades
          in/out on its own); never interrupts answering. */}
      {milestoneToast && (
        <Animated.View
          pointerEvents="none"
          style={[s.milestoneToast, { backgroundColor: colors.navy, opacity: milestoneOpacity }]}
        >
          <Text style={s.milestoneToastTxt}>{milestoneToast}</Text>
        </Animated.View>
      )}

      {/* Consecutive-correct combo badge — pure feedback "juice", shown once
          there's an actual streak to brag about (2+); resets silently on a miss. */}
      {combo >= 2 && (
        <View style={[s.comboBadge, { backgroundColor: colors.gold, flexDirection: rowDir(isRTL), [isRTL ? 'right' : 'left']: 14 }]} pointerEvents="none">
          <Ionicons name="flame" size={13} color={colors.navy} />
          <Text style={[s.comboBadgeTxt, { color: colors.navy }]}>{t('quiz.streak', { count: localeNum(combo, language) })}</Text>
        </View>
      )}

      {showSettingsBar && (
        <QuizSettingsBar
          levelText={levelText}
          specialEnabled={profile.specialEnabled}
          scopeNames={scopeNames}
          scopeMode={scopeMode}
          dailyCurrent={cards.length}
          dailyTotal={DAILYQUIZ_QPERPART_COUNT}
        />
      )}

      {/* Session chooser — the screen's own idle state (not an overlay). The
          first thing a player sees on this tab when nothing is running. */}
      {chooserVisible ? (
        <ScrollView contentContainerStyle={s.chooserScreen} showsVerticalScrollIndicator={false}>
          <Text style={[s.chooserTitle, { color: colors.ink }]}>{t('quiz.startQuiz')}</Text>
          <PressScale
            style={[s.chooserPrimary, { backgroundColor: colors.gold, shadowColor: colors.goldDeep, flexDirection: rowDir(isRTL) }]}
            onPress={() => startSession({})}
          >
            <Ionicons name="shuffle" size={20} color={colors.navy} />
            <Text style={[s.chooserPrimaryTxt, { color: colors.navy }]}>{t('quiz.randomQuiz')}</Text>
          </PressScale>
          {profile.getWeakCheckedParts(3).length > 0 && (
            <>
              <Text style={[s.chooserSubtitle, { color: colors.inkSoft }]}>{t('quiz.reviewWeakSubtitle')}</Text>
              <View style={s.chooserList}>
                {profile.getWeakCheckedParts(2).length >= 2 && (
                  <PressScale
                    style={[s.chooserOption, { backgroundColor: colors.card, borderColor: colors.line, flexDirection: rowDir(isRTL) }]}
                    onPress={() => startSession({ weakReview: true })}
                  >
                    <Ionicons name={mirror(isRTL, 'chevron-forward', 'chevron-back')} size={16} color={colors.inkSoft} />
                    <Text style={[s.chooserOptionTxt, { color: colors.ink }]}>{t('quiz.reviewAllWeakBtn')}</Text>
                  </PressScale>
                )}
                {profile.getWeakCheckedParts(3).map(({ index, name }) => (
                  <PressScale
                    key={index}
                    style={[s.chooserOption, { backgroundColor: colors.card, borderColor: colors.line, flexDirection: rowDir(isRTL) }]}
                    onPress={() => startSession({ partIndex: index })}
                  >
                    <Ionicons name={mirror(isRTL, 'chevron-forward', 'chevron-back')} size={16} color={colors.inkSoft} />
                    <Text style={[s.chooserOptionTxt, { color: colors.ink }]}>{translatePartName(name)}</Text>
                  </PressScale>
                ))}
              </View>
            </>
          )}
        </ScrollView>
      ) : (
        <FlatList
          ref={listRef}
          data={cards}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item, index }) => {
            const isLast = index === cards.length - 1;
            return (
              <QuizCard
                card={item}
                isActive={isLast}
                score={score}
                scoreUp={QS.getUpScore()}
                isDailyMode={dailyMode}
                timerValue={timerValue}
                timerMax={timerMax}
                onSelectOption={isLast ? selectOption : () => {}}
                onSkip={isLast ? skipQ : () => {}}
                onScrollDown={onScrollDown}
                onReport={openReport}
                round={isLast ? (active?.round ?? 0) : (QS.qo.rounds - 1)}
                totalRounds={item.qo.rounds}
                shuffledOptions={isLast ? (active?.shuffledOptions ?? []) : (item.qo.txt.op[0] ?? [])}
                flipTrigger={isLast ? (active?.flipTrigger ?? 0) : 1}
                isCorrect={isLast ? (active?.isCorrect ?? false) : (item.wasCorrect ?? true)}
                correctIndex={isLast ? active?.shuffle.indexOf(0) : undefined}
                pickedIndex={isLast ? active?.pickedIndex : undefined}
              />
            );
          }}
          contentContainerStyle={s.listContent}
          centerContent
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Report modal — a genuine input form, stays a small centered card. */}
      <Modal visible={reportVisible} transparent animationType="slide" onRequestClose={() => setReportVisible(false)}>
        <View style={s.modalBg}>
          <View style={[s.modalBox, { backgroundColor: colors.card }]}>
            <Text style={[s.modalTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('common.reportModal.title')}</Text>
            <TextInput
              style={[s.reportInput, { borderColor: colors.line, color: colors.ink, textAlign: alignDir(isRTL) }]}
              placeholder={t('common.reportModal.placeholder')}
              placeholderTextColor={colors.inkSoft}
              value={reportMsg}
              onChangeText={setReportMsg}
              textAlign={alignDir(isRTL)}
            />
            <View style={s.modalRow}>
              <PressScale style={[s.btnCancel, { backgroundColor: colors.goldPale }]} onPress={() => setReportVisible(false)}>
                <Text style={[s.btnCancelText, { color: colors.inkSoft }]}>{t('common.reportModal.cancel')}</Text>
              </PressScale>
              <PressScale style={[s.btnConfirm, { backgroundColor: colors.navy }]} onPress={submitReport}>
                <Text style={s.btnConfirmText}>{t('common.reportModal.confirm')}</Text>
              </PressScale>
            </View>
          </View>
        </View>
      </Modal>

      {/* Daily quiz end — full-height sheet with an accuracy ring and one
          orchestrated celebration (confetti only at ≥80%). */}
      <Modal visible={dailyEndVisible} transparent animationType="slide" onRequestClose={() => setDailyEndVisible(false)}>
        <View style={s.sheetBg}>
          <Confetti active={dailyEndVisible && dailyFinalScore >= 80} />
          <View style={[s.sheet, { backgroundColor: colors.card }]}>
            <Text style={[s.sheetTitle, { color: colors.ink, fontFamily: 'Amiri-Regular' }]}>{t('quiz.dailyEnd.title')}</Text>
            <View style={s.sheetRingWrap}>
              <Ring pct={dailyFinalScore} color={colors.gold} trackColor={colors.goldPale} innerColor={colors.card} size={128} label={`${localeNum(Math.round(dailyFinalScore), language)}`} />
            </View>
            {dailyRankLine && <Text style={[s.rankLine, { color: colors.goldDeep }]}>{dailyRankLine}</Text>}
            <Text style={[s.modalBody, { color: colors.inkSoft, textAlign: 'center' }]}>{t('quiz.dailyEnd.body')}</Text>
            <View style={s.postWinRow}>
              <PressScale style={[s.postWinBtn, { backgroundColor: colors.goldPale }]} onPress={shareScoreDaily}>
                <Ionicons name="share-social-outline" size={16} color={colors.goldDeep} />
                <Text style={[s.postWinBtnTxt, { color: colors.goldDeep }]}>{t('quiz.dailyEnd.share')}</Text>
              </PressScale>
              {profile.getWeakCheckedParts(1).length > 0 && (
                <PressScale style={[s.postWinBtn, { backgroundColor: colors.goldPale }]} onPress={practiceWeakestSura}>
                  <Ionicons name="book-outline" size={16} color={colors.goldDeep} />
                  <Text style={[s.postWinBtnTxt, { color: colors.goldDeep }]}>{t('quiz.dailyEnd.practiceWeak')}</Text>
                </PressScale>
              )}
            </View>
            <MistakesReview mistakes={dailyMistakes} />
            <PressScale style={[s.btnConfirm, { backgroundColor: colors.navy }]} onPress={() => {
              setDailyEndVisible(false);
              if (shouldRestoreNormalRunAfterDaily(!!sessionCache.normalSnapshot)) restoreNormalSession();
              router.replace('/(app)/me');
            }}>
              <Text style={s.btnConfirmText}>{t('quiz.dailyEnd.ok')}</Text>
            </PressScale>
          </View>
        </View>
      </Modal>

      {/* Post-session summary — full-height sheet with an accuracy ring;
          confetti only at ≥80% (one orchestrated celebration, not four grey
          boxes). Replaces the identical center-modal treatment. */}
      <Modal visible={summaryVisible} transparent animationType="slide" onRequestClose={() => { setSummaryVisible(false); loadNextQuestion(); }}>
        <View style={s.sheetBg}>
          <Confetti active={summaryVisible && sessionAccuracy >= 80} />
          <View style={[s.sheet, { backgroundColor: colors.card }]}>
            <Text style={[s.sheetTitle, { color: colors.ink, fontFamily: 'Amiri-Regular' }]}>{t('quiz.summary.title')}</Text>
            <View style={s.sheetRingWrap}>
              <Ring pct={sessionAccuracy} color={colors.correct} trackColor={colors.correctPale} innerColor={colors.card} size={128} />
            </View>
            <Text style={[s.modalBody, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
              {t('quiz.summary.body', {
                correct: localeNum(sessionCorrectRef.current, language),
                total: localeNum(sessionAnsweredRef.current, language),
              })}
            </Text>
            <Text style={[s.bigScore, { color: colors.ink }]}>{localeNum(score, language)}</Text>
            <Text style={[s.modalBody, { color: colors.inkSoft, textAlign: 'center', marginBottom: 16 }]}>{t('quiz.summary.totalPoints')}</Text>
            {weakestPart !== '-' && (
              <Text style={[s.modalBody, { color: colors.goldDeep, textAlign: 'center' }]}>
                {t('quiz.summary.needsReview', { part: translatePartName(weakestPart) })}
              </Text>
            )}
            <MistakesReview mistakes={summaryMistakes} />
            <View style={s.modalRow}>
              <PressScale style={[s.btnCancel, { backgroundColor: colors.goldPale }]} onPress={() => { emitSessionComplete(); setSummaryVisible(false); router.replace('/(app)/me'); }}>
                <Text style={[s.btnCancelText, { color: colors.inkSoft }]}>{t('quiz.summary.home')}</Text>
              </PressScale>
              <PressScale style={[s.btnConfirm, { backgroundColor: colors.navy }]} onPress={() => { setSummaryVisible(false); loadNextQuestion(); }}>
                <Text style={s.btnConfirmText}>{t('quiz.summary.continue')}</Text>
              </PressScale>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingTop: 8, paddingBottom: 24, alignItems: 'center' },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  dailyBanner: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  dailyBannerTxt: { flex: 1, fontFamily: 'PlexArabic-Bold', fontSize: 13 },
  dailyBannerClose: { padding: 2 },
  milestoneToast: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    zIndex: 20,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: radii.pill,
    boxShadow: '0px 3px 10px rgba(0,0,0,0.25)',
    elevation: 6,
  },
  milestoneToastTxt: { color: '#fff', fontFamily: 'PlexArabic-Bold', fontSize: 13, textAlign: 'center' },
  comboBadge: {
    position: 'absolute',
    top: 10,
    zIndex: 15,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    boxShadow: '0px 2px 6px rgba(0,0,0,0.2)',
    elevation: 4,
  },
  comboBadgeTxt: { fontFamily: 'PlexArabic-Bold', fontSize: 12 },

  // ── Inline chooser — the screen's own idle state, not an overlay ──────────
  chooserScreen: { flexGrow: 1, padding: 20, gap: 12, alignItems: 'stretch', justifyContent: 'center' },
  chooserTitle: { fontSize: 22, fontFamily: 'PlexArabic-Bold', textAlign: 'center', marginBottom: 8 },
  chooserPrimary: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    paddingVertical: 18,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  chooserPrimaryTxt: { fontSize: 17, fontFamily: 'PlexArabic-Bold' },
  chooserSubtitle: { fontSize: 13, textAlign: 'center', marginTop: 16, marginBottom: 4 },
  chooserList: { gap: 8 },
  chooserOption: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radii.md,
    padding: 14,
    borderWidth: 1,
  },
  chooserOptionTxt: { fontSize: 15, fontFamily: 'PlexArabic-SemiBold' },

  // ── Modals / sheets ─────────────────────────────────────────────────────
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalBox: { borderRadius: radii.md, padding: 20, width: '100%', maxWidth: 432 },
  modalTitle: { fontSize: 17, fontFamily: 'PlexArabic-Bold', marginBottom: 12 },
  modalBody: { fontSize: 14, marginBottom: 8 },
  bigScore: { fontSize: 36, fontFamily: 'PlexArabic-Bold', textAlign: 'center', marginVertical: 4 },
  rankLine: { fontSize: 13, fontFamily: 'PlexArabic-SemiBold', textAlign: 'center', marginBottom: 10 },
  postWinRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  postWinBtn: {
    flex: 1,
    minWidth: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    borderRadius: radii.sm,
  },
  postWinBtnTxt: { fontSize: 12, fontFamily: 'PlexArabic-SemiBold', textAlign: 'center' },
  reportInput: { borderWidth: 1, borderRadius: radii.sm, padding: 10, marginBottom: 16 },
  modalRow: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  btnCancel: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: radii.sm },
  btnCancelText: { fontFamily: 'PlexArabic-SemiBold' },
  btnConfirm: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: radii.sm, marginTop: 8 },
  btnConfirmText: { color: '#fff', fontFamily: 'PlexArabic-Bold', textAlign: 'center' },

  // Full-height sheet — replaces the summary/daily-end center-modal pile-up.
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.lg + 4,
    borderTopRightRadius: radii.lg + 4,
    padding: 24,
    paddingBottom: 36,
    width: '100%',
    maxWidth: 512,
    alignSelf: 'center',
  },
  sheetTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  sheetRingWrap: { alignItems: 'center', marginBottom: 16 },
});
