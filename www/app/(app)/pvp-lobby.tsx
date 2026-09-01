import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, mirror } from '../../src/theme/direction';
import PressScale from '../../src/components/PressScale';
import { Avatar } from '../../src/components/Avatar';
import { useProfileStore } from '../../src/stores/profileStore';
import { watchPvpInvite, declinePvpInvite, type PvpInviteEntry } from '../../src/services/firebase';

export default function PvpLobbyScreen() {
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  const { colors } = useTheme();
  const router = useRouter();
  const myUid = useProfileStore((s) => s.social.uid);

  const params = useLocalSearchParams<{
    recipientUid?: string;
    role?: string;
    opponentName?: string;
    opponentPhoto?: string;
  }>();

  const recipientUid = params.recipientUid;
  const opponentName = params.opponentName || t('common.guestName');
  const opponentPhoto = params.opponentPhoto;

  const handledRef = useRef(false);

  useEffect(() => {
    if (!recipientUid || !myUid) return;
    const unsub = watchPvpInvite(recipientUid, myUid, (invite: PvpInviteEntry | null) => {
      if (invite?.status === 'accepted' && invite.matchId && !handledRef.current) {
        handledRef.current = true;
        router.push({
          pathname: '/(app)/pvp',
          params: {
            matchId: invite.matchId,
            opponentUid: recipientUid,
            opponentName: opponentName ?? '',
            opponentPhoto: opponentPhoto ?? '',
            nonce: String(Date.now()),
          },
        });
      }
    });
    return unsub;
  }, [recipientUid, myUid, opponentName, opponentPhoto, router]);

  async function handleCancel() {
    if (recipientUid && myUid) {
      await declinePvpInvite(recipientUid, myUid);
    }
    router.back();
  }

  // No 'bottom' edge: the tab bar reserves the bottom safe-area inset itself.
  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['top']}>
      {/* Header */}
      <View style={[s.header, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
        <PressScale onPress={handleCancel} hitSlop={10} style={s.backBtn}>
          <Ionicons name={mirror(isRTL, 'chevron-back', 'chevron-forward')} size={22} color={colors.ink} />
        </PressScale>
        <Text style={[s.headerTitle, { color: colors.ink }]}>{t('pvpInvite.lobbyTitle')}</Text>
        <View style={{ width: 22 }} />
      </View>

      {/* Main Body */}
      <View style={s.body}>
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
          <Avatar
            uri={opponentPhoto}
            fallback={require('../../assets/images/app-icon.png')}
            style={s.avatar}
          />
          <Text style={[s.opponentName, { color: colors.ink }]}>{opponentName}</Text>
          <ActivityIndicator size="large" color={colors.gold} style={s.spinner} />
          <Text style={[s.waitingText, { color: colors.inkSoft }]}>
            {t('pvpInvite.waitingFor', { name: opponentName })}
          </Text>
        </View>

        <PressScale
          style={[s.cancelBtn, { backgroundColor: colors.wrongPale }]}
          onPress={handleCancel}
        >
          <Ionicons name="close-circle-outline" size={20} color={colors.wrong} />
          <Text style={[s.cancelBtnTxt, { color: colors.wrong }]}>{t('pvpInvite.cancel')}</Text>
        </PressScale>
      </View>
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
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'PlexArabic-Bold',
    textAlign: 'center',
  },
  body: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
  },
  card: {
    width: '100%',
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 28,
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  opponentName: {
    fontSize: 18,
    fontFamily: 'PlexArabic-Bold',
    marginTop: 4,
  },
  spinner: {
    marginVertical: 8,
  },
  waitingText: {
    fontSize: 14,
    fontFamily: 'PlexArabic-SemiBold',
    textAlign: 'center',
    lineHeight: 20,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: radii.pill,
  },
  cancelBtnTxt: {
    fontSize: 15,
    fontFamily: 'PlexArabic-Bold',
  },
});
