import { Fragment, useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import {
  getDailyHead, subscribeYesterdayReport, subscribeMonthlyTopReport, subscribeTodayStandings,
  type DailyHead, type LeaderboardEntry,
} from '../../src/services/firebase';
import { findOwnRank, type RankedEntry } from '../../src/models/dailyRank';
import { useProfileStore } from '../../src/stores/profileStore';
import * as QS from '../../src/services/questionnaireService';
import { flagEmoji } from '../../src/models/constants';
import { useTheme, localeNum, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir } from '../../src/theme/direction';
import { LANGUAGE_META } from '../../src/i18n/languages';
import PressScale from '../../src/components/PressScale';

type Tab = 'today' | 'yesterday' | 'month';
type Status = 'loading' | 'available' | 'empty' | 'error';

const MEDAL = ['🥇', '🥈', '🥉'];
const PODIUM_TINTS = ['#c8973a', '#8a99a8', '#b06a3a']; // gold / silver / bronze accents

/** First-letter circle avatar — leaderboard entries carry no photo. */
function InitialAvatar({ name, size, tint, colors }: { name: string; size: number; tint?: string; colors: ReturnType<typeof useTheme>['colors'] }) {
  const letter = (name || '؟').trim().charAt(0);
  return (
    <View style={[s.initAvatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: tint ?? colors.goldPale }]}>
      <Text style={[s.initAvatarTxt, { fontSize: size * 0.42, color: tint ? '#fff' : colors.goldDeep }]}>{letter}</Text>
    </View>
  );
}

export default function LeagueScreen() {
  const { t } = useTranslation();
  const { isRTL, language } = useDirection();
  const router = useRouter();
  const navigation = useNavigation();
  const { colors } = useTheme();
  const profile = useProfileStore();

  const [tab, setTab] = useState<Tab>('today');
  const [status, setStatus] = useState<Status>('loading');
  const [head, setHead] = useState<DailyHead | null>(null);
  const [yday, setYday] = useState<LeaderboardEntry[]>([]);
  // Full month standings (cumulative per-uid totals, best-first, unbounded) —
  // kept whole so the user's own monthly rank is computable even when they're
  // far outside the top-10 slice the list displays.
  const [monthAll, setMonthAll] = useState<LeaderboardEntry[]>([]);
  const [ydayLoaded, setYdayLoaded] = useState(false);
  const [monthLoaded, setMonthLoaded] = useState(false);
  // Today's live, unbounded standings (every submission so far today) — the
  // only feed with full participant coverage, so it's what powers "your rank"
  // and the اليوم tab.
  const [todayStandings, setTodayStandings] = useState<LeaderboardEntry[]>([]);

  const today = new Date().toISOString().split('T')[0];
  const dailyDone = profile.lastDailyCompletedDate === today;

  const checkDaily = useCallback(async () => {
    setStatus('loading');
    try {
      const h = await getDailyHead();
      if (h && h.daily_random != null) {
        setHead(h);
        setStatus('available');
      } else {
        setStatus('empty');
      }
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => { checkDaily(); }, [checkDaily]);

  // Live subscriptions — independent of daily-head status, so the leaderboard
  // still shows even if today's quiz itself isn't published yet. Ranks update
  // in place while the screen is open instead of needing a re-open to refresh.
  useEffect(() => {
    let cancelled = false;
    let unsubYday: (() => void) | undefined;
    subscribeYesterdayReport((entries) => {
      setYday(entries);
      setYdayLoaded(true);
    }).then((unsub) => { if (cancelled) unsub(); else unsubYday = unsub; });
    const unsubMonth = subscribeMonthlyTopReport((entries) => {
      setMonthAll(entries);
      setMonthLoaded(true);
    });
    const unsubToday = subscribeTodayStandings(setTodayStandings);
    return () => {
      cancelled = true;
      unsubYday?.();
      unsubMonth();
      unsubToday();
    };
  }, []);

  // Reclaim the header: the month name instead of the app's repeated name.
  useEffect(() => {
    const monthName = new Date().toLocaleDateString(LANGUAGE_META[language].numberTag, { month: 'long' });
    navigation.setOptions({
      headerTitle: () => <Text style={{ color: '#fff', fontSize: 16, fontFamily: 'PlexArabic-Bold' }}>{t('league.title')} · {monthName}</Text>,
    });
  }, [navigation, language, t]);

  function startDaily() {
    if (!head) return;
    const begin = () => {
      const weights = profile.getDailyQuizStudyPartsWeights();
      QS.initDailyQuiz(head.daily_random, profile.parts, weights);
      router.push({ pathname: '/(app)/quiz', params: { dailyMode: '1' } });
    };
    const title = t('league.startDialog.title');
    const msg = t('league.startDialog.msg');
    // RN Alert is a no-op on react-native-web, so use the browser confirm there.
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || window.confirm(`${title}\n\n${msg}`)) begin();
      return;
    }
    Alert.alert(title, msg, [
      { text: t('league.startDialog.no'), style: 'cancel' },
      { text: t('league.startDialog.start'), onPress: begin },
    ]);
  }

  const listData = tab === 'today' ? todayStandings : tab === 'yesterday' ? yday : monthAll.slice(0, 10);
  const reportsLoading = tab === 'today' ? false : tab === 'yesterday' ? !ydayLoaded : !monthLoaded;
  const ownRank = findOwnRank(todayStandings, profile.uid);
  // Own monthly rank — only rendered as an extra tail row when the user is
  // outside the displayed top-10 (inside it, their own row is already lit up).
  const monthOwnRank = tab === 'month' ? findOwnRank(monthAll, profile.uid, 0) : null;

  // Movement vs yesterday — only computable where we have real data: the
  // اليوم tab, cross-referenced against yesterday's own top-N report. Rows
  // absent from yesterday's report get no delta (they may be new, or just
  // outside that top-N — the backend doesn't retain full historical ranks).
  const yesterdayRankOf = new Map<string, number>();
  yday.forEach((e, i) => { if (e.uid) yesterdayRankOf.set(e.uid, i + 1); });
  function movementFor(entry: LeaderboardEntry, todayRank: number): number | null {
    if (tab !== 'today' || !entry.uid) return null;
    const yRank = yesterdayRankOf.get(entry.uid);
    if (yRank == null) return null;
    return yRank - todayRank; // positive ⇒ moved up
  }

  // Podium only makes sense with a full top-3 — with 1-2 entries (e.g. a
  // quiet يوم/أمس), splitting into a 3-slot podium + "everyone from rank 4"
  // list dropped every real entry: podium.length === 3 was never true, and
  // listData.slice(3) is empty whenever there are fewer than 3 total rows.
  const podium = listData.length >= 3 ? listData.slice(0, 3) : [];
  const rest = listData.length >= 3 ? listData.slice(3) : listData;

  // Days-played chip for cumulative month rows: calendar icon + localized
  // count. Language-neutral on purpose — no pluralized string to translate
  // into every locale. Renders nothing for single-day entries (no days field).
  function daysChipFor(item: LeaderboardEntry) {
    if (item.days == null) return null;
    return (
      <View style={[s.daysChip, { flexDirection: rowDir(isRTL) }]}>
        <Ionicons name="calendar-clear-outline" size={11} color={colors.inkSoft} />
        <Text style={[s.daysChipTxt, { color: colors.inkSoft }]}>{localeNum(item.days, language)}</Text>
      </View>
    );
  }

  function renderRow({ item, index }: { item: LeaderboardEntry; index: number }) {
    const rank = index + podium.length + 1; // podium (if any) covers 1..podium.length
    const isMe = item.uid === profile.uid;
    const flag = flagEmoji(item.country);
    const delta = movementFor(item, rank);
    return (
      <View style={[s.row, { flexDirection: rowDir(isRTL) }, isMe && { backgroundColor: colors.goldPale }]}>
        <Text style={[s.rank, { color: colors.inkSoft }]}>{localeNum(rank, language)}</Text>
        {flag ? <Text style={s.rowFlag}>{flag}</Text> : <View style={s.rowFlagPlaceholder} />}
        <Text style={[s.rowName, { color: colors.ink, textAlign: alignDir(isRTL) }, isMe && { fontFamily: 'PlexArabic-Bold', color: colors.goldDeep }]} numberOfLines={1}>{item.name ?? t('common.guestName')}</Text>
        {daysChipFor(item)}
        {delta != null && delta !== 0 && (
          <Text style={[s.delta, delta > 0 ? { color: colors.correct } : { color: colors.wrong }]}>
            {delta > 0 ? `▲${localeNum(delta, language)}` : `▼${localeNum(Math.abs(delta), language)}`}
          </Text>
        )}
        <Text style={[s.rowScore, { color: colors.ink, textAlign: isRTL ? 'left' : 'right' }, isMe && { color: colors.goldDeep }]}>{localeNum(item.score, language)}</Text>
      </View>
    );
  }

  // Compact neighbor row for the "your rank today" card — same shape as
  // renderRow but takes an explicit rank number (not a list index).
  function renderNeighborRow(item: RankedEntry, isMe: boolean) {
    const flag = flagEmoji(item.country);
    return (
      <View key={`${item.rank}-${item.uid ?? item.name}`} style={[s.row, { flexDirection: rowDir(isRTL) }, isMe && { backgroundColor: colors.goldPale }]}>
        <Text style={[s.rank, { color: colors.inkSoft }]}>{item.rank <= 3 ? MEDAL[item.rank - 1] : localeNum(item.rank, language)}</Text>
        {flag ? <Text style={s.rowFlag}>{flag}</Text> : <View style={s.rowFlagPlaceholder} />}
        <Text style={[s.rowName, { color: colors.ink, textAlign: alignDir(isRTL) }, isMe && { fontFamily: 'PlexArabic-Bold', color: colors.goldDeep }]} numberOfLines={1}>{item.name ?? t('common.guestName')}</Text>
        {daysChipFor(item)}
        <Text style={[s.rowScore, { color: colors.ink, textAlign: isRTL ? 'left' : 'right' }, isMe && { color: colors.goldDeep }]}>{localeNum(item.score, language)}</Text>
      </View>
    );
  }

  // No 'bottom' edge: the tab bar reserves the bottom safe-area inset itself.
  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={[]}>
      <ScrollView style={s.scrollView} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Compact daily challenge strip */}
        {status === 'available' && (
          dailyDone ? (
            <View style={[s.dailyStrip, { backgroundColor: colors.correctPale, borderWidth: 1.5, borderColor: colors.correct, flexDirection: rowDir(isRTL) }]}>
              <Ionicons name="checkmark-circle" size={18} color={colors.correct} />
              <Text style={[s.dailyStripTxt, { color: colors.correct, textAlign: alignDir(isRTL) }]}>{t('league.dailyCompleted')}</Text>
            </View>
          ) : (
            <PressScale style={[s.dailyStrip, { backgroundColor: colors.card, flexDirection: rowDir(isRTL) }]} onPress={startDaily}>
              <Ionicons name="star" size={18} color={colors.gold} />
              <Text style={[s.dailyStripTxt, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('league.dailyReady')}</Text>
              <View style={[s.dailyStripBtn, { backgroundColor: colors.navy }]}>
                <Text style={s.dailyStripBtnTxt}>{t('league.dailyStart')}</Text>
              </View>
            </PressScale>
          )
        )}
        {status === 'loading' && (
          <View style={[s.dailyStrip, { backgroundColor: colors.card, flexDirection: rowDir(isRTL) }]}>
            <ActivityIndicator size="small" color={colors.ink} />
            <Text style={[s.dailyStripTxt, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('league.dailyChecking')}</Text>
          </View>
        )}
        {status === 'error' && (
          <PressScale style={[s.dailyStrip, { backgroundColor: colors.wrongPale, flexDirection: rowDir(isRTL) }]} onPress={checkDaily}>
            <Ionicons name="refresh" size={16} color={colors.wrong} />
            <Text style={[s.dailyStripTxt, { color: colors.wrong, textAlign: alignDir(isRTL) }]}>{t('league.dailyError')}</Text>
          </PressScale>
        )}

        {/* Your rank today — live, and shown even far outside the top 10 (the
            regular tabs below only ever carry a top-10 slice). Hidden until the
            user has a submission in today's live standings. */}
        {ownRank && (
          <View style={[s.card, { backgroundColor: colors.card }]}>
            <Text style={[s.cardTitle, { color: colors.ink, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
              {t('league.ownRank', { rank: localeNum(ownRank.rank, language) })}
            </Text>
            {ownRank.above.map((e) => renderNeighborRow(e, false))}
            {renderNeighborRow(ownRank.entry, true)}
            {ownRank.below.map((e) => renderNeighborRow(e, false))}
          </View>
        )}

        {/* Inner tab bar */}
        <View style={[s.tabBar, { backgroundColor: colors.goldPale, flexDirection: rowDir(isRTL) }]}>
          {(([ ['today', t('league.tabs.today')], ['yesterday', t('league.tabs.yesterday')], ['month', t('league.tabs.month')] ]) as [Tab, string][]).map(([key, label]) => (
            <PressScale
              key={key}
              style={[s.tabBtn, tab === key && { backgroundColor: colors.navy }]}
              onPress={() => setTab(key)}
            >
              <Text style={[s.tabBtnTxt, { color: colors.ink }, tab === key && { color: '#fff' }]}>{label}</Text>
            </PressScale>
          ))}
        </View>

        <View style={[s.card, { backgroundColor: colors.card }]}>
          <Text style={[s.cardTitle, { color: colors.ink, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
            {tab === 'today' ? t('league.cardTitles.today') : tab === 'yesterday' ? t('league.cardTitles.yesterday') : t('league.cardTitles.month')}
          </Text>
          {reportsLoading ? (
            <ActivityIndicator color={colors.ink} style={{ marginVertical: 16 }} />
          ) : listData.length === 0 ? (
            <View style={s.emptyWrap}>
              <Ionicons name="trophy-outline" size={30} color={colors.inkSoft} />
              <Text style={[s.emptyTitle, { color: colors.ink }]}>
                {t('league.emptyTitle', { timeframe: tab === 'month' ? t('league.timeframes.month') : t('league.timeframes.today') })}
              </Text>
              {/* Only daily-quiz scores feed the league, so the CTA starts
                  today's quiz whenever it's startable; a plain practice quiz
                  is the fallback (daily done, unpublished, or still loading). */}
              {status === 'available' && !dailyDone ? (
                <PressScale style={[s.emptyBtn, { backgroundColor: colors.gold }]} onPress={startDaily}>
                  <Text style={[s.emptyBtnTxt, { color: colors.navy }]}>{t('league.emptyBtnDaily')}</Text>
                </PressScale>
              ) : (
                <PressScale style={[s.emptyBtn, { backgroundColor: colors.gold }]} onPress={startDaily}>
                  <Text style={[s.emptyBtnTxt, { color: colors.navy }]}>{t('league.emptyBtnGeneric')}</Text>
                </PressScale>
              )}
            </View>
          ) : (
            <>
              {/* Top-3 podium — above the list */}
              {podium.length === 3 && (
                <View style={s.podium}>
                  {[1, 0, 2].map((i) => {
                    const e = podium[i];
                    const heights = [84, 64, 52]; // first, second, third
                    return (
                      <View key={i} style={s.podCol}>
                        <InitialAvatar name={e.name ?? '؟'} size={i === 0 ? 52 : 44} tint={PODIUM_TINTS[i]} colors={colors} />
                        <Text style={[s.podName, { color: colors.ink }]} numberOfLines={1}>{e.name ?? t('common.guestName')}</Text>
                        <Text style={[s.podScore, { color: colors.goldDeep }]}>{localeNum(e.score, language)}</Text>
                        <View style={[s.podBase, { height: heights[i], backgroundColor: PODIUM_TINTS[i] }]}>
                          <Text style={s.podBaseTxt}>{MEDAL[i]}</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
              {/* Plain rows, not a FlatList: a disabled nested list gets
                  touch-action:none on web, which blocked iOS Safari from
                  panning the page ScrollView for touches starting on it. */}
              {rest.map((item, index) => (
                <Fragment key={index}>
                  {index > 0 && <View style={[s.sep, { backgroundColor: colors.line }]} />}
                  {renderRow({ item, index })}
                </Fragment>
              ))}
              {/* Your own monthly standing when it falls below the top-10 —
                  the cumulative feed is unbounded, so the real rank is known. */}
              {monthOwnRank && monthOwnRank.rank > listData.length && (
                <>
                  <Text style={[s.moreDots, { color: colors.inkSoft }]}>⋯</Text>
                  {renderNeighborRow(monthOwnRank.entry, true)}
                </>
              )}
            </>
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  // flex:1 bounds the scroller to the viewport so the list scrolls when it
  // overflows (e.g. all 10 rows on a short phone); paddingBottom clears the tab bar.
  scrollView: { flex: 1 },
  scroll: { padding: 16, gap: 12, paddingBottom: 32 },

  dailyStrip: {
    borderRadius: radii.md,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    boxShadow: '0px 0px 4px rgba(0,0,0,0.06)',
    elevation: 2,
  },
  dailyStripTxt: { flex: 1, fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
  dailyStripBtn: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radii.sm },
  dailyStripBtnTxt: { color: '#fff', fontFamily: 'PlexArabic-Bold', fontSize: 13 },

  tabBar: { borderRadius: radii.md, padding: 3, gap: 3 },
  tabBtn: { flex: 1, paddingVertical: 9, borderRadius: radii.sm, alignItems: 'center' },
  tabBtnTxt: { fontSize: 13, fontFamily: 'PlexArabic-SemiBold' },

  card: {
    borderRadius: radii.md,
    overflow: 'hidden',
    boxShadow: '0px 0px 4px rgba(0,0,0,0.06)',
    elevation: 2,
  },
  cardTitle: {
    fontSize: 13,
    fontFamily: 'PlexArabic-Bold',
    padding: 14,
    borderBottomWidth: 1,
  },
  emptyWrap: { alignItems: 'center', gap: 10, padding: 28 },
  emptyTitle: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold', textAlign: 'center' },
  emptyBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: radii.pill, marginTop: 4 },
  emptyBtnTxt: { fontSize: 13, fontFamily: 'PlexArabic-Bold' },

  // Podium
  podium: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 10, paddingTop: 18, paddingHorizontal: 12 },
  podCol: { alignItems: 'center', width: 84 },
  podName: { fontSize: 12, fontFamily: 'PlexArabic-SemiBold', marginTop: 4, maxWidth: 80 },
  podScore: { fontSize: 12, fontFamily: 'PlexArabic-Bold', marginBottom: 6 },
  podBase: { width: 72, borderTopLeftRadius: radii.sm, borderTopRightRadius: radii.sm, alignItems: 'center', paddingTop: 4 },
  podBaseTxt: { fontSize: 16 },

  initAvatar: { alignItems: 'center', justifyContent: 'center' },
  initAvatarTxt: { fontFamily: 'PlexArabic-Bold' },

  center: { padding: 24, alignItems: 'center' },
  row: {
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  rank: { width: 26, fontSize: 13, fontFamily: 'PlexArabic-SemiBold', textAlign: 'center' },
  rowFlag: { fontSize: 18, width: 28, textAlign: 'center' },
  rowFlagPlaceholder: { width: 28 },
  rowName: { flex: 1, fontSize: 14 },
  daysChip: { alignItems: 'center', gap: 3 },
  daysChipTxt: { fontSize: 11, fontFamily: 'PlexArabic-SemiBold' },
  moreDots: { textAlign: 'center', fontSize: 16, lineHeight: 16, marginTop: 2 },
  delta: { fontSize: 11, fontFamily: 'PlexArabic-Bold' },
  rowScore: { fontSize: 15, fontFamily: 'PlexArabic-Bold', minWidth: 42 },
  sep: { height: 1, marginHorizontal: 14 },
});
