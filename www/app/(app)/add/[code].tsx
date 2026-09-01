import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { resolveQuizCode, sendFriendRequest } from '../../../src/services/firebase';
import { useProfileStore } from '../../../src/stores/profileStore';
import { trackEvent } from '../../../src/services/analytics';
import { DEFAULT_GUEST_NAME } from '../../../src/models/constants';
import { useTheme, radii } from '../../../src/theme/tokens';
import { useDirection, rowDir, alignDir, mirror } from '../../../src/theme/direction';
import PressScale from '../../../src/components/PressScale';

type Status = 'loading' | 'invalid' | 'self' | 'sending' | 'sent' | 'error';

export default function AddByCodeScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  const { colors } = useTheme();
  const router = useRouter();
  const social = useProfileStore((s) => s.social);

  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let cancelled = false;
    async function processCode() {
      const cleanCode = (code ?? '').trim().toUpperCase();
      if (!cleanCode) {
        if (!cancelled) setStatus('invalid');
        return;
      }

      setStatus('loading');
      const targetUid = await resolveQuizCode(cleanCode);
      if (cancelled) return;

      trackEvent('invite_link_open', { code: cleanCode, valid: !!targetUid });

      if (!targetUid) {
        setStatus('invalid');
        return;
      }

      if (targetUid === social.uid) {
        setStatus('self');
        return;
      }

      if (!social.uid) {
        setStatus('error');
        return;
      }

      setStatus('sending');
      const fromName = social.displayName || DEFAULT_GUEST_NAME;
      const ok = await sendFriendRequest(targetUid, social.uid, fromName, social.photoURL);
      if (cancelled) return;

      if (ok) {
        setStatus('sent');
      } else {
        setStatus('error');
      }
    }

    processCode();
    return () => {
      cancelled = true;
    };
  }, [code, social.uid, social.displayName, social.photoURL]);

  // No 'bottom' edge: the tab bar reserves the bottom safe-area inset itself.
  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['top']}>
      {/* Header */}
      <View style={[s.header, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
        <PressScale onPress={() => router.back()} hitSlop={10} style={s.backBtn}>
          <Ionicons name={mirror(isRTL, 'chevron-back', 'chevron-forward')} size={22} color={colors.ink} />
        </PressScale>
        <Text style={[s.title, { color: colors.ink }]}>{t('friends.addFriendTitle')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={s.content}>
        {status === 'loading' || status === 'sending' ? (
          <View style={s.centerCard}>
            <ActivityIndicator size="large" color={colors.gold} />
            <Text style={[s.statusText, { color: colors.inkSoft }]}>
              {status === 'loading' ? t('friends.resolving') : t('friends.sending')}
            </Text>
          </View>
        ) : status === 'invalid' ? (
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <View style={[s.iconCircle, { backgroundColor: colors.wrongPale }]}>
              <Ionicons name="alert-circle" size={32} color={colors.wrong} />
            </View>
            <Text style={[s.cardTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
              {t('friends.invalidCode')}
            </Text>
            <Text style={[s.cardSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
              {t('friends.invalidCodeSub')}
            </Text>
            <PressScale style={[s.btn, { backgroundColor: colors.navy }]} onPress={() => router.back()}>
              <Text style={s.btnTxt}>{t('friends.back')}</Text>
            </PressScale>
          </View>
        ) : status === 'self' ? (
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <View style={[s.iconCircle, { backgroundColor: colors.goldPale }]}>
              <Ionicons name="person" size={32} color={colors.goldDeep} />
            </View>
            <Text style={[s.cardTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
              {t('friends.selfCode')}
            </Text>
            <Text style={[s.cardSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
              {t('friends.selfCodeSub')}
            </Text>
            <PressScale style={[s.btn, { backgroundColor: colors.navy }]} onPress={() => router.back()}>
              <Text style={s.btnTxt}>{t('friends.back')}</Text>
            </PressScale>
          </View>
        ) : status === 'sent' ? (
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <View style={[s.iconCircle, { backgroundColor: colors.correctPale }]}>
              <Ionicons name="checkmark-circle" size={36} color={colors.correct} />
            </View>
            <Text style={[s.cardTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
              {t('friends.requestSent')}
            </Text>
            <Text style={[s.cardSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
              {t('friends.requestSentSub')}
            </Text>
            <PressScale
              style={[s.btn, { backgroundColor: colors.gold }]}
              onPress={() => router.replace('/(app)/friends')}
            >
              <Text style={[s.btnTxt, { color: colors.navy }]}>{t('friends.goToFriends')}</Text>
            </PressScale>
          </View>
        ) : (
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.line }]}>
            <View style={[s.iconCircle, { backgroundColor: colors.wrongPale }]}>
              <Ionicons name="cloud-offline" size={32} color={colors.wrong} />
            </View>
            <Text style={[s.cardTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
              {t('friends.errorOccurred')}
            </Text>
            <PressScale style={[s.btn, { backgroundColor: colors.navy }]} onPress={() => router.back()}>
              <Text style={s.btnTxt}>{t('friends.back')}</Text>
            </PressScale>
          </View>
        )}
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
  title: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'PlexArabic-Bold',
    textAlign: 'center',
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerCard: {
    alignItems: 'center',
    gap: 12,
  },
  statusText: {
    fontSize: 14,
    fontFamily: 'PlexArabic-SemiBold',
  },
  card: {
    width: '100%',
    maxWidth: 340,
    padding: 24,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    gap: 12,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 17,
    fontFamily: 'PlexArabic-Bold',
  },
  cardSub: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  btn: {
    marginTop: 8,
    width: '100%',
    paddingVertical: 12,
    borderRadius: radii.pill,
    alignItems: 'center',
  },
  btnTxt: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'PlexArabic-Bold',
  },
});
