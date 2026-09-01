import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, Share, ActivityIndicator, Modal, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import {
  registerQuizCode, watchFriendRequests, watchFriends, acceptFriendRequest,
  declineFriendRequest, sendPvpInvite, watchPresence, watchPublicStats, removeFriend,
  type FriendRequestEntry, type FriendEntry, type PublicStats,
} from '../../src/services/firebase';
import { useProfileStore } from '../../src/stores/profileStore';
import { trackEvent } from '../../src/services/analytics';
import { DEFAULT_GUEST_NAME } from '../../src/models/constants';
import { decodePublicJuzMap, type PublicJuzMap } from '../../src/models/juzMap';
import { Avatar } from '../../src/components/Avatar';
import JuzMap from '../../src/components/JuzMap';
import { useTheme, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir, mirror } from '../../src/theme/direction';
import PressScale from '../../src/components/PressScale';
import type { Language } from '../../src/i18n/languages';

import { scopeFromParts } from '../../src/services/pvpService';

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${msg}`);
    return;
  }
  Alert.alert(title, msg);
}

interface LeaderboardItem {
  uid: string;
  name: string;
  photoURL?: string;
  score: number;
  streak: number;
  level: number;
  isSelf: boolean;
  friend?: FriendEntry;
}

function LeaderboardRow({
  rank,
  item,
  isRTL,
  colors,
  t,
  onChallenge,
  onSelect,
}: {
  rank: number;
  item: LeaderboardItem;
  isRTL: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  t: (key: string) => string;
  onChallenge: (uid: string, friend: FriendEntry) => void;
  onSelect: (item: LeaderboardItem) => void;
}) {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (item.isSelf) return;
    const unsub = watchPresence(item.uid, (presence) => {
      setOnline(!!presence?.online);
    });
    return unsub;
  }, [item.uid, item.isSelf]);

  return (
    <PressScale
      disabled={item.isSelf}
      onPress={() => onSelect(item)}
      style={[
        s.rowCard,
        {
          backgroundColor: item.isSelf ? colors.goldPale : colors.card,
          borderColor: item.isSelf ? colors.gold : colors.line,
          flexDirection: rowDir(isRTL),
        },
      ]}
    >
      <View style={[s.rankBadge, { backgroundColor: item.isSelf ? colors.gold : colors.paper }]}>
        <Text style={[s.rankText, { color: item.isSelf ? colors.navy : colors.inkSoft }]}>
          #{rank}
        </Text>
      </View>
      <View style={s.avatarContainer}>
        <Avatar
          uri={item.photoURL}
          fallback={require('../../assets/images/app-icon.png')}
          style={s.rowAvatar}
        />
        {!item.isSelf && online && (
          <View style={[s.onlineDot, { backgroundColor: colors.correct, borderColor: colors.card }]} />
        )}
      </View>
      <View style={[s.rowInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
        <View style={[s.nameRow, { flexDirection: rowDir(isRTL) }]}>
          <Text style={[s.rowName, { color: colors.ink, textAlign: alignDir(isRTL) }]} numberOfLines={1}>
            {item.name}
          </Text>
          {item.isSelf && (
            <View style={[s.youBadge, { backgroundColor: colors.gold }]}>
              <Text style={[s.youBadgeTxt, { color: colors.navy }]}>{t('daily.you')}</Text>
            </View>
          )}
        </View>
        <View style={[s.statsRow, { flexDirection: rowDir(isRTL) }]}>
          <View style={s.statItem}>
            <Ionicons name="trophy-outline" size={13} color={colors.goldDeep} />
            <Text style={[s.statTxt, { color: colors.ink }]}>{item.score.toLocaleString()}</Text>
          </View>
          <View style={s.statItem}>
            <Ionicons name="flame" size={13} color={colors.goldDeep} />
            <Text style={[s.statTxt, { color: colors.ink }]}>{item.streak}</Text>
          </View>
        </View>
      </View>
      <View style={[s.actionRow, { flexDirection: rowDir(isRTL) }]}>
        {!item.isSelf && item.friend && (
          <PressScale
            style={[s.actionBtn, { backgroundColor: colors.goldPale }]}
            onPress={(e) => {
              // Nested inside the row's own PressScale — on web a click bubbles
              // to the parent (unlike native's responder system, which never
              // hands the gesture to both), so without this the tap would both
              // send a challenge and open the map sheet.
              e.stopPropagation();
              onChallenge(item.uid, item.friend!);
            }}
          >
            <Ionicons name="flash-outline" size={16} color={colors.goldDeep} />
            <Text style={[s.actionTxt, { color: colors.goldDeep }]}>{t('friends.challenge')}</Text>
          </PressScale>
        )}
      </View>
    </PressScale>
  );
}

/** Opened by tapping a friend row: a read-only view of their 30-juz
 * progression map (JuzMap, same component as the me-screen mini map),
 * plus the option to end the friendship. */
function FriendMapSheet({
  visible,
  friend,
  juzMap,
  onClose,
  onRemove,
  removing,
  isRTL,
  lang,
  colors,
  t,
}: {
  visible: boolean;
  friend: LeaderboardItem | null;
  juzMap: PublicJuzMap | undefined;
  onClose: () => void;
  onRemove: () => void;
  removing: boolean;
  isRTL: boolean;
  lang: Language;
  colors: ReturnType<typeof useTheme>['colors'];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetBg}>
        <View style={[s.sheet, { backgroundColor: colors.card }]}>
          {friend && (
            <>
              <View style={[s.sheetHeaderRow, { flexDirection: rowDir(isRTL) }]}>
                <Avatar
                  uri={friend.photoURL}
                  fallback={require('../../assets/images/app-icon.png')}
                  style={s.sheetAvatar}
                />
                <Text style={[s.sheetName, { color: colors.ink, textAlign: alignDir(isRTL) }]} numberOfLines={1}>
                  {friend.name}
                </Text>
              </View>

              <View style={[s.mapPanel, { backgroundColor: colors.navy }]}>
                <View style={[s.mapPanelHead, { flexDirection: rowDir(isRTL) }]}>
                  <Ionicons name="map-outline" size={18} color={colors.gold} />
                  <Text style={s.mapPanelTitle}>{t('me.mapCard.title')}</Text>
                </View>
                {juzMap ? (
                  <JuzMap cells={decodePublicJuzMap(juzMap)} language={lang} isRTL={isRTL} />
                ) : (
                  <View style={s.mapEmptyBox}>
                    <Text style={[s.mapEmptyTxt, { color: colors.navySoft, textAlign: alignDir(isRTL) }]}>
                      {t('friends.friendMap.empty')}
                    </Text>
                  </View>
                )}
              </View>

              <PressScale
                style={[s.removeBtn, { backgroundColor: colors.wrongPale }]}
                onPress={onRemove}
                disabled={removing}
              >
                {removing ? (
                  <ActivityIndicator size="small" color={colors.wrong} />
                ) : (
                  <>
                    <Ionicons name="person-remove-outline" size={16} color={colors.wrong} />
                    <Text style={[s.removeBtnTxt, { color: colors.wrong }]}>{t('friends.removeFriend')}</Text>
                  </>
                )}
              </PressScale>
            </>
          )}

          <PressScale style={s.sheetCloseBtn} onPress={onClose} disabled={removing}>
            <Text style={[s.sheetCloseTxt, { color: colors.inkSoft }]}>{t('friends.friendMap.close')}</Text>
          </PressScale>
        </View>
      </View>
    </Modal>
  );
}

export default function FriendsScreen() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Language;
  const { isRTL } = useDirection();
  const { colors } = useTheme();
  const router = useRouter();
  const social = useProfileStore((s) => s.social);
  const parts = useProfileStore((s) => s.parts);
  const level = useProfileStore((s) => s.level);
  const streak = useProfileStore((s) => s.streak);
  const getScore = useProfileStore((s) => s.getScore);

  const [myCode, setMyCode] = useState<string | null>(null);
  const [inputCode, setInputCode] = useState('');
  const [requests, setRequests] = useState<Record<string, FriendRequestEntry>>({});
  const [friends, setFriends] = useState<Record<string, FriendEntry>>({});
  const [loadingCode, setLoadingCode] = useState(true);
  const [publicStatsMap, setPublicStatsMap] = useState<Record<string, PublicStats>>({});
  const [selectedFriend, setSelectedFriend] = useState<LeaderboardItem | null>(null);
  const [removingFriend, setRemovingFriend] = useState(false);

  useEffect(() => {
    if (!social.uid) return;
    let cancelled = false;
    setLoadingCode(true);
    registerQuizCode(social.uid)
      .then((code) => {
        if (!cancelled) {
          setMyCode(code);
          setLoadingCode(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingCode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [social.uid]);

  useEffect(() => {
    if (!social.uid) return;
    const unsubRequests = watchFriendRequests(social.uid, setRequests);
    const unsubFriends = watchFriends(social.uid, setFriends);
    return () => {
      unsubRequests();
      unsubFriends();
    };
  }, [social.uid]);

  useEffect(() => {
    if (!social.uid) return;
    const uids = Array.from(new Set([social.uid, ...Object.keys(friends)]));
    const unsubs: Array<() => void> = [];

    uids.forEach((uid) => {
      const unsub = watchPublicStats(uid, (stats) => {
        setPublicStatsMap((prev) => {
          if (!stats) {
            const next = { ...prev };
            delete next[uid];
            return next;
          }
          return { ...prev, [uid]: stats };
        });
      });
      unsubs.push(unsub);
    });

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [social.uid, friends]);

  async function handleShareCode() {
    if (!myCode) return;
    trackEvent('share_tap', { surface: 'add_friend' });
    const link = `https://quranquiz.net/add/${myCode}`;
    try {
      await Share.share({
        message: t('friends.shareMessage', { code: myCode, link }),
      });
    } catch { /* ignore */ }
  }

  function handleAddByCode() {
    const trimmed = inputCode.trim().toUpperCase();
    if (!trimmed) return;
    setInputCode('');
    router.push({ pathname: '/(app)/add/[code]', params: { code: trimmed } });
  }

  async function handleAccept(fromUid: string, req: FriendRequestEntry) {
    if (!social.uid) return;
    const myName = social.displayName || DEFAULT_GUEST_NAME;
    await acceptFriendRequest(fromUid, social.uid, myName, social.photoURL, req.fromName, req.fromPhotoURL);
  }

  async function handleDecline(fromUid: string) {
    if (!social.uid) return;
    await declineFriendRequest(fromUid, social.uid);
  }

  async function handleChallenge(friendUid: string, friend: FriendEntry) {
    if (!social.uid) return;
    const scope = scopeFromParts(parts);
    const myName = social.displayName || DEFAULT_GUEST_NAME;
    await sendPvpInvite(friendUid, social.uid, myName, social.photoURL, level, scope);
    router.push({
      pathname: '/(app)/pvp-lobby',
      params: {
        recipientUid: friendUid,
        role: 'challenger',
        opponentName: friend.name ?? '',
        opponentPhoto: friend.photoURL ?? '',
      },
    });
  }

  function handleRemoveFriend() {
    if (!social.uid || !selectedFriend) return;
    const targetUid = selectedFriend.uid;
    const title = t('friends.removeConfirmTitle', { name: selectedFriend.name });
    const msg = t('friends.removeConfirmBody');
    const doRemove = async () => {
      setRemovingFriend(true);
      const ok = await removeFriend(social.uid!, targetUid);
      setRemovingFriend(false);
      if (ok) {
        setSelectedFriend(null);
      } else {
        notify(t('friends.removeFriend'), t('friends.removeFailed'));
      }
    };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`)) void doRemove();
      return;
    }
    Alert.alert(title, msg, [
      { text: t('settings.no'), style: 'cancel' },
      { text: t('settings.yes'), style: 'destructive', onPress: () => void doRemove() },
    ]);
  }

  const requestEntries = Object.entries(requests);
  const friendEntries = Object.entries(friends);
  const ownScore = getScore();

  const leaderboardItems: LeaderboardItem[] = [];

  if (social.uid) {
    const selfStats = publicStatsMap[social.uid];
    leaderboardItems.push({
      uid: social.uid,
      name: selfStats?.name || social.displayName || t('common.guestName'),
      photoURL: social.photoURL,
      score: selfStats?.score ?? ownScore,
      streak: selfStats?.streak ?? streak,
      level: selfStats?.level ?? level,
      isSelf: true,
    });
  }

  for (const [friendUid, friend] of Object.entries(friends)) {
    const fStats = publicStatsMap[friendUid];
    leaderboardItems.push({
      uid: friendUid,
      name: friend.name || fStats?.name || t('common.guestName'),
      photoURL: friend.photoURL,
      score: fStats?.score ?? 0,
      streak: fStats?.streak ?? 0,
      level: fStats?.level ?? 0,
      isSelf: false,
      friend,
    });
  }

  leaderboardItems.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.streak - a.streak;
  });

  // No 'bottom' edge: the tab bar reserves the bottom safe-area inset itself.
  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['top']}>
      {/* In-page Header */}
      <View style={[s.header, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
        <PressScale onPress={() => router.back()} hitSlop={10} style={s.backBtn}>
          <Ionicons name={mirror(isRTL, 'chevron-back', 'chevron-forward')} size={22} color={colors.ink} />
        </PressScale>
        <Text style={[s.title, { color: colors.ink }]}>{t('friends.title')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* ── My Quiz Code Card ── */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
          <View style={[s.cardHeaderRow, { flexDirection: rowDir(isRTL) }]}>
            <Ionicons name="qr-code-outline" size={20} color={colors.goldDeep} />
            <Text style={[s.cardTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
              {t('friends.myCodeTitle')}
            </Text>
          </View>
          <Text style={[s.cardSubtitle, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
            {t('friends.myCodeSubtitle')}
          </Text>
          <View style={[s.codeBox, { backgroundColor: colors.goldPale, borderColor: colors.gold }]}>
            {loadingCode ? (
              <ActivityIndicator size="small" color={colors.goldDeep} />
            ) : (
              <Text style={[s.codeText, { color: colors.navy }]}>{myCode ?? '--------'}</Text>
            )}
          </View>
          <PressScale
            style={[s.shareBtn, { backgroundColor: colors.gold }]}
            onPress={handleShareCode}
            disabled={!myCode}
          >
            <Ionicons name="share-social-outline" size={18} color={colors.navy} />
            <Text style={[s.shareBtnTxt, { color: colors.navy }]}>{t('friends.shareBtn')}</Text>
          </PressScale>
        </View>

        {/* ── Enter Code Section ── */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
          <Text style={[s.cardTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
            {t('friends.addFriendTitle')}
          </Text>
          <View style={[s.inputRow, { flexDirection: rowDir(isRTL) }]}>
            <TextInput
              style={[s.input, { borderColor: colors.line, color: colors.ink, backgroundColor: colors.paper }]}
              placeholder={t('friends.placeholderCode')}
              placeholderTextColor={colors.inkSoft}
              value={inputCode}
              onChangeText={setInputCode}
              autoCapitalize="characters"
              maxLength={12}
            />
            <PressScale
              style={[s.addBtn, { backgroundColor: colors.navy }, !inputCode.trim() && { opacity: 0.5 }]}
              onPress={handleAddByCode}
              disabled={!inputCode.trim()}
            >
              <Text style={s.addBtnTxt}>{t('friends.addBtn')}</Text>
            </PressScale>
          </View>
        </View>

        {/* ── Incoming Friend Requests ── */}
        <View style={s.sectionHeader}>
          <Text style={[s.sectionTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
            {t('friends.incomingRequests')} ({requestEntries.length})
          </Text>
        </View>

        {requestEntries.length === 0 ? (
          <View style={[s.emptyBox, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <Ionicons name="mail-unread-outline" size={24} color={colors.inkSoft} />
            <Text style={[s.emptyText, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
              {t('friends.noRequests')}
            </Text>
          </View>
        ) : (
          requestEntries.map(([fromUid, req]) => (
            <View
              key={fromUid}
              style={[s.rowCard, { backgroundColor: colors.card, borderColor: colors.line, flexDirection: rowDir(isRTL) }]}
            >
              <Avatar
                uri={req.fromPhotoURL}
                fallback={require('../../assets/images/app-icon.png')}
                style={s.rowAvatar}
              />
              <View style={[s.rowInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                <Text style={[s.rowName, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
                  {req.fromName || t('common.guestName')}
                </Text>
              </View>
              <View style={[s.actionRow, { flexDirection: rowDir(isRTL) }]}>
                <PressScale
                  style={[s.actionBtn, { backgroundColor: colors.correctPale }]}
                  onPress={() => handleAccept(fromUid, req)}
                >
                  <Ionicons name="checkmark" size={16} color={colors.correct} />
                  <Text style={[s.actionTxt, { color: colors.correct }]}>{t('friends.accept')}</Text>
                </PressScale>
                <PressScale
                  style={[s.actionBtn, { backgroundColor: colors.wrongPale }]}
                  onPress={() => handleDecline(fromUid)}
                >
                  <Ionicons name="close" size={16} color={colors.wrong} />
                  <Text style={[s.actionTxt, { color: colors.wrong }]}>{t('friends.decline')}</Text>
                </PressScale>
              </View>
            </View>
          ))
        )}

        {/* ── Friends Leaderboard ── */}
        <View style={s.sectionHeader}>
          <Text style={[s.sectionTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
            {t('friends.friendList')} ({leaderboardItems.length})
          </Text>
        </View>

        {friendEntries.length === 0 && (
          <View style={[s.emptyBox, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <Ionicons name="people-outline" size={24} color={colors.inkSoft} />
            <Text style={[s.emptyText, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
              {t('friends.noFriends')}
            </Text>
          </View>
        )}

        {leaderboardItems.map((item, idx) => (
          <LeaderboardRow
            key={item.uid}
            rank={idx + 1}
            item={item}
            isRTL={isRTL}
            colors={colors}
            t={t}
            onChallenge={handleChallenge}
            onSelect={setSelectedFriend}
          />
        ))}

      </ScrollView>

      <FriendMapSheet
        visible={!!selectedFriend}
        friend={selectedFriend}
        juzMap={selectedFriend ? publicStatsMap[selectedFriend.uid]?.juzMap : undefined}
        onClose={() => setSelectedFriend(null)}
        onRemove={handleRemoveFriend}
        removing={removingFriend}
        isRTL={isRTL}
        lang={lang}
        colors={colors}
        t={t}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    alignItems: 'center',
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 2 },
  title: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'PlexArabic-Bold',
    textAlign: 'center',
  },
  scroll: {
    padding: 14,
    gap: 12,
    paddingBottom: 36,
  },
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  cardHeaderRow: {
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: 'PlexArabic-Bold',
  },
  cardSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: -4,
  },
  codeBox: {
    paddingVertical: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeText: {
    fontSize: 22,
    fontFamily: 'PlexArabic-Bold',
    letterSpacing: 3,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: radii.pill,
  },
  shareBtnTxt: {
    fontSize: 14,
    fontFamily: 'PlexArabic-Bold',
  },
  inputRow: {
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    fontSize: 14,
    fontFamily: 'PlexArabic-SemiBold',
  },
  addBtn: {
    paddingHorizontal: 18,
    height: 44,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnTxt: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'PlexArabic-Bold',
  },
  sectionHeader: {
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'PlexArabic-Bold',
  },
  emptyBox: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 18,
  },
  rowCard: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 12,
    alignItems: 'center',
    gap: 10,
  },
  rankBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: {
    fontSize: 12,
    fontFamily: 'PlexArabic-Bold',
  },
  avatarContainer: {
    position: 'relative',
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  rowAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  rowInfo: {
    flex: 1,
  },
  nameRow: {
    alignItems: 'center',
    gap: 6,
  },
  rowName: {
    fontSize: 14.5,
    fontFamily: 'PlexArabic-SemiBold',
  },
  youBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.pill,
  },
  youBadgeTxt: {
    fontSize: 10,
    fontFamily: 'PlexArabic-Bold',
  },
  statsRow: {
    alignItems: 'center',
    gap: 10,
    marginTop: 2,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  statTxt: {
    fontSize: 12,
    fontFamily: 'PlexArabic-SemiBold',
  },
  actionRow: {
    gap: 6,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  actionTxt: {
    fontSize: 12,
    fontFamily: 'PlexArabic-Bold',
  },

  // Friend map sheet
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.lg + 4, borderTopRightRadius: radii.lg + 4,
    padding: 20, paddingBottom: 32, gap: 14,
    width: '100%', maxWidth: 512, alignSelf: 'center',
  },
  sheetHeaderRow: { alignItems: 'center', gap: 10 },
  sheetAvatar: { width: 44, height: 44, borderRadius: 22 },
  sheetName: { flex: 1, fontSize: 17, fontFamily: 'PlexArabic-Bold' },
  mapPanel: { borderRadius: radii.lg, padding: 16, gap: 12 },
  mapPanelHead: { alignItems: 'center', gap: 8 },
  mapPanelTitle: { fontSize: 14, fontFamily: 'Amiri-Regular', fontWeight: '700', color: '#fff' },
  mapEmptyBox: { paddingVertical: 18, alignItems: 'center' },
  mapEmptyTxt: { fontSize: 13, lineHeight: 18 },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 12, borderRadius: radii.md,
  },
  removeBtnTxt: { fontSize: 14, fontFamily: 'PlexArabic-Bold' },
  sheetCloseBtn: { alignItems: 'center', paddingVertical: 8 },
  sheetCloseTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
});
