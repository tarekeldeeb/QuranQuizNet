// PvP match screen — a live race against the virtual player «الحافظ».
// Phase 1: the opponent is a local bot (deterministic timeline, zero network).
// Phase 2 swaps the bot for a live RTDB opponent behind the same
// progress-view interface (BotProgress ⇔ opponent's players/{uid} node).
import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  Modal, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTranslation } from 'react-i18next';
import { useDirection, rowDir, alignDir, mirror } from '../../src/theme/direction';
import QuizCard, { CardData, reachesNewSuraContent } from '../../src/components/QuizCard';
import MistakesReview from '../../src/components/MistakesReview';
import PressScale from '../../src/components/PressScale';
import { useProfileStore } from '../../src/stores/profileStore';
import { getPvpTierInfo, cityName as pvpCityName } from '../../src/models/pvpTiers';
import * as QS from '../../src/services/questionnaireService';
import * as FB from '../../src/services/firebase';
import { trackEvent } from '../../src/services/analytics';
import { randperm, shuffleByPerm, deepCopy, getSuraIdx } from '../../src/models/constants';
import { ayaNumberOf, wordOffsetInAya } from '../../src/db/idb';
import { QuestionObject } from '../../src/models/questionnaire';
import { MistakeRecord, buildMistakeRecord } from '../../src/models/mistakes';
import {
  PVP_QUESTIONS, PVP_ROUNDS, PVP_TIMER_FIRST, PVP_TIMER_NEXT, PVP_ADVANCE_MS,
  BOT_EMOJI, MatchPlan, BotTimeline, BotProgress, PvpOutcome,
  scopeFromParts, makeMatchPlan, makeBotTimeline, botProgressAt,
  decideOutcome, newMatchSeed,
  intersectScope, isCompatibleCandidate, mayClaim, commonLevel,
  PvpQueueEntry, PvpMatchMeta, PvpPlayerState, PvpMatchResult, MatchScopePart,
} from '../../src/services/pvpService';
import { Avatar } from '../../src/components/Avatar';
import { flagEmoji } from '../../src/models/constants';
import { useTheme, ThemeColors } from '../../src/theme/tokens';
import { playCorrectSound, playIncorrectSound } from '../../src/services/sound';

const APP_ICON = require('../../assets/images/app-icon.png');

const TIER_EMOJI: Record<string, string> = {
  bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎', hafizGold: '🏆',
};

type Phase = 'idle' | 'searching' | 'countdown' | 'playing' | 'done';
type OpponentIdentity = { name: string; photoURL?: string; country?: string };

interface ActiveCard {
  round: number;
  shuffle: number[];           // perm of 0-4; shuffle[i]=0 means option i is correct
  shuffledOptions: string[];
  flipTrigger: number;
  isCorrect: boolean;
}

function makeActive(qo: QuestionObject, round = 0): ActiveCard {
  const shuffle = randperm(5);
  return {
    round,
    shuffle,
    shuffledOptions: shuffleByPerm(qo.txt.op[round] ?? ['', '', '', '', ''], shuffle),
    flipTrigger: 0,
    isCorrect: false,
  };
}

const EMPTY_BOT_VIEW: BotProgress = {
  qIndex: 0, correct: 0, roundsDone: 0, finished: false,
  results: new Array(PVP_QUESTIONS).fill(null),
};

/** Ten-segment progress strip; green = correct, red = wrong, grey = pending. */
function ProgressStrip({ results, current, colors }: { results: (boolean | null)[]; current: number; colors: ThemeColors }) {
  const { isRTL } = useDirection();
  return (
    <View style={[s.strip, { flexDirection: rowDir(isRTL) }]}>
      {Array.from({ length: PVP_QUESTIONS }, (_, i) => (
        <View
          key={i}
          style={[
            s.stripSeg,
            { backgroundColor: colors.line },
            results[i] === true && { backgroundColor: colors.correct },
            results[i] === false && { backgroundColor: colors.wrong },
            results[i] === null && i === current && { backgroundColor: colors.gold },
          ]}
        />
      ))}
    </View>
  );
}

export default function PvpScreen() {
  const profile = useProfileStore();
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  // Entry from a friend-invite lobby (see (app)/pvp-lobby.tsx): the match doc
  // already exists (both sides agreed and one of them created it) — skip the
  // idle/queue-search UI entirely and join it directly. `nonce` gates this to
  // fire once per lobby hand-off, the same pattern quiz.tsx uses for its own
  // deep-link params.
  const inviteParams = useLocalSearchParams<{
    matchId?: string; opponentUid?: string; opponentName?: string; opponentPhoto?: string; opponentCountry?: string; nonce?: string;
  }>();
  const consumedInviteNonceRef = useRef<string | undefined>(undefined);

  const [phase, setPhase] = useState<Phase>('idle');
  const [countdown, setCountdown] = useState(3);
  const [card, setCard] = useState<CardData | null>(null);
  const [active, setActive] = useState<ActiveCard | null>(null);
  const [loadingQ, setLoadingQ] = useState(false);
  const [timerValue, setTimerValue] = useState(0);
  const [timerMax, setTimerMax] = useState(0);
  const [playerResults, setPlayerResults] = useState<(boolean | null)[]>(EMPTY_BOT_VIEW.results);
  const [botView, setBotView] = useState<BotProgress>(EMPTY_BOT_VIEW);
  const [outcome, setOutcome] = useState<PvpOutcome | null>(null);
  const [matchMistakes, setMatchMistakes] = useState<MistakeRecord[]>([]);
  const [reportVisible, setReportVisible] = useState(false);
  const [reportCard, setReportCard] = useState<CardData | null>(null);
  const [reportMsg, setReportMsg] = useState('');
  const [searchSecondsLeft, setSearchSecondsLeft] = useState(15);
  const [opponentKind, setOpponentKindState] = useState<'bot' | 'human'>('bot');
  const [humanOpponent, setHumanOpponentState] = useState<OpponentIdentity | null>(null);
  const [oppDisconnected, setOppDisconnected] = useState(false);

  const planRef = useRef<MatchPlan | null>(null);
  const botRef = useRef<BotTimeline | null>(null);
  const qIndexRef = useRef(0);
  const playerCorrectRef = useRef(0);
  const matchMistakesRef = useRef<MistakeRecord[]>([]);
  const playerFinishMsRef = useRef(0);
  const playerResultsRef = useRef<(boolean | null)[]>(EMPTY_BOT_VIEW.results);
  const matchStartRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const botTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const advanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledRef = useRef(false);   // current question already answered/timed out
  // Questionnaire-engine state suspended for the match (a normal/daily run may
  // be live on the quiz tab; pvp shares the same module singleton).
  const savedEngineRef = useRef<{ qo: QuestionObject; seed: number } | null>(null);

  // ── Live matchmaking (Phase 2) — refs drive logic, state above only drives
  // render; several of these are read from inside long-lived RTDB listener
  // closures where a captured state variable would go stale. ──────────────────
  const queueUnsubRef = useRef<(() => void) | null>(null);
  const ownEntryUnsubRef = useRef<(() => void) | null>(null);
  const opponentUnsubRef = useRef<(() => void) | null>(null);
  const resultUnsubRef = useRef<(() => void) | null>(null);
  const searchTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const joinRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joinWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myQueueTsRef = useRef<number | null>(null);
  const claimedRef = useRef(false);
  const matchIdRef = useRef<string | null>(null);
  const opponentUidRef = useRef<string | null>(null);
  const opponentKindRef = useRef<'bot' | 'human'>('bot');
  const humanOpponentRef = useRef<OpponentIdentity | null>(null);
  const opponentStateRef = useRef<PvpPlayerState | null>(null);
  const opponentSeenRef = useRef(false);
  const myFinishedRef = useRef(false);
  const resultHandledRef = useRef(false);
  // journey-map points snapshot at match start, so the result modal can show
  // "+N points" — addPvpResult() has already mutated profile.pvp by the time
  // the modal renders, so the delta has to be captured before that happens.
  const pointsBeforeRef = useRef(0);

  function setOpponentKind(kind: 'bot' | 'human') {
    opponentKindRef.current = kind;
    setOpponentKindState(kind);
  }
  function setHumanOpponent(identity: OpponentIdentity | null) {
    humanOpponentRef.current = identity;
    setHumanOpponentState(identity);
  }

  function clearAllTimers() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (botTickRef.current) { clearInterval(botTickRef.current); botTickRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    if (advanceRef.current) { clearTimeout(advanceRef.current); advanceRef.current = null; }
    if (searchTickRef.current) { clearInterval(searchTickRef.current); searchTickRef.current = null; }
    if (joinRetryRef.current) { clearTimeout(joinRetryRef.current); joinRetryRef.current = null; }
    if (disconnectGraceTimerRef.current) { clearTimeout(disconnectGraceTimerRef.current); disconnectGraceTimerRef.current = null; }
    if (joinWatchdogRef.current) { clearTimeout(joinWatchdogRef.current); joinWatchdogRef.current = null; }
  }

  function restoreEngine() {
    const saved = savedEngineRef.current;
    if (!saved) return;
    savedEngineRef.current = null;
    QS.initQuestionnaire(saved.seed);
    QS.setQo(saved.qo);
  }

  /** Stop only the matchmaking-queue listeners (used once a match is found —
   *  distinct from clearAllTimers, which also covers in-match timers). */
  function stopSearchListeners() {
    queueUnsubRef.current?.(); queueUnsubRef.current = null;
    ownEntryUnsubRef.current?.(); ownEntryUnsubRef.current = null;
    if (searchTickRef.current) { clearInterval(searchTickRef.current); searchTickRef.current = null; }
    if (joinRetryRef.current) { clearTimeout(joinRetryRef.current); joinRetryRef.current = null; }
  }

  /** Tear down every RTDB listener/queue-entry for this screen. `forfeitIfLive`
   *  proactively awards the opponent a win if we're leaving mid live-match
   *  (more honest than relying purely on the presence-disconnect timeout). */
  function cleanupPvpNetwork(forfeitIfLive: boolean) {
    stopSearchListeners();
    opponentUnsubRef.current?.(); opponentUnsubRef.current = null;
    resultUnsubRef.current?.(); resultUnsubRef.current = null;
    const uid = profile.uid;
    const matchId = matchIdRef.current;
    const opponentUid = opponentUidRef.current;
    FB.leavePvpQueue(uid).catch(() => {});
    if (forfeitIfLive && matchId && opponentUid && !resultHandledRef.current) {
      resultHandledRef.current = true;
      FB.writePvpResult(matchId, { winnerUid: opponentUid, reason: 'forfeit' }).catch(() => {});
    }
    matchIdRef.current = null;
    opponentUidRef.current = null;
  }

  // Leaving the tab abandons whatever match is in progress — a bot match has
  // nothing meaningful to resume (it races the wall clock), and a live match
  // proactively forfeits to the opponent rather than leaving them stuck. Always
  // land back on the idle challenge screen; a match only starts on an explicit tap.
  useFocusEffect(useCallback(() => {
    if (
      inviteParams.matchId && inviteParams.opponentUid && inviteParams.nonce
      && inviteParams.nonce !== consumedInviteNonceRef.current
    ) {
      consumedInviteNonceRef.current = inviteParams.nonce;
      enterFromInvite(
        inviteParams.matchId,
        inviteParams.opponentUid,
        inviteParams.opponentName
          ? { name: inviteParams.opponentName, photoURL: inviteParams.opponentPhoto, country: inviteParams.opponentCountry }
          : null,
      );
    }
    return () => {
      clearAllTimers();
      cleanupPvpNetwork(true);
      restoreEngine();
      setPhase('idle');
      setOutcome(null);
      setCard(null);
      setActive(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteParams.matchId, inviteParams.opponentUid, inviteParams.nonce]));

  function startMatch() {
    clearAllTimers();
    cleanupPvpNetwork(false);
    // Suspend whatever the quiz tab had in the shared engine — restored on exit.
    if (!savedEngineRef.current) {
      savedEngineRef.current = { qo: deepCopy(QS.qo), seed: profile.lastSeed };
    }

    qIndexRef.current = 0;
    playerCorrectRef.current = 0;
    matchMistakesRef.current = [];
    setMatchMistakes([]);
    playerFinishMsRef.current = 0;
    settledRef.current = false;
    playerResultsRef.current = new Array(PVP_QUESTIONS).fill(null);
    setPlayerResults(playerResultsRef.current);
    setBotView(EMPTY_BOT_VIEW);
    setOutcome(null);
    setCard(null);
    setActive(null);
    setOpponentKind('bot');
    setHumanOpponent(null);
    setOppDisconnected(false);
    opponentStateRef.current = null;
    opponentSeenRef.current = false;
    myFinishedRef.current = false;
    resultHandledRef.current = false;
    pointsBeforeRef.current = profile.pvp.points;
    if (profile.recordPlay()) void FB.pushCurrentProfile();

    startSearch();
  }

  /** Runs the shared 3-2-1 countdown, then hands off to beginPlay(). Used for
   *  both the bot match and a live match — each side of a live match runs its
   *  own countdown independently on seeing the same match doc (tolerant of a
   *  couple seconds of skew, per the design). */
  function runCountdown() {
    setPhase('countdown');
    setCountdown(3);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
          beginPlay();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  function startBotMatch() {
    setOpponentKind('bot');
    setHumanOpponent(null);
    const seed = newMatchSeed();
    const scope = scopeFromParts(profile.parts);
    planRef.current = makeMatchPlan(seed, profile.level, scope);
    const accuracy = (parseFloat(profile.getPercentTotalRatio()) || 0) / 100;
    botRef.current = makeBotTimeline(seed, accuracy);
    trackEvent('pvp_start', { level: profile.level, opponent: 'bot' });
    runCountdown();
  }

  // ── Matchmaking (searching phase) ─────────────────────────────────────────

  /** Writes our queue entry, retrying every 1.5s until it lands. On web, a
   *  fresh page load/refresh can mount this screen before Firebase Auth has
   *  finished rehydrating its session (`app/index.tsx`'s auth-ready gate
   *  isn't in the tree for a direct route load), so early writes can race an
   *  auth token that isn't attached to the RTDB connection yet and come back
   *  PERMISSION_DENIED. On some devices (e.g. iPhone Safari on a cold
   *  reload) that handshake can take several seconds — a fixed retry cap
   *  was falling back to the bot well before the visible 15s countdown
   *  reached zero. There's no cap here: the 15s searchTick (startSearch) is
   *  the sole authority for giving up, and it clears joinRetryRef via
   *  stopSearchListeners when it does, so retries stop right along with it. */
  function attemptJoin(
    uid: string,
    entry: Omit<PvpQueueEntry, 'ts' | 'matchId'>,
    onJoined: () => void,
  ) {
    FB.joinPvpQueue(uid, entry)
      .then((ts) => { myQueueTsRef.current = ts; onJoined(); })
      .catch((e) => {
        console.error('joinPvpQueue error:', e);
        if (claimedRef.current) return;
        joinRetryRef.current = setTimeout(() => attemptJoin(uid, entry, onJoined), 1500);
      });
  }

  function startSearch() {
    claimedRef.current = false;
    myQueueTsRef.current = null;
    setPhase('searching');
    setSearchSecondsLeft(15);
    trackEvent('pvp_queue_join', { level: profile.level });

    const uid = profile.uid;
    const scope = scopeFromParts(profile.parts);
    const mine = { level: profile.level, scope };

    // Queue events that arrive before our own join is acked are skipped
    // (myQueueTsRef is still null) — and with two players quietly waiting the
    // queue never fires again, so the join ack must re-run the evaluation
    // itself over the latest snapshot or both sides deadlock into the bot.
    let latestEntries: Record<string, PvpQueueEntry> = {};
    const tryMatch = () => {
      if (claimedRef.current || myQueueTsRef.current === null) return;
      const mineTs = myQueueTsRef.current;
      for (const [candidateUid, candidate] of Object.entries(latestEntries)) {
        if (candidateUid === uid) continue;
        if (!isCompatibleCandidate(mine, candidate, Date.now())) continue;
        if (!mayClaim({ ts: mineTs, uid }, { ts: candidate.ts, uid: candidateUid })) continue;
        claimedRef.current = true;
        attemptClaim(uid, mine, candidateUid, candidate);
        break;
      }
    };

    attemptJoin(uid, {
      name: profile.social.displayName?.split(' ')[0] || t('pvp.you'),
      photoURL: profile.social.photoURL,
      country: profile.country || undefined,
      level: profile.level,
      scope,
    }, tryMatch);

    queueUnsubRef.current = FB.watchPvpQueue((entries) => {
      latestEntries = entries;
      tryMatch();
    });

    ownEntryUnsubRef.current = FB.watchOwnQueueEntry(uid, (entry) => {
      if (claimedRef.current) return;
      if (entry?.matchId) {
        claimedRef.current = true;
        joinClaimedMatch(uid, entry.matchId);
      }
    });

    searchTickRef.current = setInterval(() => {
      setSearchSecondsLeft((s) => {
        if (s <= 1) {
          if (searchTickRef.current) { clearInterval(searchTickRef.current); searchTickRef.current = null; }
          if (!claimedRef.current) {
            claimedRef.current = true;
            giveUpSearchAndUseBot(uid);
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  function cancelSearch() {
    clearAllTimers();
    cleanupPvpNetwork(false);
    setPhase('idle');
  }

  function giveUpSearchAndUseBot(uid: string) {
    stopSearchListeners();
    FB.leavePvpQueue(uid).catch(() => {});
    trackEvent('pvp_queue_timeout', { level: profile.level });
    startBotMatch();
  }

  async function attemptClaim(
    uid: string,
    mine: { level: number; scope: MatchScopePart[] },
    candidateUid: string,
    candidate: PvpQueueEntry,
  ) {
    const matchId = `${uid}_${candidateUid}_${Date.now()}`;
    // The match doc must exist BEFORE the claim lands: the claimed side does a
    // one-shot meta read the moment it sees matchId on its queue entry, and
    // reading before this client's meta write arrived sent it to the bot. An
    // orphaned doc from a lost claim race is inert (matchId is unique per attempt).
    const meta: PvpMatchMeta = {
      seed: newMatchSeed(),
      level: commonLevel(mine.level, candidate.level),
      scope: intersectScope(mine.scope, candidate.scope ?? []),
      rounds: PVP_ROUNDS,
      createdAt: Date.now(),
      creator: uid,
    };
    try {
      await FB.createPvpMatch(matchId, meta);
    } catch (e) {
      console.error('createPvpMatch error:', e);
      claimedRef.current = false; // keep searching; the 15s tick still bots out
      return;
    }
    let won = false;
    try { won = await FB.claimMatch(candidateUid, matchId); } catch { won = false; }
    if (!won) {
      claimedRef.current = false; // still searching — another candidate may work
      return;
    }
    stopSearchListeners();
    await FB.leavePvpQueue(uid).catch(() => {});
    enterLiveMatch(matchId, candidateUid, {
      name: candidate.name, photoURL: candidate.photoURL, country: candidate.country,
    }, meta);
  }

  async function joinClaimedMatch(uid: string, matchId: string) {
    stopSearchListeners();
    const meta = await FB.getPvpMatchMeta(matchId).catch(() => null);
    if (!meta) { giveUpSearchAndUseBot(uid); return; }
    await FB.leavePvpQueue(uid).catch(() => {});
    // Opponent identity isn't in meta — it arrives moments later via the first
    // watchPvpPlayer update below, same as for the claimer (kept symmetric).
    enterLiveMatch(matchId, meta.creator, null, meta);
  }

  /** Entry from a friend-invite lobby: the match doc already exists (see
   *  inviteParams above) — reset the same session state startMatch() would
   *  before a queue search, then join directly instead of searching. Unlike
   *  joinClaimedMatch(), the opponent is known up front (whoever the lobby
   *  wasn't me), not derived from meta.creator — a lobby entrant can BE the
   *  creator, so meta.creator would sometimes resolve to "myself". */
  async function enterFromInvite(matchId: string, opponentUid: string, identity: OpponentIdentity | null) {
    clearAllTimers();
    cleanupPvpNetwork(false);
    if (!savedEngineRef.current) {
      savedEngineRef.current = { qo: deepCopy(QS.qo), seed: profile.lastSeed };
    }
    qIndexRef.current = 0;
    playerCorrectRef.current = 0;
    matchMistakesRef.current = [];
    setMatchMistakes([]);
    playerFinishMsRef.current = 0;
    settledRef.current = false;
    playerResultsRef.current = new Array(PVP_QUESTIONS).fill(null);
    setPlayerResults(playerResultsRef.current);
    setBotView(EMPTY_BOT_VIEW);
    setOutcome(null);
    setCard(null);
    setActive(null);
    setOppDisconnected(false);
    opponentStateRef.current = null;
    opponentSeenRef.current = false;
    myFinishedRef.current = false;
    resultHandledRef.current = false;
    pointsBeforeRef.current = profile.pvp.points;
    if (profile.recordPlay()) void FB.pushCurrentProfile();
    const meta = await FB.getPvpMatchMeta(matchId).catch(() => null);
    if (!meta) { startBotMatch(); return; } // match doc vanished — fall back rather than strand the screen
    enterLiveMatch(matchId, opponentUid, identity, meta);
  }

  function enterLiveMatch(
    matchId: string,
    opponentUid: string,
    identity: OpponentIdentity | null,
    meta: PvpMatchMeta,
  ) {
    matchIdRef.current = matchId;
    opponentUidRef.current = opponentUid;
    setOpponentKind('human');
    setHumanOpponent(identity);
    planRef.current = makeMatchPlan(meta.seed, meta.level, meta.scope);

    FB.writeMyPvpState(matchId, profile.uid, {
      name: profile.social.displayName?.split(' ')[0] || t('pvp.you'),
      photoURL: profile.social.photoURL,
      country: profile.country || undefined,
      qIndex: 0, correct: 0, finished: false,
      results: new Array(PVP_QUESTIONS).fill(null),
    }).catch((e) => console.error('writeMyPvpState seed error:', e));
    FB.armPvpPresence(matchId, profile.uid).catch((e) => console.error('armPvpPresence error:', e));

    opponentUnsubRef.current = FB.watchPvpPlayer(matchId, opponentUid, (state) => {
      if (!state) return;
      opponentStateRef.current = state;
      if (!opponentSeenRef.current) {
        opponentSeenRef.current = true;
        if (joinWatchdogRef.current) { clearTimeout(joinWatchdogRef.current); joinWatchdogRef.current = null; }
      }
      if (state.name && !humanOpponentRef.current) {
        setHumanOpponent({ name: state.name, photoURL: state.photoURL, country: state.country });
      }
      setBotView({
        qIndex: state.qIndex,
        correct: state.correct,
        roundsDone: 0,
        finished: state.finished,
        results: state.results ?? new Array(PVP_QUESTIONS).fill(null),
      });
      handleOpponentPresence(state.connected);
      if (state.finished) checkForResult();
    });

    resultUnsubRef.current = FB.watchPvpResult(matchId, (result) => {
      if (result) handleMatchResult(result);
    });

    trackEvent('pvp_matched', { level: meta.level });
    trackEvent('pvp_start', { level: meta.level, opponent: 'human' });
    runCountdown();
  }

  // ── Live-match presence / forfeit / result ────────────────────────────────

  function handleOpponentPresence(connected: boolean) {
    if (connected) {
      if (disconnectGraceTimerRef.current) {
        clearTimeout(disconnectGraceTimerRef.current);
        disconnectGraceTimerRef.current = null;
      }
      setOppDisconnected(false);
      return;
    }
    if (disconnectGraceTimerRef.current || resultHandledRef.current) return;
    setOppDisconnected(true);
    disconnectGraceTimerRef.current = setTimeout(() => {
      disconnectGraceTimerRef.current = null;
      const matchId = matchIdRef.current;
      if (matchId && !resultHandledRef.current) {
        FB.writePvpResult(matchId, { winnerUid: profile.uid, reason: 'forfeit' }).catch(() => {});
      }
    }, 15000);
  }

  /** Both sides compute the same result independently once both are finished —
   *  whichever write lands first wins the write-once rule; the loser's write is
   *  harmlessly rejected since the content is identical either way. */
  function checkForResult() {
    const matchId = matchIdRef.current;
    const opp = opponentStateRef.current;
    if (!matchId || !myFinishedRef.current || !opp?.finished || resultHandledRef.current) return;
    const result = decideOutcome(
      { correct: playerCorrectRef.current, timeMs: playerFinishMsRef.current },
      { correct: opp.correct, timeMs: opp.timeMs ?? 0 },
    );
    const winnerUid = result === 'draw' ? null : result === 'win' ? profile.uid : opponentUidRef.current;
    FB.writePvpResult(matchId, { winnerUid, reason: 'score' }).catch(() => {});
  }

  function handleMatchResult(result: PvpMatchResult) {
    if (resultHandledRef.current) return;
    resultHandledRef.current = true;
    clearAllTimers();
    const myUid = profile.uid;
    const outcomeVal: PvpOutcome =
      result.winnerUid === null ? 'draw' : result.winnerUid === myUid ? 'win' : 'loss';
    profile.addPvpResult(outcomeVal);
    void FB.pushCurrentProfile();
    trackEvent('pvp_end', {
      outcome: outcomeVal,
      correct: playerCorrectRef.current,
      opponent_correct: opponentStateRef.current?.correct ?? 0,
      time_ms: playerFinishMsRef.current,
      reason: result.reason,
      opponent: 'human',
    });
    setPhase('done');
    setMatchMistakes(matchMistakesRef.current);
    setTimeout(() => setOutcome(outcomeVal), 700);
  }

  function beginPlay() {
    matchStartRef.current = Date.now();
    setPhase('playing');
    if (opponentKindRef.current === 'bot') {
      botTickRef.current = setInterval(() => {
        const bot = botRef.current;
        if (!bot) return;
        setBotView(botProgressAt(bot, Date.now() - matchStartRef.current));
      }, 300);
    } else if (!opponentSeenRef.current) {
      // Opponent never showed up (e.g. they timed out to the bot on their own
      // side right as we claimed them) — don't strand this client forever.
      joinWatchdogRef.current = setTimeout(() => {
        joinWatchdogRef.current = null;
        if (opponentSeenRef.current || resultHandledRef.current) return;
        const matchId = matchIdRef.current;
        if (matchId && opponentUidRef.current) {
          FB.writePvpResult(matchId, { winnerUid: profile.uid, reason: 'forfeit' }).catch(() => {});
        }
      }, 10000);
    }
    loadQuestion(0);
  }

  async function loadQuestion(q: number) {
    const plan = planRef.current;
    if (!plan) return;
    setLoadingQ(true);
    // Re-arm before generation: if it throws, the catch's settleQuestion(false)
    // must not be swallowed by the previous question's settled flag.
    settledRef.current = false;
    try {
      await QS.createNormalQ(
        plan.starts[q],
        profile.getSparsePoint.bind(profile),
        profile.getTotalStudyLength.bind(profile),
        profile.level,
        plan.level,
        profile.getPartIndexOf.bind(profile),
      );
      // Full quiz questions run 10 rounds; a head-to-head at that length drags.
      QS.qo.rounds = PVP_ROUNDS;
      const aya = await ayaNumberOf(QS.qo.startIdx);
      const wordOffset = await wordOffsetInAya(QS.qo.startIdx);
      setCard({
        index: q,
        qo: deepCopy(QS.qo),
        answerAya: aya,
        wordOffset,
        socialURL: `https://quranquiz.net/quiz?start=${QS.qo.startIdx}&lvl=${QS.qo.level}`,
      });
      setActive(makeActive(QS.qo));
      startTimer(PVP_TIMER_FIRST);
    } catch (e) {
      console.error('pvp loadQuestion error:', e);
      // Don't strand the match on a bad question — count it as wrong and move on.
      settleQuestion(false);
    } finally {
      setLoadingQ(false);
    }
  }

  function startTimer(seconds: number) {
    if (timerRef.current) clearInterval(timerRef.current);
    setTimerMax(seconds);
    setTimerValue(seconds);
    timerRef.current = setInterval(() => {
      setTimerValue((v) => {
        if (v <= 1) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          settleQuestion(false);   // out of time = wrong
          return 0;
        }
        return v - 1;
      });
    }, 1000);
  }

  function selectOption(optionIndex: number) {
    if (!active || settledRef.current) return;
    const isWrong = active.shuffle[optionIndex] !== 0;
    const isLastRound = active.round + 1 === PVP_ROUNDS;

    if (isWrong) {
      settleQuestion(false, optionIndex);
    } else if (isLastRound) {
      settleQuestion(true);
    } else {
      const newRound = active.round + 1;
      const newShuffle = randperm(5);
      const questionSoFar = QS.qo.txt.answer
        .split(' ')
        .slice(0, QS.qo.qLen + QS.qo.oLen * newRound)
        .join(' ');
      setCard((prev) => prev
        ? { ...prev, qo: { ...prev.qo, txt: { ...prev.qo.txt, question: questionSoFar } } }
        : prev);
      setActive({
        round: newRound,
        shuffle: newShuffle,
        shuffledOptions: shuffleByPerm(QS.qo.txt.op[newRound] ?? [], newShuffle),
        flipTrigger: 0,
        isCorrect: false,
      });
      startTimer(PVP_TIMER_NEXT);
    }
  }

  function settleQuestion(correct: boolean, pickedIndex?: number) {
    if (settledRef.current) return;
    settledRef.current = true;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    const q = qIndexRef.current;
    if (correct) playerCorrectRef.current++;
    if (correct) playCorrectSound(); else playIncorrectSound();
    const nextResults = [...playerResultsRef.current];
    nextResults[q] = correct;
    playerResultsRef.current = nextResults;
    setPlayerResults(nextResults);
    setCard((prev) => prev ? { ...prev, wasCorrect: correct } : prev);
    setActive((a) => a ? { ...a, flipTrigger: a.flipTrigger + 1, isCorrect: correct } : null);

    if (!correct && card && active) {
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
      matchMistakesRef.current.push(mistake);
    }

    const isLast = q + 1 >= PVP_QUESTIONS;
    if (isLast) {
      playerFinishMsRef.current = Date.now() - matchStartRef.current;
    }
    if (opponentKindRef.current === 'human' && matchIdRef.current) {
      FB.writeMyPvpState(matchIdRef.current, profile.uid, {
        qIndex: q + 1,
        correct: playerCorrectRef.current,
        results: nextResults,
        finished: isLast,
        ...(isLast ? { timeMs: playerFinishMsRef.current } : {}),
      }).catch((e) => console.error('writeMyPvpState progress error:', e));
    }
    advanceRef.current = setTimeout(advance, PVP_ADVANCE_MS);
  }

  function advance() {
    if (advanceRef.current) { clearTimeout(advanceRef.current); advanceRef.current = null; }
    const nextQ = qIndexRef.current + 1;
    if (nextQ >= PVP_QUESTIONS) {
      finishMyRun();
      return;
    }
    qIndexRef.current = nextQ;
    loadQuestion(nextQ);
  }

  // «حسناً» on the flipped card skips the remaining auto-advance wait.
  function onScrollDown() {
    if (settledRef.current && advanceRef.current) advance();
  }

  function finishMyRun() {
    myFinishedRef.current = true;
    if (opponentKindRef.current === 'bot') {
      finishBotMatch();
    } else {
      finishHumanSide();
    }
  }

  function finishBotMatch() {
    clearAllTimers();
    const bot = botRef.current;
    if (!bot) return;
    const finalBot = botProgressAt(bot, Number.MAX_SAFE_INTEGER);
    setBotView(finalBot);
    const result = decideOutcome(
      { correct: playerCorrectRef.current, timeMs: playerFinishMsRef.current },
      bot.final,
    );
    profile.addPvpResult(result);
    void FB.pushCurrentProfile();
    trackEvent('pvp_end', {
      outcome: result,
      correct: playerCorrectRef.current,
      opponent_correct: bot.final.correct,
      time_ms: playerFinishMsRef.current,
      opponent: 'bot',
    });
    setPhase('done');
    setMatchMistakes(matchMistakesRef.current);
    // Let the bot's strip visually complete before the verdict lands.
    setTimeout(() => setOutcome(result), 700);
  }

  /** I've finished my 10 questions, but the opponent may still be playing —
   *  wait (the 'done' phase already renders a spinner) until checkForResult()
   *  sees them finish too, or the disconnect/join-watchdog forfeit fires. */
  function finishHumanSide() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (joinWatchdogRef.current) { clearTimeout(joinWatchdogRef.current); joinWatchdogRef.current = null; }
    setPhase('done');
    checkForResult();
  }

  function exitToHome() {
    setOutcome(null);
    router.replace('/(app)/me');
  }

  function openReport(c: CardData) {
    setReportCard(c);
    setReportMsg('');
    setReportVisible(true);
  }

  async function submitReport() {
    if (reportCard) await FB.reportQuestion({ card: reportCard, msg: reportMsg });
    setReportVisible(false);
  }

  // ── render ──────────────────────────────────────────────────────────────────
  const playerName = profile.social.displayName?.split(' ')[0] || t('pvp.you');
  const avatarUri = profile.social.photoURL || undefined;
  const playing = phase === 'playing' || phase === 'done';

  const opponentLabel = opponentKind === 'bot' ? t('pvp.botName') : (humanOpponent?.name ?? t('pvp.theOpponent'));
  const outcomeTitle =
    outcome === 'win' ? t('pvp.outcome.winTitle')
    : outcome === 'loss' ? t('pvp.outcome.lossTitle', { name: opponentLabel })
    : t('pvp.outcome.drawTitle');
  const outcomeSub =
    outcome === 'win' ? t('pvp.outcome.winSub', { name: opponentLabel })
    : outcome === 'loss' ? t('pvp.outcome.lossSub')
    : t('pvp.outcome.drawSub');

  // No 'bottom' edge: the tab bar reserves the bottom safe-area inset itself.
  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={[]}>

      {/* ── Idle: intro — real opponent first, bot fallback if none found ── */}
      {phase === 'idle' && (
        <View style={s.idleWrap}>
          <View style={[s.idleIconRing, { backgroundColor: colors.goldPale }]}>
            <Ionicons name="flash" size={40} color={colors.gold} />
          </View>
          <Text style={[s.idleTitle, { color: colors.ink }]}>{t('pvp.idleTitle')}</Text>
          <Text style={[s.idleSub, { color: colors.inkSoft }]}>
            {t('pvp.idleSub', { count: PVP_QUESTIONS, botName: t('pvp.botName'), botEmoji: BOT_EMOJI })}
          </Text>
          <View style={[s.recordRow, { flexDirection: rowDir(isRTL) }]}>
            <View style={s.recordCell}>
              <Text style={[s.recordNum, { color: colors.correct }]}>{profile.pvp.wins}</Text>
              <Text style={[s.recordLbl, { color: colors.inkSoft }]}>{t('pvp.wins')}</Text>
            </View>
            <View style={s.recordCell}>
              <Text style={[s.recordNum, { color: colors.inkSoft }]}>{profile.pvp.draws}</Text>
              <Text style={[s.recordLbl, { color: colors.inkSoft }]}>{t('pvp.draws')}</Text>
            </View>
            <View style={s.recordCell}>
              <Text style={[s.recordNum, { color: colors.wrong }]}>{profile.pvp.losses}</Text>
              <Text style={[s.recordLbl, { color: colors.inkSoft }]}>{t('pvp.losses')}</Text>
            </View>
          </View>
          <TouchableOpacity style={[s.startBtn, { backgroundColor: colors.navy, flexDirection: rowDir(isRTL) }]} onPress={startMatch} activeOpacity={0.85}>
            <Ionicons name="flash" size={20} color="#fff" />
            <Text style={s.startBtnTxt}>{t('pvp.startBtn')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Searching for a live opponent ── */}
      {phase === 'searching' && (
        <View style={s.countWrap}>
          <ActivityIndicator size="large" color={colors.ink} />
          <Text style={[s.countBotLine, { color: colors.ink }]}>{t('pvp.searching')}</Text>
          <Text style={[s.searchSeconds, { color: colors.ink }]}>{searchSecondsLeft}</Text>
          <TouchableOpacity style={s.homeBtn} onPress={cancelSearch}>
            <Text style={[s.homeTxt, { color: colors.inkSoft }]}>{t('pvp.cancel')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Countdown overlay ── */}
      {phase === 'countdown' && (
        <View style={s.countWrap}>
          <Text style={[s.countBotLine, { color: colors.ink }]}>
            {t('pvp.readyQuestion', { name: opponentLabel })}
          </Text>
          <Text style={[s.countNum, { color: colors.gold }]}>{countdown}</Text>
        </View>
      )}

      {/* ── Versus header ── */}
      {playing && (
        <View style={[s.vsBar, { backgroundColor: colors.card, flexDirection: rowDir(isRTL) }]}>
          {/* Player vs opponent header */}
          <View style={s.vsSide}>
            <View style={[s.vsIdent, { flexDirection: rowDir(isRTL) }]}>
              <Avatar uri={avatarUri} fallback={APP_ICON} style={[s.vsAvatar, { backgroundColor: colors.goldPale }]} />
              <Text style={[s.vsName, { color: colors.ink }]} numberOfLines={1}>{playerName}</Text>
            </View>
            <Text style={[s.vsScore, { color: colors.ink }]}>{playerCorrectRef.current}</Text>
            <ProgressStrip results={playerResults} current={qIndexRef.current} colors={colors} />
          </View>
          <Text style={[s.vsMid, { color: colors.inkSoft }]}>{t('pvp.vs')}</Text>
          <View style={s.vsSide}>
            <View style={[s.vsIdent, { flexDirection: rowDir(isRTL) }]}>
              {opponentKind === 'bot' ? (
                <View style={[s.botAvatar, { backgroundColor: colors.goldPale }]}><Ionicons name="hardware-chip-outline" size={18} color={colors.goldDeep} /></View>
              ) : (
                <Avatar uri={humanOpponent?.photoURL} fallback={APP_ICON} style={[s.vsAvatar, { backgroundColor: colors.goldPale }]} />
              )}
              <Text style={[s.vsName, { color: colors.ink }]} numberOfLines={1}>
                {opponentKind === 'human' && humanOpponent?.country ? `${flagEmoji(humanOpponent.country)} ` : ''}
                {opponentKind === 'bot' ? t('pvp.botName') : (humanOpponent?.name ?? t('pvp.opponent'))}
              </Text>
            </View>
            <Text style={[s.vsScore, { color: colors.ink }]}>{botView.correct}</Text>
            <ProgressStrip results={botView.results} current={botView.qIndex} colors={colors} />
          </View>
        </View>
      )}

      {/* ── Opponent disconnected — grace period banner ── */}
      {oppDisconnected && playing && !outcome && (
        <View style={[s.disconnectBanner, { backgroundColor: colors.wrongPale, flexDirection: rowDir(isRTL) }]}>
          <Ionicons name="warning-outline" size={15} color={colors.wrong} />
          <Text style={[s.disconnectTxt, { color: colors.wrong }]}>{t('pvp.disconnectBanner')}</Text>
        </View>
      )}

      {/* ── Active question ── */}
      {phase === 'playing' && (
        <View style={s.cardArea}>
          {loadingQ || !card || !active ? (
            <ActivityIndicator size="large" color={colors.ink} />
          ) : (
            <QuizCard
              card={card}
              isActive
              score={playerCorrectRef.current}
              scoreUp={0}
              isDailyMode
              timerValue={timerValue}
              timerMax={timerMax}
              onSelectOption={selectOption}
              onSkip={() => settleQuestion(false)}
              onScrollDown={onScrollDown}
              onReport={openReport}
              round={active.round}
              totalRounds={PVP_ROUNDS}
              shuffledOptions={active.shuffledOptions}
              flipTrigger={active.flipTrigger}
              isCorrect={active.isCorrect}
            />
          )}
        </View>
      )}

      {phase === 'done' && (
        <View style={s.cardArea}>
          <ActivityIndicator size="large" color={colors.ink} />
          {opponentKind === 'human' && !outcome && (
            <Text style={[s.waitingTxt, { color: colors.inkSoft }]}>{t('pvp.waitingForOpponent')}</Text>
          )}
        </View>
      )}

      {/* ── Result modal ── */}
      <Modal visible={outcome !== null} transparent animationType="fade" onRequestClose={exitToHome}>
        <View style={s.modalBg}>
          <View style={[s.modalBox, { backgroundColor: colors.card }]}>
            <Text style={[s.resultTitle, { color: colors.ink }]}>{outcomeTitle}</Text>
            <View style={[s.resultScores, { flexDirection: rowDir(isRTL) }]}>
              <View style={s.resultCell}>
                <Text style={[s.resultName, { color: colors.inkSoft }]}>{playerName}</Text>
                <Text style={[s.resultNum, { color: colors.ink }, outcome === 'win' && { color: colors.correct }]}>
                  {playerCorrectRef.current}
                </Text>
              </View>
              <Text style={[s.resultDash, { color: colors.inkSoft }]}>—</Text>
              <View style={s.resultCell}>
                <Text style={[s.resultName, { color: colors.inkSoft }]}>
                  {opponentKind === 'bot' ? t('pvp.botName') : opponentLabel}
                </Text>
                <Text style={[s.resultNum, { color: colors.ink }, outcome === 'loss' && { color: colors.correct }]}>
                  {opponentKind === 'bot' ? (botRef.current?.final.correct ?? 0) : botView.correct}
                </Text>
              </View>
            </View>
            <Text style={[s.resultSub, { color: colors.inkSoft }]}>{outcomeSub}</Text>
            <MistakesReview mistakes={matchMistakes} />
            {outcome !== null && (() => {
              const tierInfo = getPvpTierInfo(profile.pvp.points);
              const pointsGained = outcome === 'win' ? profile.pvp.points - pointsBeforeRef.current : 0;
              const nextCityLabel = tierInfo.nextCity ? pvpCityName(tierInfo.nextCity.id) : null;
              return (
                <PressScale
                  style={[s.journeyStrip, { backgroundColor: colors.goldPale, flexDirection: rowDir(isRTL) }]}
                  onPress={() => { setOutcome(null); router.push('/(app)/pvp-journey'); }}
                >
                  <Text style={s.journeyEmoji}>{TIER_EMOJI[tierInfo.tier]}</Text>
                  <Text style={[s.journeyTxt, { color: colors.goldDeep, textAlign: alignDir(isRTL) }]} numberOfLines={1}>
                    {pointsGained > 0 ? t('pvpJourney.pointsGained', { count: pointsGained }) + ' · ' : ''}
                    {tierInfo.journeyComplete || !nextCityLabel
                      ? t('pvpJourney.complete')
                      : t('pvpJourney.toNextCity', { count: tierInfo.pointsToNextCity, cityName: nextCityLabel })}
                  </Text>
                  <Ionicons name={mirror(isRTL, 'chevron-forward', 'chevron-back')} size={16} color={colors.goldDeep} />
                </PressScale>
              );
            })()}
            <TouchableOpacity style={[s.rematchBtn, { backgroundColor: colors.navy, flexDirection: rowDir(isRTL) }]} onPress={() => { setOutcome(null); startMatch(); }}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={s.rematchTxt}>{t('pvp.rematch')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.homeBtn} onPress={exitToHome}>
              <Text style={[s.homeTxt, { color: colors.inkSoft }]}>{t('pvp.home')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Report modal (same as quiz) ── */}
      <Modal visible={reportVisible} transparent animationType="slide" onRequestClose={() => setReportVisible(false)}>
        <View style={s.modalBg}>
          <View style={[s.modalBox, { backgroundColor: colors.card }]}>
            <Text style={[s.reportTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('common.reportModal.title')}</Text>
            <TextInput
              style={[s.reportInput, { borderColor: colors.line, color: colors.ink }]}
              placeholder={t('common.reportModal.placeholder')}
              placeholderTextColor={colors.inkSoft}
              value={reportMsg}
              onChangeText={setReportMsg}
              textAlign={alignDir(isRTL)}
            />
            <View style={[s.reportRow, { justifyContent: isRTL ? 'flex-end' : 'flex-start' }]}>
              <TouchableOpacity style={[s.btnCancel, { backgroundColor: colors.line }]} onPress={() => setReportVisible(false)}>
                <Text style={[s.btnCancelTxt, { color: colors.ink }]}>{t('common.reportModal.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btnConfirm, { backgroundColor: colors.navy }]} onPress={submitReport}>
                <Text style={s.btnConfirmTxt}>{t('common.reportModal.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },

  // Idle
  idleWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  idleIconRing: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  idleTitle: { fontSize: 24, fontWeight: '800' },
  idleSub: { fontSize: 14, textAlign: 'center' },
  recordRow: { gap: 24, marginVertical: 14 },
  recordCell: { alignItems: 'center', gap: 2 },
  recordNum: { fontSize: 22, fontWeight: '800' },
  recordLbl: { fontSize: 12 },
  startBtn: {
    alignItems: 'center', gap: 8,
    paddingVertical: 14, paddingHorizontal: 36, borderRadius: 14,
  },
  startBtnTxt: { color: '#fff', fontSize: 17, fontWeight: '800' },

  // Countdown / searching
  countWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 },
  countBotLine: { fontSize: 17, fontWeight: '700' },
  countNum: { fontSize: 84, fontWeight: '800' },
  searchSeconds: { fontSize: 40, fontWeight: '800' },

  // Disconnect banner
  disconnectBanner: {
    alignItems: 'center', justifyContent: 'center', gap: 6,
    marginHorizontal: 12, marginTop: 8,
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12,
  },
  disconnectTxt: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  waitingTxt: { fontSize: 14, fontWeight: '600', textAlign: 'center', marginTop: 10 },

  // Versus header
  vsBar: {
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 14,
    padding: 10,
    gap: 8,
    boxShadow: '0px 2px 8px rgba(13,45,78,0.08)',
    elevation: 2,
  },
  vsSide: { flex: 1, alignItems: 'center', gap: 4 },
  vsIdent: { alignItems: 'center', gap: 6, maxWidth: '100%' },
  vsAvatar: { width: 26, height: 26, borderRadius: 13 },
  botAvatar: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
  },
  vsName: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  vsScore: { fontSize: 20, fontWeight: '800' },
  vsMid: { fontSize: 12, fontWeight: '800' },

  strip: { gap: 2 },
  stripSeg: { width: 9, height: 6, borderRadius: 2 },

  // Card area
  cardArea: { flex: 1, justifyContent: 'center', paddingVertical: 10 },

  // Modals
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalBox: { borderRadius: 14, padding: 22, width: '100%', maxWidth: 400 },

  resultTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 14 },
  resultScores: { alignItems: 'center', justifyContent: 'center', gap: 18, marginBottom: 12 },
  resultCell: { alignItems: 'center', gap: 4 },
  resultName: { fontSize: 13, fontWeight: '700' },
  resultNum: { fontSize: 34, fontWeight: '800' },
  resultDash: { fontSize: 20 },
  resultSub: { fontSize: 13, textAlign: 'center', marginBottom: 16 },
  journeyStrip: {
    alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 10, marginBottom: 14,
  },
  journeyEmoji: { fontSize: 18 },
  journeyTxt: { flex: 1, fontSize: 12.5, fontWeight: '700' },
  rematchBtn: {
    alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, borderRadius: 12,
  },
  rematchTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  homeBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  homeTxt: { fontSize: 14, fontWeight: '700' },

  reportTitle: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  reportInput: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 16 },
  reportRow: { flexDirection: 'row', gap: 10 },
  btnCancel: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  btnCancelTxt: { fontWeight: '600' },
  btnConfirm: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  btnConfirmTxt: { color: '#fff', fontWeight: '700', textAlign: 'center' },
});
