import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  Alert, ActivityIndicator, Modal, Platform, Share, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useTranslation } from 'react-i18next';
import {
  signInGoogle, signInFacebook, signInApple, signOut, deleteAccount,
  getDailyHead, getTodayStandings, pushCurrentProfile, type DailyHead,
} from '../../src/services/firebase';
import { useProfileStore } from '../../src/stores/profileStore';
import * as QS from '../../src/services/questionnaireService';
import { DEFAULT_GUEST_NAME, translatePartName } from '../../src/models/constants';
import { Avatar } from '../../src/components/Avatar';
import { TipBanner } from '../../src/components/TipBanner';
import { UpdateBanner } from '../../src/components/UpdateBanner';
import { trackEvent } from '../../src/services/analytics';
import { scheduleDailyReminder } from '../../src/services/notifications';
import { useUpdateAvailable } from '../../src/services/updateCheck';
import { describeLiveRank } from '../../src/models/dailyRank';
import { getRankInfo, getRankLadder } from '../../src/models/rank';
import { useTheme, arNum, localeNum, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir, mirror } from '../../src/theme/direction';
import type { Language } from '../../src/i18n/languages';
import PressScale from '../../src/components/PressScale';
import Ring from '../../src/components/Ring';
import { DrawerMenu } from '../../src/components/DrawerMenu';

const DAILY_PERIOD_MS = 24 * 60 * 60 * 1000;
// Matches notifications.ts's STREAK_REMINDER_HOUR — "tonight" starts at the
// same evening hour the streak-loss reminder itself fires.
const EVENING_HOUR = 19;

/** Cross-platform alert (RN Alert is a no-op on react-native-web). */
function notify(title: string, msg: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${msg}`);
    return;
  }
  Alert.alert(title, msg);
}

/** Format a remaining duration (ms) as e.g. "5 ساعات و23 دقيقة". */
function formatRemaining(ms: number, t: (key: string, options?: any) => string): string {
  if (ms <= 0) return t('me.duration.availableNow');
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hPart = h > 0 ? t('me.duration.hours', { count: h }) : '';
  const mPart = m > 0 ? t('me.duration.minutes', { count: m }) : '';
  if (hPart && mPart) return t('me.duration.combined', { hours: hPart, minutes: mPart });
  return hPart || mPart || t('me.duration.lessThanMinute');
}

/** Compact score-over-time sparkline tile (one bar per recorded day). */
function ProgressChart({ scores, colors }: { scores: { date: number; score: number }[]; colors: ReturnType<typeof useTheme>['colors'] }) {
  const { t, i18n } = useTranslation();
  const { isRTL } = useDirection();
  const lang = i18n.language as Language;
  const MAX_BARS = 40;
  const data = scores.slice(-MAX_BARS);
  const H = 46;
  const MIN_BAR = 3;
  const enough = data.length >= 2;

  let bars: React.ReactNode = null;
  if (enough) {
    const vals = data.map((d) => d.score);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min;
    bars = data.map((d, i) => {
      const norm = range > 0 ? (d.score - min) / range : 0.5;
      const h = MIN_BAR + norm * (H - MIN_BAR);
      const isLast = i === data.length - 1;
      return <View key={i} style={[s.sparkBar, { height: h, backgroundColor: isLast ? colors.gold : colors.line }]} />;
    });
  }

  return (
    <View style={[s.bentoHalf, s.statTile, { backgroundColor: colors.card }]}>
      {/* Newest bar nearest the reading-start side */}
      <View style={[s.sparkRow, { height: H, flexDirection: rowDir(isRTL) }]}>
        {enough ? bars : <Text style={[s.sparkEmpty, { color: colors.line }]}>—</Text>}
      </View>
      <Text style={[s.statLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.progressChart.label')}</Text>
      <Text style={[s.statSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
        {enough ? t('me.progressChart.days', { count: localeNum(data.length, lang) }) : t('me.progressChart.startPlaying')}
      </Text>
    </View>
  );
}

/** Streak sheet — tapping the flame opens a place, not just a sticker: a week
 * calendar (days with a recorded score, as a play-day proxy), the best streak,
 * and an "at risk tonight" nudge once the evening reminder hour has passed. */
function StreakSheet({
  visible, onClose, colors, streak, bestStreak, scores, playedToday,
}: {
  visible: boolean; onClose: () => void; colors: ReturnType<typeof useTheme>['colors'];
  streak: number; bestStreak: number; scores: { date: number; score: number }[]; playedToday: boolean;
}) {
  const profile = useProfileStore();
  const { t, i18n } = useTranslation();
  const { isRTL } = useDirection();
  const lang = i18n.language as Language;
  const today = new Date().toISOString().split('T')[0];
  const isPlayedToday = playedToday || profile.lastPlayDate === today;
  const freezeTokens = profile.pvp.streakFreezeTokens ?? 0;
  const DOW = [
    t('me.dow.sun'), t('me.dow.mon'), t('me.dow.tue'), t('me.dow.wed'),
    t('me.dow.thu'), t('me.dow.fri'), t('me.dow.sat'),
  ];
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = d.toISOString().split('T')[0];
    const played = (i === 6 && isPlayedToday) || scores.some((sc) => new Date(sc.date).toISOString().split('T')[0] === key);
    return { label: DOW[d.getDay()], played, isToday: i === 6 };
  });
  const atRisk = !isPlayedToday && new Date().getHours() >= EVENING_HOUR && streak > 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetBg}>
        <View style={[s.sheet, { backgroundColor: colors.card }]}>
          <View style={[s.sheetHeader, { flexDirection: rowDir(isRTL) }]}>
            <PressScale onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.inkSoft} />
            </PressScale>
            <Text style={[s.sheetTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.streakSheet.title')}</Text>
            <View style={{ width: 22 }} />
          </View>

          <View style={s.streakHero}>
            <Ionicons name="flame" size={36} color={colors.gold} />
            <Text style={[s.streakBig, { color: colors.ink }]}>{localeNum(streak, lang)}</Text>
            <Text style={[s.streakUnit, { color: colors.inkSoft }]}>{t('me.streakSheet.daysInRow')}</Text>
          </View>

          <View style={[s.weekRow, { flexDirection: rowDir(isRTL) }]}>
            {days.map((d, i) => (
              <View key={i} style={s.weekCell}>
                <View style={[
                  s.weekDot,
                  { backgroundColor: d.played ? colors.gold : colors.goldPale },
                  d.isToday && { borderWidth: 2, borderColor: colors.ink },
                ]}
                >
                  {d.played && <Ionicons name="checkmark" size={14} color={colors.navy} />}
                </View>
                <Text style={[s.weekLabel, { color: colors.inkSoft }]}>{d.label}</Text>
              </View>
            ))}
          </View>

          <View style={[s.streakStatRow, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
            <Ionicons name="trophy-outline" size={16} color={colors.goldDeep} />
            <Text style={[s.streakStatTxt, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
              {t('me.streakSheet.bestStreak', { count: localeNum(bestStreak, lang) })}
            </Text>
          </View>

          {atRisk && (
            <View style={[s.riskBanner, { backgroundColor: colors.wrongPale, flexDirection: 'column', gap: 10 }]}>
              <View style={{ flexDirection: rowDir(isRTL), alignItems: 'center', gap: 8 }}>
                <Ionicons name="warning-outline" size={16} color={colors.wrong} />
                <Text style={[s.riskTxt, { color: colors.wrong, textAlign: alignDir(isRTL) }]}>
                  {t('me.streakSheet.riskBanner')}
                </Text>
              </View>
              {freezeTokens > 0 && (
                <PressScale
                  style={[s.freezeBtn, { backgroundColor: colors.gold }]}
                  onPress={() => {
                    if (profile.useStreakFreeze()) void pushCurrentProfile();
                  }}
                >
                  <Ionicons name="snow-outline" size={16} color={colors.navy} />
                  <Text style={[s.freezeBtnTxt, { color: colors.navy }]}>
                    {t('me.streakSheet.useFreezeBtn')}
                  </Text>
                </PressScale>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** Delete-account confirmation — full sheet, not a one-liner, since this is
 *  the one truly irreversible action in the app. */
function DeleteAccountSheet({
  visible, onClose, onConfirm, deleting,
}: {
  visible: boolean; onClose: () => void; onConfirm: () => void; deleting: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={das.bg}>
        <View style={[das.sheet, { backgroundColor: colors.card }]}>
          <View style={[das.iconRing, { backgroundColor: colors.wrongPale }]}>
            <Ionicons name="warning" size={28} color={colors.wrong} />
          </View>
          <Text style={[das.title, { color: colors.ink }]}>{t('settings.deleteSheetTitle')}</Text>
          <Text style={[das.body, { color: colors.inkSoft }]}>{t('settings.deleteSheetBody')}</Text>
          <PressScale
            style={[das.confirmBtn, { backgroundColor: colors.wrong }, deleting && { opacity: 0.6 }]}
            onPress={onConfirm}
            disabled={deleting}
          >
            {deleting
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={das.confirmTxt}>{t('settings.deleteSheetConfirm')}</Text>}
          </PressScale>
          <PressScale style={das.cancelBtn} onPress={onClose} disabled={deleting}>
            <Text style={[das.cancelTxt, { color: colors.inkSoft }]}>{t('settings.cancel')}</Text>
          </PressScale>
        </View>
      </View>
    </Modal>
  );
}

const das = StyleSheet.create({
  bg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.lg + 4, borderTopRightRadius: radii.lg + 4,
    padding: 24, paddingBottom: 36, alignItems: 'center', gap: 6,
    width: '100%', maxWidth: 512, alignSelf: 'center',
  },
  iconRing: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  title: { fontSize: 17, fontFamily: 'PlexArabic-Bold', textAlign: 'center' },
  body: { fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 14 },
  confirmBtn: { width: '100%', paddingVertical: 14, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  confirmTxt: { color: '#fff', fontSize: 15, fontFamily: 'PlexArabic-Bold' },
  cancelBtn: { paddingVertical: 12, marginTop: 2 },
  cancelTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
});

// A distinct badge per rank — a growing sense of accomplishment on the way
// up, not four identical dots with different labels.
const RANK_ICONS: React.ComponentProps<typeof Ionicons>['name'][] = ['leaf-outline', 'flame', 'book', 'trophy'];

/** Rank ladder sheet — tapping the rank progress bar opens the whole path
 * instead of leaving "متقن" a mystery: every rank, the points needed to
 * reach it, and a badge for reached / current / locked. */
function RankSheet({
  visible, onClose, colors, score,
}: {
  visible: boolean; onClose: () => void; colors: ReturnType<typeof useTheme>['colors']; score: number;
}) {
  const { t, i18n } = useTranslation();
  const { isRTL } = useDirection();
  const lang = i18n.language as Language;
  const ladder = getRankLadder(score);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetBg}>
        <View style={[s.sheet, { backgroundColor: colors.card }]}>
          <View style={[s.sheetHeader, { flexDirection: rowDir(isRTL) }]}>
            <PressScale onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.inkSoft} />
            </PressScale>
            <Text style={[s.sheetTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.rankSheet.title')}</Text>
            <View style={{ width: 22 }} />
          </View>

          <View style={s.rankList}>
            {ladder.map((r, i) => (
              <View
                key={r.title}
                style={[s.rankLadderRow, { borderColor: colors.line, flexDirection: rowDir(isRTL) }, r.current && { backgroundColor: colors.goldPale }]}
              >
                <View style={[
                  s.rankBadge,
                  { backgroundColor: r.reached ? colors.gold : colors.goldPale },
                  r.current && { borderWidth: 2, borderColor: colors.goldDeep },
                ]}
                >
                  <Ionicons name={RANK_ICONS[i]} size={19} color={r.reached ? colors.navy : colors.inkSoft} />
                </View>
                <View style={[s.rankLadderInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                  <Text style={[s.rankLadderTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{r.title}</Text>
                  <Text style={[s.rankLadderSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
                    {i === 0 ? t('me.rankSheet.fromStart') : t('me.rankSheet.fromPoints', { count: localeNum(r.threshold, lang) })}
                  </Text>
                </View>
                {r.current ? (
                  <View style={[s.rankNowBadge, { backgroundColor: colors.gold }]}>
                    <Text style={[s.rankNowTxt, { color: colors.navy }]}>{t('me.rankSheet.yourLevel')}</Text>
                  </View>
                ) : r.reached ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.correct} />
                ) : (
                  <Ionicons name="lock-closed-outline" size={16} color={colors.inkSoft} />
                )}
              </View>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function MeScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const { isRTL } = useDirection();
  const lang = i18n.language as Language;
  const profile = useProfileStore();
  const social = profile.social;
  const { update: pendingUpdate, dismiss: dismissUpdate } = useUpdateAvailable();

  const [dailyHead, setDailyHead] = useState<DailyHead | null | 'loading'>('loading');
  const [now, setNow] = useState(() => Date.now());
  const [avatarError, setAvatarError] = useState(false);
  // Post-win engagement: rank-comparison line for the "already done today" card.
  const [dailyRankLine, setDailyRankLine] = useState<string | null>(null);
  const [nicknameModalOpen, setNicknameModalOpen] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [streakSheetOpen, setStreakSheetOpen] = useState(false);
  const [rankSheetOpen, setRankSheetOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  useEffect(() => {
    getDailyHead()
      .then((h) => setDailyHead(h ?? null))
      .catch(() => setDailyHead(null));
  }, []);

  // Tick once a minute so the "next quiz" countdown stays current.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Once today's daily is done, arm a local notification for the moment the next
  // one rotates in (no-op without permission/native). Keyed off Date.now() at
  // effect-run-time rather than the ticking `now` state, so it schedules once
  // instead of on every minute tick.
  useEffect(() => {
    if (dailyHead === 'loading' || !dailyHead) return;
    if (profile.lastDailyCompletedDate !== new Date().toISOString().split('T')[0]) return;
    const nowMs = Date.now();
    const nextAt = dailyHead.start_time
      + (Math.floor((nowMs - dailyHead.start_time) / DAILY_PERIOD_MS) + 1) * DAILY_PERIOD_MS;
    scheduleDailyReminder(nextAt);
  }, [dailyHead, profile.lastDailyCompletedDate]);

  // Once today's daily quiz is done, fetch a live rank-comparison line against
  // today's actual participants — the same cohort the league screen's اليوم tab
  // shows, so the two never disagree (best-effort; hidden if unavailable).
  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    if (profile.lastDailyCompletedDate !== today || !profile.lastDailyScore) {
      setDailyRankLine(null);
      return;
    }
    let cancelled = false;
    getTodayStandings()
      .then((entries) => { if (!cancelled) setDailyRankLine(describeLiveRank(entries, profile.uid)); })
      .catch(() => { if (!cancelled) setDailyRankLine(null); });
    return () => { cancelled = true; };
  }, [profile.lastDailyCompletedDate, profile.lastDailyScore, profile.uid]);

  // Prompt a guest once to pick a nickname instead of the generic "زائر(ة)" on
  // the leaderboard — auto-shown the first time they land here still on the
  // default name. Always reachable afterward via the manual edit button.
  useEffect(() => {
    if (!social.isAnonymous || social.displayName !== DEFAULT_GUEST_NAME) return;
    let cancelled = false;
    AsyncStorage.getItem('guest_nickname_prompted').then((v) => {
      if (cancelled || v) return;
      setNicknameInput('');
      setNicknameModalOpen(true);
      AsyncStorage.setItem('guest_nickname_prompted', '1');
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [social.isAnonymous, social.displayName]);

  // Reclaim the header: greeting + a gear icon into settings, replacing the
  // repeated app-name nameplate.
  const firstName = social.displayName?.split(' ')[0] ?? '';
  const greeting = firstName ? t('me.greeting', { name: firstName }) : t('me.greetingNoName');
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => <Text style={{ color: '#fff', fontSize: 16, fontFamily: 'PlexArabic-Bold' }}>{greeting}</Text>,
      headerLeft: () => (
        <PressScale onPress={() => setDrawerOpen(true)} hitSlop={8} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
          <Ionicons name="menu" size={24} color={colors.navySoft} />
        </PressScale>
      ),
      headerRight: () => (
        <PressScale onPress={() => router.push('/(app)/settings')} hitSlop={8} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
          <Ionicons name="settings-outline" size={24} color={colors.navySoft} />
        </PressScale>
      ),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greeting, isRTL]);

  async function saveNickname() {
    const trimmed = nicknameInput.trim().slice(0, 20);
    if (trimmed) {
      // Nickname editing is only reachable for anonymous guests (see the
      // social.isAnonymous branch below) — guest progress deliberately stays
      // local-only until upgrade (pushCurrentProfile() no-ops for them), so
      // there's nothing to push to Firebase here.
      await profile.setSocial({ ...social, displayName: trimmed });
    }
    setNicknameModalOpen(false);
  }

  function openNicknameEditor() {
    setNicknameInput(social.displayName && social.displayName !== DEFAULT_GUEST_NAME ? social.displayName : '');
    setNicknameModalOpen(true);
  }

  function launchDaily(head: DailyHead) {
    const weights = profile.getDailyQuizStudyPartsWeights();
    QS.initDailyQuiz(head.daily_random, profile.parts, weights);
    router.push({ pathname: '/(app)/quiz', params: { dailyMode: '1' } });
  }

  function startDaily() {
    if (!dailyHead || dailyHead === 'loading') return;
    launchDaily(dailyHead);
  }

  async function shareScore() {
    trackEvent('share_tap', { surface: 'daily_score_me' });
    // A submission still pending confirmation hasn't updated lastDailyScore
    // yet (see endDailyQuiz in quiz.tsx) — fall back to the pending payload's
    // score so a share right after finishing shows today's actual result.
    const today = new Date().toISOString().split('T')[0];
    const score = profile.lastDailyCompletedDate === today
      ? profile.lastDailyScore
      : profile.pendingDailySubmit?.score ?? profile.lastDailyScore;
    try {
      // message already embeds the url; don't also pass `url`, or share
      // targets that surface both (e.g. iMessage) duplicate it.
      await Share.share({
        message: t('quiz.dailyEnd.shareMsg', { score, appName: t('common.appName') }),
      });
    } catch { /* ignore */ }
  }

  async function upgradeGuest(provider: 'google' | 'facebook' | 'apple') {
    try {
      if (provider === 'google') await signInGoogle();
      else if (provider === 'facebook') await signInFacebook();
      else await signInApple();
    } catch {
      const errorKey = provider === 'google' ? 'auth.errorGoogle'
        : provider === 'facebook' ? 'auth.errorFacebook' : 'auth.errorApple';
      // A slight delay avoids a real iOS timing issue where Alert.alert can
      // silently fail to show if it's presented immediately after a native
      // auth sheet dismisses (see handleApple in (auth)/index.tsx).
      setTimeout(() => notify(t('auth.errorTitle'), t(errorKey)), 400);
    }
  }

  async function performSignOut() {
    setSigningOut(true);
    try { await signOut(); } catch (e) { console.error(e); }
    await profile.delete().catch(console.error);
    router.replace('/(auth)');
  }

  function handleSignOut() {
    const msg = t('settings.signOutConfirmMsg');
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || window.confirm(`${t('settings.signOut')}\n\n${msg}`)) performSignOut();
      return;
    }
    Alert.alert(t('settings.signOut'), msg, [
      { text: t('settings.no'), style: 'cancel' },
      { text: t('settings.yes'), style: 'destructive', onPress: performSignOut },
    ]);
  }

  async function performDeleteAccount() {
    setDeletingAccount(true);
    try {
      await deleteAccount();
      await profile.delete().catch(console.error);
      setDeleteSheetOpen(false);
      router.replace('/(auth)');
    } catch (e) {
      setDeletingAccount(false);
      setDeleteSheetOpen(false);
      console.error(e);
      notify(t('settings.errorTitle'), t('settings.errorBody'));
    }
  }

  // ── Derived values ──
  const score = profile.getScore();
  const yesterday = profile.scores.length >= 2
    ? profile.scores[profile.scores.length - 2]?.score ?? 0
    : 0;
  const trend = score - yesterday;
  const rank = getRankInfo(score);

  const today = new Date().toISOString().split('T')[0];
  // Treat an unconfirmed submission from today the same as completed — the
  // quiz was in fact taken, it just hasn't been retried/confirmed yet (see
  // endDailyQuiz in quiz.tsx), so don't offer to start it again.
  const dailyCompleted = dailyHead !== 'loading'
    && dailyHead != null
    && (profile.lastDailyCompletedDate === today || profile.pendingDailySubmit?.date === today);
  const playedToday = profile.lastPlayDate === today;

  // The daily quiz rotates every 24h from start_time. Roll forward to the next
  // 24h boundary so the countdown is always a concrete, positive wait — even if
  // the cached head is already more than a day old.
  const nextDailyMs = dailyHead !== 'loading' && dailyHead != null
    ? dailyHead.start_time
      + (Math.floor((now - dailyHead.start_time) / DAILY_PERIOD_MS) + 1) * DAILY_PERIOD_MS
      - now
    : 0;

  const weakSura = profile.getTopBadParts()[0];
  const weakPartIndex = weakSura && weakSura !== '-'
    ? profile.parts.findIndex((p) => p.name === weakSura)
    : -1;

  const studyPct = parseFloat(profile.getPercentTotalStudy()) || 0;
  const ratioPct = parseFloat(profile.getPercentTotalRatio()) || 0;

  const avatarUri = social.photoURL && !avatarError ? social.photoURL : undefined;

  const startQuiz = () => router.push({ pathname: '/(app)/quiz', params: { chooser: '1', nonce: String(Date.now()) } });

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['bottom']}>
      <UpdateBanner update={pendingUpdate} onDismiss={dismissUpdate} />
      {!pendingUpdate && <TipBanner />}
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Identity strip: avatar + points + streak (greeting lives in the header) ── */}
        <View style={[s.topStrip, { flexDirection: rowDir(isRTL) }]}>
          <Avatar
            uri={avatarUri}
            fallback={require('../../assets/images/app-icon.png')}
            style={[s.topAvatar, { borderColor: colors.goldPale, backgroundColor: colors.paper }]}
            onError={() => setAvatarError(true)}
          />
          <View style={[s.topInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
            {social.isAnonymous ? (
              <PressScale style={[s.topSubRow, { flexDirection: rowDir(isRTL) }]} onPress={openNicknameEditor} hitSlop={6}>
                <Ionicons name="pencil" size={11} color={colors.inkSoft} />
                <Text style={[s.topSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]} numberOfLines={1}>
                  {social.displayName || t('common.guestName')}
                </Text>
              </PressScale>
            ) : (
              <Text style={[s.topSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]} numberOfLines={1}>
                {social.email ?? social.displayName ?? ''}
              </Text>
            )}
            <Text style={[s.topPoints, { textAlign: alignDir(isRTL) }]} numberOfLines={1}>
              {trend !== 0 && (
                <Text style={trend > 0 ? { color: colors.correct } : { color: colors.wrong }}>{trend > 0 ? '▲' : '▼'} </Text>
              )}
              <Text style={[s.topPointsVal, { color: colors.ink }]}>{localeNum(score, lang)}</Text>
              <Text style={[s.topPointsLabel, { color: colors.inkSoft }]}>{t('me.pointsSuffix')}</Text>
            </Text>
          </View>
          <PressScale
            style={[s.streakBadge, { backgroundColor: colors.goldPale, borderColor: colors.gold, opacity: profile.streak > 0 ? 1 : 0.5, flexDirection: rowDir(isRTL) }]}
            onPress={() => setStreakSheetOpen(true)}
          >
            <Ionicons name="flame" size={16} color={colors.goldDeep} />
            <Text style={[s.streakTxt, { color: colors.goldDeep }]}>{localeNum(profile.streak, lang)}</Text>
          </PressScale>
          <PressScale
            style={[s.friendsBadge, { backgroundColor: colors.goldPale, borderColor: colors.gold }]}
            onPress={() => router.push('/(app)/friends')}
            accessibilityRole="button"
            accessibilityLabel={t('friends.title')}
          >
            <Ionicons name="people" size={16} color={colors.goldDeep} />
          </PressScale>
        </View>

        {/* ── Study rank section: a heading names the system, the bar shows
            where the score sits (tap opens the full ladder), and the action
            row is the one thing that actually moves this specific bar —
            answering quiz questions — so the driving action sits right under
            the progress it drives instead of in a separate generic row. ── */}
        <View style={[s.bentoFull, s.progressSection, { backgroundColor: colors.card }]}>
          <Text style={[s.sectionLabel, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('me.rankSheet.title')}</Text>
          <PressScale style={[s.rankHeaderRow, { flexDirection: rowDir(isRTL) }]} onPress={() => setRankSheetOpen(true)}>
            <View style={[s.rankBadgeSmall, { backgroundColor: colors.gold }]}>
              <Ionicons name={RANK_ICONS[rank.index]} size={18} color={colors.navy} />
            </View>
            <View style={s.rankColumn}>
              <View style={[s.rankRow, { flexDirection: rowDir(isRTL) }]}>
                <View style={[s.rankTitleRow, { flexDirection: rowDir(isRTL) }]}>
                  <Text style={[s.rankTitle, { color: colors.ink }]}>{rank.title}</Text>
                  <Ionicons name={mirror(isRTL, 'chevron-forward', 'chevron-back')} size={14} color={colors.inkSoft} />
                </View>
                {rank.nextTitle && (
                  <Text style={[s.rankNext, { color: colors.inkSoft, textAlign: isRTL ? 'left' : 'right' }]}>
                    {t('me.pointsToRank', { remaining: localeNum(rank.remaining, lang), nextTitle: rank.nextTitle })}
                  </Text>
                )}
              </View>
              <View style={[s.rankTrack, { backgroundColor: colors.goldPale }]}>
                <View style={[s.rankFill, { width: `${rank.progress * 100}%`, backgroundColor: colors.gold, [isRTL ? 'right' : 'left']: 0 }]} />
              </View>
            </View>
          </PressScale>
          <PressScale style={[s.sectionActionBtn, { backgroundColor: colors.navy, flexDirection: rowDir(isRTL) }]} onPress={startQuiz}>
            <Ionicons name="play" size={18} color="#fff" />
            <Text style={s.sectionActionTxt}>{t('quiz.startQuiz')}</Text>
          </PressScale>
          {weakPartIndex >= 0 && (
            <PressScale
              style={[s.wayNudge, { backgroundColor: colors.goldPale, flexDirection: rowDir(isRTL) }]}
              onPress={() => router.push({ pathname: '/(app)/quiz', params: { customPart: String(weakPartIndex), nonce: String(Date.now()) } })}
            >
              <Ionicons name={mirror(isRTL, 'chevron-forward', 'chevron-back')} size={16} color={colors.goldDeep} />
              <Text style={[s.wayNudgeTxt, { color: colors.goldDeep, textAlign: alignDir(isRTL) }]}>{t('me.weakSuraNudge', { sura: translatePartName(weakSura) })}</Text>
              <Ionicons name="warning" size={15} color={colors.goldDeep} />
            </PressScale>
          )}
        </View>

        {/* ── One hero at a time: the daily card until completed ── */}
        {dailyHead === 'loading' ? (
          <View style={[s.bentoFull, s.dailyHeroDark, { backgroundColor: colors.navy }]}>
            <ActivityIndicator color="#fff" size="large" />
          </View>
        ) : dailyCompleted ? (
          <View style={[s.bentoFull, s.dailyStripDone, { backgroundColor: colors.correctPale, borderColor: colors.correct, flexDirection: rowDir(isRTL) }]}>
            <Ionicons name="checkmark-circle" size={20} color={colors.correct} />
            <View style={[s.dailyStripText, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.dailyStripTitle, { color: colors.correct, textAlign: alignDir(isRTL) }]}>
                {t('me.dailyHero.completed', { duration: formatRemaining(nextDailyMs, t) })}
              </Text>
              {dailyRankLine && <Text style={[s.rankLine, { color: colors.goldDeep, textAlign: alignDir(isRTL) }]}>{dailyRankLine}</Text>}
            </View>
            <PressScale onPress={shareScore} hitSlop={6} testID="daily-score-share-button">
              <Ionicons name="share-social-outline" size={18} color={colors.correct} />
            </PressScale>
          </View>
        ) : dailyHead ? (
          <View style={[s.bentoFull, s.dailyHeroDark, { backgroundColor: colors.navy }]}>
            <View style={[s.dailyHeroRow, { flexDirection: rowDir(isRTL) }]}>
              <Ionicons name="star" size={34} color={colors.gold} />
              <View style={[s.dailyHeroText, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                <Text style={[s.dailyTitle, { textAlign: alignDir(isRTL) }]}>{t('me.dailyHero.readyTitle')}</Text>
                <Text style={[s.dailyBody, { color: colors.navySoft, textAlign: alignDir(isRTL) }]}>{t('me.dailyHero.readyBody')}</Text>
              </View>
            </View>
            <PressScale style={[s.dailyBtn, { backgroundColor: colors.gold, shadowColor: colors.goldDeep }]} onPress={startDaily}>
              <Text style={[s.dailyBtnTxt, { color: colors.navy }]}>{t('league.emptyBtnDaily')}</Text>
            </PressScale>
          </View>
        ) : (
          <View style={[s.bentoFull, s.dailyHeroUnavail, { backgroundColor: colors.card, flexDirection: rowDir(isRTL) }]}>
            <Ionicons name="time-outline" size={30} color={colors.inkSoft} />
            <View style={[s.dailyHeroText, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.dailyUnavailTxt, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.dailyHero.unavailTitle')}</Text>
              <Text style={[s.dailyUnavailSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('me.dailyHero.unavailSub')}</Text>
            </View>
          </View>
        )}

        {/* ── BENTO: 2× progress ring tiles + sparkline ── */}
        <View style={[s.bentoRow, { flexDirection: rowDir(isRTL) }]}>
          <View style={[s.bentoHalf, s.statTile, { backgroundColor: colors.card }]}>
            <Ring pct={studyPct} color={colors.gold} trackColor={colors.goldPale} innerColor={colors.card} />
            <Text style={[s.statLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.statTiles.studyLabel')}</Text>
            <Text style={[s.statSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('me.statTiles.studySub')}</Text>
          </View>
          <View style={[s.bentoHalf, s.statTile, { backgroundColor: colors.card }]}>
            <Ring pct={ratioPct} color={colors.correct} trackColor={colors.correctPale} innerColor={colors.card} />
            <Text style={[s.statLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.statTiles.ratioLabel')}</Text>
            <Text style={[s.statSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('me.statTiles.ratioSub')}</Text>
          </View>
          <ProgressChart scores={profile.scores} colors={colors} />
        </View>

        {/* ── Sign-in nag — demoted to a one-line banner, modern brand colors ── */}
        {social.isAnonymous && (
          <View style={[s.anonBanner, { backgroundColor: colors.card, borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
            <Text style={[s.anonTxt, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]} numberOfLines={1}>{t('me.anonNag')}</Text>
            <View style={[s.anonBtns, { flexDirection: rowDir(isRTL) }]}>
              {/* Apple requires its own native button component (not a custom
                  one) to start the auth flow — App Store guideline 4.8. iOS
                  only: no Android/web equivalent. */}
              {Platform.OS === 'ios' && (
                <AppleAuthentication.AppleAuthenticationButton
                  testID="apple-upgrade-button"
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={15}
                  style={s.appleIconBtn}
                  onPress={() => upgradeGuest('apple')}
                />
              )}
              <PressScale
                style={[s.iconBtn, { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line }]}
                onPress={() => upgradeGuest('google')}
                accessibilityRole="button"
                accessibilityLabel={t('auth.continueGoogle')}
              >
                <Ionicons name="logo-google" size={16} color="#4285F4" />
              </PressScale>
              <PressScale
                style={[s.iconBtn, { backgroundColor: '#1877F2' }]}
                onPress={() => upgradeGuest('facebook')}
                accessibilityRole="button"
                accessibilityLabel={t('auth.continueFacebook')}
              >
                <Ionicons name="logo-facebook" size={16} color="#fff" />
              </PressScale>
            </View>
          </View>
        )}

      </ScrollView>

      <StreakSheet
        visible={streakSheetOpen}
        onClose={() => setStreakSheetOpen(false)}
        colors={colors}
        streak={profile.streak}
        bestStreak={profile.bestStreak}
        scores={profile.scores}
        playedToday={playedToday}
      />

      <RankSheet
        visible={rankSheetOpen}
        onClose={() => setRankSheetOpen(false)}
        colors={colors}
        score={score}
      />

      <DrawerMenu
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={[
          {
            key: 'map',
            icon: 'map-outline',
            label: t('me.mapCard.title'),
            onPress: () => router.push('/(app)/map'),
          },
          {
            key: 'pvp-journey',
            icon: 'flash-outline',
            label: t('pvpJourney.title'),
            onPress: () => router.push('/(app)/pvp-journey'),
          },
        ]}
        footerItems={[
          ...(!social.isAnonymous && social.uid ? [{
            key: 'sign-out',
            icon: 'log-out-outline' as const,
            label: t('settings.signOut'),
            onPress: handleSignOut,
            destructive: true,
          }] : []),
          {
            key: 'delete-account',
            icon: 'trash-outline',
            label: t('settings.deleteAccountLink'),
            onPress: () => setDeleteSheetOpen(true),
            destructive: true,
          },
        ]}
      />

      <DeleteAccountSheet
        visible={deleteSheetOpen}
        onClose={() => setDeleteSheetOpen(false)}
        onConfirm={performDeleteAccount}
        deleting={deletingAccount}
      />

      {/* Guest nickname picker — auto-shown once for a fresh guest, always
          reachable afterward via the ✎ next to the identity subtitle. */}
      <Modal
        visible={nicknameModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setNicknameModalOpen(false)}
      >
        <View style={s.nickOverlay}>
          <View style={[s.nickBox, { backgroundColor: colors.card }]}>
            <Text style={[s.nickTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('me.nicknameModal.title')}</Text>
            <TextInput
              style={[s.nickInput, { borderColor: colors.line, color: colors.ink }]}
              value={nicknameInput}
              onChangeText={setNicknameInput}
              placeholder={t('common.guestName')}
              placeholderTextColor={colors.inkSoft}
              maxLength={20}
              textAlign={alignDir(isRTL)}
              autoFocus
            />
            <View style={[s.nickRow, { flexDirection: rowDir(isRTL) }]}>
              <PressScale style={[s.nickSkip, { backgroundColor: colors.goldPale }]} onPress={() => setNicknameModalOpen(false)}>
                <Text style={[s.nickSkipTxt, { color: colors.inkSoft }]}>{t('me.nicknameModal.later')}</Text>
              </PressScale>
              <PressScale style={[s.nickSave, { backgroundColor: colors.navy }]} onPress={saveNickname}>
                <Text style={s.nickSaveTxt}>{t('me.nicknameModal.save')}</Text>
              </PressScale>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const CARD_SHADOW = {
  boxShadow: '0px 2px 8px rgba(13,45,78,0.08)',
  elevation: 2,
} as const;

const s = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 14, gap: 12, paddingBottom: 36 },

  // Top strip
  topStrip: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 2,
    paddingTop: 2,
  },
  topAvatar: { width: 46, height: 46, borderRadius: 23, borderWidth: 2 },
  topInfo: { flex: 1 },
  topSub: { fontSize: 12 },
  topSubRow: { alignItems: 'center', gap: 4 },
  topPoints: { fontSize: 15, marginTop: 2 },
  topPointsVal: { fontFamily: 'PlexArabic-Bold' },
  topPointsLabel: { fontSize: 12 },
  streakBadge: {
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  streakTxt: { fontSize: 14, fontFamily: 'PlexArabic-Bold' },
  friendsBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
  },

  // Bento primitives
  bentoFull: { borderRadius: radii.lg, ...CARD_SHADOW },
  bentoRow: { gap: 12 },
  bentoHalf: { flex: 1, borderRadius: radii.lg, ...CARD_SHADOW },

  progressSection: { padding: 14, gap: 12 },
  sectionLabel: { fontSize: 12, fontFamily: 'PlexArabic-Bold' },
  rankHeaderRow: { alignItems: 'flex-start', gap: 10 },
  rankBadgeSmall: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  rankColumn: { flex: 1, gap: 8 },
  rankRow: { alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  rankTitleRow: { alignItems: 'center', gap: 4 },
  rankTitle: { fontSize: 16, fontFamily: 'PlexArabic-Bold' },
  rankNext: { fontSize: 12, flexShrink: 1 },
  // RTL: the fill grows from the right edge (app convention).
  rankTrack: { height: 6, borderRadius: 3, overflow: 'hidden', position: 'relative' },
  rankFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },

  // Rank ladder sheet
  rankList: { gap: 8, marginTop: 12 },
  rankLadderRow: {
    alignItems: 'center', gap: 12,
    padding: 10, borderRadius: radii.md, borderWidth: 1,
  },
  rankBadge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  rankLadderInfo: { flex: 1 },
  rankLadderTitle: { fontSize: 15, fontFamily: 'PlexArabic-Bold' },
  rankLadderSub: { fontSize: 12, marginTop: 1 },
  rankNowBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill },
  rankNowTxt: { fontSize: 11, fontFamily: 'PlexArabic-Bold' },

  // Daily hero
  dailyHeroDark: { padding: 20, gap: 14 },
  dailyHeroRow: { alignItems: 'center', gap: 14 },
  dailyHeroText: { flex: 1 },
  dailyTitle: { fontSize: 20, fontFamily: 'PlexArabic-Bold', color: '#fff' },
  dailyBody: { fontSize: 13, marginTop: 2 },
  dailyBtn: {
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: 'center',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  dailyBtnTxt: { fontSize: 16, fontFamily: 'PlexArabic-Bold' },
  dailyStripDone: {
    alignItems: 'center', gap: 10, padding: 14, borderWidth: 1.5,
  },
  dailyStripText: { flex: 1 },
  dailyStripTitle: { fontSize: 13, fontFamily: 'PlexArabic-SemiBold' },
  rankLine: { fontSize: 11, fontFamily: 'PlexArabic-SemiBold', marginTop: 2 },
  dailyHeroUnavail: { padding: 18, alignItems: 'center', gap: 14 },
  dailyUnavailTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
  dailyUnavailSub: { fontSize: 12, marginTop: 2 },

  // Progress section action row (the "driving action" paired with each bar)
  sectionActionBtn: {
    alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radii.md,
  },
  sectionActionTxt: { fontSize: 14, fontFamily: 'PlexArabic-Bold', color: '#fff' },
  wayNudge: {
    alignItems: 'center', gap: 6, padding: 10, borderRadius: radii.md,
  },
  wayNudgeTxt: { flex: 1, fontSize: 12, fontFamily: 'PlexArabic-SemiBold' },

  // Stat ring tiles
  statTile: { padding: 14, alignItems: 'center', justifyContent: 'center', gap: 6 },
  statLabel: { fontSize: 13, fontFamily: 'PlexArabic-Bold' },
  statSub: { fontSize: 11 },
  sparkRow: { width: '100%', alignItems: 'flex-end', justifyContent: 'center', gap: 1.5 },
  sparkBar: { flex: 1, maxWidth: 9, minWidth: 2, borderRadius: 2 },
  sparkEmpty: { fontSize: 18, fontFamily: 'PlexArabic-Bold' },

  // Sign-in nag — a compact one-liner
  anonBanner: {
    alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: radii.md, borderWidth: 1, gap: 8,
  },
  anonTxt: { fontSize: 12, flex: 1 },
  anonBtns: { gap: 6 },
  iconBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  appleIconBtn: { width: 130, height: 30 },

  // Bottom sheets (streak, rank ladder) — Modal renders outside the web
  // column wrapper (see WebFrame in app/_layout.tsx), so the sheet itself
  // needs the same width cap or it stretches full-browser-width on desktop.
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.lg + 4, borderTopRightRadius: radii.lg + 4,
    padding: 20, paddingBottom: 32,
    width: '100%', maxWidth: 512, alignSelf: 'center',
  },
  sheetHeader: { alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 16, fontFamily: 'PlexArabic-Bold' },
  streakHero: { alignItems: 'center', gap: 4, paddingVertical: 16 },
  streakBig: { fontSize: 40, fontFamily: 'PlexArabic-Bold' },
  streakUnit: { fontSize: 13 },
  weekRow: { justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: 16 },
  weekCell: { alignItems: 'center', gap: 4 },
  weekDot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  weekLabel: { fontSize: 10 },
  streakStatRow: { alignItems: 'center', gap: 8, paddingTop: 14, borderTopWidth: 1 },
  streakStatTxt: { fontSize: 13, fontFamily: 'PlexArabic-SemiBold' },
  riskBanner: { alignItems: 'center', gap: 8, padding: 12, borderRadius: radii.md, marginTop: 14 },
  riskTxt: { flex: 1, fontSize: 12, fontFamily: 'PlexArabic-SemiBold' },
  freezeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    alignSelf: 'stretch',
  },
  freezeBtnTxt: { fontSize: 13, fontFamily: 'PlexArabic-Bold' },

  // Guest nickname modal
  nickOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  nickBox: { borderRadius: radii.lg, padding: 20, width: '100%', maxWidth: 400, gap: 14 },
  nickTitle: { fontSize: 15, fontFamily: 'PlexArabic-Bold' },
  nickInput: {
    borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15,
  },
  nickRow: { gap: 10 },
  nickSkip: { flex: 1, paddingVertical: 12, borderRadius: radii.md, alignItems: 'center' },
  nickSkipTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
  nickSave: { flex: 1, paddingVertical: 12, borderRadius: radii.md, alignItems: 'center' },
  nickSaveTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold', color: '#fff' },
});
