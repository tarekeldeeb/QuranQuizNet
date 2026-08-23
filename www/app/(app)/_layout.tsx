// Bottom-tab navigator — mirrors the side-menu in www/templates/menu.html
import { Tabs, useRouter, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Text, View, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  onAuthChange, fetchRemoteProfile, pushCurrentProfile, armPresence,
  watchIncomingPvpInvites, acceptPvpInvite, declinePvpInvite, createPvpMatch, type PvpInviteEntry,
} from '../../src/services/firebase';
import { setPendingDeepLink } from '../../src/services/pendingDeepLink';
import { hasPermission, registerPushToken } from '../../src/services/notifications';

import { syncUserAnalytics } from '../../src/services/analytics';
import {
  scopeFromParts, commonLevel, intersectScope, newMatchSeed, PVP_ROUNDS, type PvpMatchMeta,
} from '../../src/services/pvpService';
import { Avatar } from '../../src/components/Avatar';
import { useProfileStore } from '../../src/stores/profileStore';
import { DEFAULT_GUEST_NAME } from '../../src/models/constants';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radii } from '../../src/theme/tokens';
import { useDirection, rowDir } from '../../src/theme/direction';
import PressScale from '../../src/components/PressScale';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const appIcon = require('../../assets/images/app-icon.png');

function TabIcon({ name, color, size }: { name: IconName; color: string; size: number }) {
  return <Ionicons name={name} size={size} color={color} />;
}

// Compact brand mark — the default header for routes that don't set their own
// contextual title (hidden legacy screens). The three main tabs each replace
// this with something situational instead of repeating the app's name.
function HeaderLogo() {
  const router = useRouter();
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  return (
    <TouchableOpacity
      style={[s.headerLogo, { flexDirection: rowDir(isRTL) }]}
      onPress={() => router.navigate('/(app)/me')}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={t('common.homePage')}
    >
      <Image source={appIcon} style={s.headerIcon} />
      <Text style={s.headerTitle}>{t('common.appName')}</Text>
    </TouchableOpacity>
  );
}

// Raised gold "ابدأ" button — the one place in the app the gold accent is
// spent at full strength. Sits centered and elevated above the bar instead of
// sitting flush with its siblings, so Start reads as the game's architecture
// rather than a third menu item.
function PlayTabButton({
  onPress, accessibilityState, colors,
}: { onPress?: () => void; accessibilityState?: { selected?: boolean }; colors: ReturnType<typeof useTheme>['colors'] }) {
  const { t } = useTranslation();
  return (
    <PressScale
      onPress={onPress}
      style={s.playSlot}
      scaleTo={0.93}
      accessibilityRole="button"
      accessibilityLabel={t('common.start')}
      accessibilityState={accessibilityState}
    >
      <View style={[s.playCircle, { backgroundColor: colors.gold, borderColor: colors.card, shadowColor: colors.goldDeep }]}>
        <Ionicons name="play" size={24} color={colors.navy} style={{ marginRight: -2 }} />
      </View>
      <Text style={[s.playLabel, { color: colors.gold }]}>{t('common.start')}</Text>
    </PressScale>
  );
}

async function detectCountry(setCountry: (c: string) => void) {
  try {
    const res = await fetch(`https://ipinfo.io?token=${process.env.EXPO_PUBLIC_IPINFO_TOKEN ?? ''}`);
    const data = await res.json() as { country?: string };
    if (data.country) setCountry(data.country.toLowerCase());
  } catch { /* non-critical, silently ignore */ }
}

export default function AppLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const profile = useProfileStore();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isRTL } = useDirection();

  const userUid = profile.social.uid || profile.uid;
  useEffect(() => {
    if (userUid) {
      syncUserAnalytics({
        uid: userUid,
        level: profile.level,
        language: profile.language,
        isAnonymous: !!profile.social.isAnonymous,
        streak: profile.streak,
        tipIndex: profile.tipIndex,
      });
    }
  }, [userUid, profile.level, profile.language, profile.social.isAnonymous, profile.streak, profile.tipIndex]);

  useEffect(() => {
    detectCountry(profile.setCountry);
    const unsub = onAuthChange(async (user) => {
      if (!user) {
        // A deep link (e.g. an "add friend" link) landed here before the
        // visitor had signed in — remember it so (auth) can send them
        // straight back instead of dropping it on the floor.
        if (pathname && pathname !== '/') setPendingDeepLink(pathname);
        router.replace('/(auth)');
        return;
      }

      armPresence(user.uid);

      // Re-arm the Expo push token on every auth resolution (cold start, sign-in,
      // reinstall) whenever OS permission is already granted. This is what
      // actually keeps challenge/friend-request pushes reaching a closed app:
      // the one-shot ask in quiz.tsx only registers a token the moment
      // permission is first granted, so anyone who granted permission before
      // that registration call existed (or reinstalled, or got a rotated FCM
      // token) was stuck with no token in /pushTokens ever again. This does not
      // prompt — it only re-saves the token when permission already holds.
      hasPermission().then((granted) => {
        if (granted) registerPushToken(user.uid);
      }).catch(() => {});

      // Sync auth identity + remote profile immediately, regardless of active tab
      if (!user.isAnonymous) {
        await profile.setSocial({
          uid: user.uid,
          displayName: user.displayName ?? undefined,
          photoURL: user.photoURL ?? undefined,
          email: user.email ?? undefined,
          isAnonymous: false,
        });
        const remote = await fetchRemoteProfile(user.uid);
        if (remote) {
          await profile.syncTo(remote as Parameters<typeof profile.syncTo>[0]);
        }
        // Push local profile up (after sync so we write the merged result)
        await pushCurrentProfile();
      } else {
        // Preserve a guest's own custom nickname across re-auth events (e.g. app
        // restart) instead of stomping it back to the default every time — only
        // reset to the default if this is a different anonymous uid (fresh guest).
        const current = useProfileStore.getState().social;
        const displayName = current.uid === user.uid && current.displayName
          ? current.displayName
          : DEFAULT_GUEST_NAME;
        profile.setSocial({ uid: user.uid, displayName, isAnonymous: true });
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [pendingInvite, setPendingInvite] = useState<{ fromUid: string; invite: PvpInviteEntry } | null>(null);

  useEffect(() => {
    const uid = profile.social.uid;
    if (!uid) {
      setPendingInvite(null);
      return;
    }
    const unsub = watchIncomingPvpInvites(uid, (invites) => {
      const pending = Object.entries(invites).find(([_, inv]) => inv?.status === 'pending');
      if (pending) {
        setPendingInvite({ fromUid: pending[0], invite: pending[1] });
      } else {
        setPendingInvite(null);
      }
    });
    return unsub;
  }, [profile.social.uid]);

  async function handleAcceptInvite() {
    if (!pendingInvite || !profile.social.uid) return;
    const { fromUid, invite } = pendingInvite;
    setPendingInvite(null);

    const myUid = profile.social.uid;
    const level = commonLevel(profile.level, invite.level ?? 1);
    const scope = intersectScope(scopeFromParts(profile.parts), invite.scope ?? []);
    const seed = newMatchSeed();
    const meta: PvpMatchMeta = {
      seed,
      level,
      scope,
      rounds: PVP_ROUNDS,
      createdAt: Date.now(),
      creator: myUid,
    };
    const matchId = `${fromUid}_${myUid}_${Date.now()}`;

    await createPvpMatch(matchId, meta);
    await acceptPvpInvite(myUid, fromUid, matchId);

    router.push({
      pathname: '/(app)/pvp',
      params: {
        matchId,
        opponentUid: fromUid,
        opponentName: invite.fromName ?? '',
        opponentPhoto: invite.fromPhotoURL ?? '',
        nonce: String(Date.now()),
      },
    });
  }

  async function handleDeclineInvite() {
    if (!pendingInvite || !profile.social.uid) return;
    const { fromUid } = pendingInvite;
    setPendingInvite(null);
    await declinePvpInvite(profile.social.uid, fromUid);
  }

  const leagueTab = (
    <Tabs.Screen
      key="league"
      name="league"
      options={{
        tabBarIcon: ({ color, size, focused }) => <TabIcon name={focused ? 'trophy' : 'trophy-outline'} color={color} size={size} />,
        tabBarLabel: t('league.title'),
      }}
    />
  );
  const quizTab = (
    <Tabs.Screen
      key="quiz"
      name="quiz"
      options={{
        tabBarLabel: t('common.start'),
        tabBarButton: (props) => (
          <PlayTabButton
            onPress={props.onPress as (() => void) | undefined}
            accessibilityState={props.accessibilityState as { selected?: boolean } | undefined}
            colors={colors}
          />
        ),
      }}
    />
  );
  const meTab = (
    <Tabs.Screen
      key="me"
      name="me"
      options={{
        tabBarIcon: ({ color, size, focused }) => <TabIcon name={focused ? 'home' : 'home-outline'} color={color} size={size} />,
        tabBarLabel: t('common.home'),
      }}
    />
  );

  return (
    <>
      <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.navy },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
        headerTitle: () => <HeaderLogo />,
        tabBarActiveTintColor: colors.gold,
        tabBarInactiveTintColor: colors.inkSoft,
        // height/labelStyle tuned generously: the custom Arabic font's line
        // metrics run taller than a system font at the same size, and the
        // previous 60/11px combo was clipping the bottom of "الرئيسية" and
        // "البطولة" against the bar's fixed height.
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line, height: 66, paddingBottom: 8, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', lineHeight: 14 },
        tabBarShowLabel: true,
        headerTitleAlign: 'center',
      }}
    >
      {/* Tab declaration order determines visual LTR tab bar placement because
          bottom-tabs uses fixed flexDirection: 'row'. In RTL, [league, quiz, me]
          places 'me' (home) on the right as the landing tab. In LTR, [me, quiz, league]
          places 'me' (home) on the left. */}
      {isRTL ? [leagueTab, quizTab, meTab] : [meTab, quizTab, leagueTab]}
      {/* PvP match + the progression map — reached from the Me screen, not the tab bar */}
      <Tabs.Screen name="pvp"      options={{ href: null }} />
      <Tabs.Screen name="pvp-lobby" options={{ href: null, headerShown: false }} />
      {/* map.tsx renders its own in-page header (title + active-count badge) */}
      <Tabs.Screen name="map"      options={{ href: null, headerShown: false }} />
      {/* pvp-journey.tsx renders its own in-page header, same as map.tsx */}
      <Tabs.Screen name="pvp-journey" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="add/[code]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="friends"    options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="home"     options={{ href: null }} />
      <Tabs.Screen name="settings" options={{ href: null, headerShown: false }} />
    </Tabs>

    {pendingInvite && (
      <Modal
        visible={true}
        transparent
        animationType="fade"
        onRequestClose={handleDeclineInvite}
      >
        <View style={s.modalOverlay}>
          <View style={[s.modalCard, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <Avatar
              uri={pendingInvite.invite.fromPhotoURL}
              fallback={appIcon}
              style={s.modalAvatar}
            />
            <Text style={[s.modalTitle, { color: colors.ink }]}>
              {t('pvpInvite.bannerTitle')}
            </Text>
            <Text style={[s.modalMessage, { color: colors.inkSoft }]}>
              {t('pvpInvite.bannerMessage', { name: pendingInvite.invite.fromName || t('common.guestName') })}
            </Text>

            <View style={[s.modalActions, { flexDirection: rowDir(isRTL) }]}>
              <PressScale
                style={[s.modalBtn, { backgroundColor: colors.correct }]}
                onPress={handleAcceptInvite}
              >
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={s.modalBtnTxt}>{t('pvpInvite.accept')}</Text>
              </PressScale>
              <PressScale
                style={[s.modalBtn, { backgroundColor: colors.wrongPale }]}
                onPress={handleDeclineInvite}
              >
                <Ionicons name="close" size={18} color={colors.wrong} />
                <Text style={[s.modalBtnTxt, { color: colors.wrong }]}>{t('pvpInvite.decline')}</Text>
              </PressScale>
            </View>
          </View>
        </View>
      </Modal>
    )}
    </>
  );
}

const s = StyleSheet.create({
  headerLogo: {
    alignItems: 'center',
    gap: 8,
  },
  headerIcon: {
    width: 30,
    height: 30,
    borderRadius: 6,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 17,
    fontFamily: 'PlexArabic-Bold',
    letterSpacing: 0.3,
  },
  playSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 4,
  },
  playCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -28,
    borderWidth: 3,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  playLabel: {
    fontSize: 11,
    fontFamily: 'PlexArabic-Bold',
    marginTop: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  modalAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'PlexArabic-Bold',
  },
  modalMessage: {
    fontSize: 14,
    fontFamily: 'PlexArabic-Regular',
    textAlign: 'center',
  },
  modalActions: {
    gap: 12,
    marginTop: 8,
    width: '100%',
    justifyContent: 'center',
  },
  modalBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.pill,
  },
  modalBtnTxt: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'PlexArabic-Bold',
  },
});
