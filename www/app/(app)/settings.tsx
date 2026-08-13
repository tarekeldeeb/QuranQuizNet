// Settings screen — level, special questions, version, sign-out. Reached from
// Home via the gear icon in the header (see (app)/me.tsx) instead of living
// inline on Home, which used to do five jobs at once.
import { useEffect, useState } from 'react';
import { View, Text, Switch, Alert, Modal, ActivityIndicator, StyleSheet, ScrollView, Platform, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { useProfileStore } from '../../src/stores/profileStore';
import {
  signOut, deleteAccount, watchNotifPrefs, setNotifPref, pushCurrentProfile, type NotifCategory, type NotifPrefs,
} from '../../src/services/firebase';
import { useTheme, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir } from '../../src/theme/direction';
import PressScale from '../../src/components/PressScale';
import ThemeToggle from '../../src/components/ThemeToggle';
import LanguagePicker from '../../src/components/LanguagePicker';
import { APP_STORE_URL, PLAY_STORE_URL } from '../../src/models/storeLinks';

const APP_VERSION = Constants.expoConfig?.version ?? '';

// Native app store links, shown on web only (no point advertising the app to
// someone already inside it).
const STORE_LINKS = [
  {
    key: 'ios',
    icon: 'logo-apple' as const,
    name: 'App Store',
    hintKey: 'settings.storeLinks.iosHint',
    url: APP_STORE_URL,
  },
  {
    key: 'android',
    icon: 'logo-google-playstore' as const,
    name: 'Google Play',
    hintKey: 'settings.storeLinks.androidHint',
    url: PLAY_STORE_URL,
  },
];

// Store URL for rating the app, per platform — iOS opens straight into the
// write-review flow; Android has no such deep link, so it lands on the
// listing page where the rating prompt sits at the top.
const RATE_APP_URL = Platform.select({
  ios: 'itms-apps://apps.apple.com/app/id6790435986?action=write-review',
  android: 'market://details?id=net.quranquiz',
  default: '',
});

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${msg}`);
    return;
  }
  Alert.alert(title, msg);
}

/** Delete-account confirmation — a full sheet, not a one-line Alert, since
 * this is the one truly irreversible action in the app. */
function DeleteAccountSheet({
  visible, onClose, onConfirm, deleting, colors,
}: {
  visible: boolean; onClose: () => void; onConfirm: () => void; deleting: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetBg}>
        <View style={[s.sheet, { backgroundColor: colors.card }]}>
          <View style={[s.sheetIconRing, { backgroundColor: colors.wrongPale }]}>
            <Ionicons name="warning" size={28} color={colors.wrong} />
          </View>
          <Text style={[s.sheetTitle, { color: colors.ink }]}>{t('settings.deleteSheetTitle')}</Text>
          <Text style={[s.sheetBody, { color: colors.inkSoft }]}>
            {t('settings.deleteSheetBody')}
          </Text>
          <PressScale
            style={[s.deleteConfirmBtn, { backgroundColor: colors.wrong }, deleting && { opacity: 0.6 }]}
            onPress={onConfirm}
            disabled={deleting}
          >
            {deleting
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={s.deleteConfirmTxt}>{t('settings.deleteSheetConfirm')}</Text>}
          </PressScale>
          <PressScale style={s.deleteCancelBtn} onPress={onClose} disabled={deleting}>
            <Text style={[s.deleteCancelTxt, { color: colors.inkSoft }]}>{t('settings.cancel')}</Text>
          </PressScale>
        </View>
      </View>
    </Modal>
  );
}

export default function SettingsScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  const router = useRouter();
  const profile = useProfileStore();
  const social = profile.social;
  const [signingOut, setSigningOut] = useState(false);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({
    invites: true,
    friendRequests: true,
    streakAlerts: true,
    dailyReady: true,
    friendActivity: true,
  });

  useEffect(() => {
    if (!social.uid) return;
    const unsub = watchNotifPrefs(social.uid, setNotifPrefs);
    return unsub;
  }, [social.uid]);

  function handleToggleNotifPref(category: NotifCategory, value: boolean) {
    setNotifPrefs((prev) => ({ ...prev, [category]: value }));
    if (social.uid) {
      setNotifPref(social.uid, category, value);
    }
  }

  function handleThemeChange(mode: Parameters<typeof profile.setThemeMode>[0]) {
    profile.setThemeMode(mode);
    void pushCurrentProfile();
  }

  function handleLanguageChange(lang: Parameters<typeof profile.setLanguage>[0]) {
    profile.setLanguage(lang);
    void pushCurrentProfile();
  }

  function handleRateApp() {
    if (!RATE_APP_URL) return;
    const fallback = Platform.OS === 'android' ? PLAY_STORE_URL : APP_STORE_URL;
    Linking.openURL(RATE_APP_URL).catch(() => Linking.openURL(fallback));
  }

  const SPECIAL_MIN_LEVEL = 2;
  const specialEditable = profile.level >= SPECIAL_MIN_LEVEL;

  function setLevel(value: number) {
    const patch: { level: number; specialEnabled?: boolean } = { level: value };
    if (value < SPECIAL_MIN_LEVEL) patch.specialEnabled = false;
    useProfileStore.setState(patch);
    profile.saveSettings();
  }

  function toggleSpecial(v: boolean) {
    if (!specialEditable) return;
    useProfileStore.setState({ specialEnabled: v });
    profile.saveSettings();
  }

  async function performSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch (e) {
      console.error(e);
    }
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

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['bottom']}>
      <ScrollView style={s.scrollView} contentContainerStyle={s.scroll}>
        {/* Appearance */}
        <View style={[s.section, { backgroundColor: colors.card }]}>
          <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
            {t('settings.appearanceHeader')}
          </Text>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL) }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.themeLabel')}</Text>
              <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.themeHint')}</Text>
            </View>
            <ThemeToggle value={profile.themeMode} onChange={handleThemeChange} />
          </View>
        </View>

        {/* Language */}
        <View style={[s.section, { backgroundColor: colors.card, overflow: 'visible', zIndex: 10 }]}>
          <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
            {t('settings.languageHeader')}
          </Text>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL) }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.languageLabel')}</Text>
            </View>
            <LanguagePicker value={profile.language} onChange={handleLanguageChange} />
          </View>
        </View>

        {/* Level selector */}
        <View style={[s.section, { backgroundColor: colors.card }]}>
          <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
            {t('settings.levelHeader', { level: profile.levels[profile.level] ? t(profile.levels[profile.level].text) : '' })}
          </Text>
          {profile.levels.map((lvl) => (
            <PressScale
              key={lvl.value}
              style={[s.levelRow, { borderColor: colors.line }, lvl.disabled && s.disabled]}
              onPress={() => !lvl.disabled && setLevel(lvl.value)}
              disabled={lvl.disabled}
            >
              <View style={s.levelLeft}>
                <View style={[s.radio, { borderColor: colors.ink }]}>
                  {profile.level === lvl.value && <View style={[s.radioDot, { backgroundColor: colors.gold }]} />}
                </View>
              </View>
              <View style={[s.levelRight, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                <Text style={[s.levelName, { color: colors.ink, textAlign: alignDir(isRTL) }, lvl.disabled && { color: colors.inkSoft }]}>{t(lvl.text)}</Text>
                <Text style={[s.levelComment, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t(lvl.comment)}</Text>
              </View>
            </PressScale>
          ))}
        </View>

        {/* Special questions toggle */}
        <View style={[s.section, { backgroundColor: colors.card }]}>
          <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
            {t('settings.specialHeader')}
          </Text>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL) }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.specialLabel')}</Text>
              {!specialEditable && (
                <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.specialHint')}</Text>
              )}
            </View>
            <Switch
              value={specialEditable && profile.specialEnabled}
              onValueChange={toggleSpecial}
              disabled={!specialEditable}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Notification preferences */}
        <View style={[s.section, { backgroundColor: colors.card }]}>
          <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
            {t('settings.notifPrefs.header')}
          </Text>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL) }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.invitesLabel')}</Text>
              <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.invitesHint')}</Text>
            </View>
            <Switch
              value={notifPrefs.invites}
              onValueChange={(v) => handleToggleNotifPref('invites', v)}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
            />
          </View>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL), borderTopWidth: 1, borderTopColor: colors.line }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.friendRequestsLabel')}</Text>
              <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.friendRequestsHint')}</Text>
            </View>
            <Switch
              value={notifPrefs.friendRequests}
              onValueChange={(v) => handleToggleNotifPref('friendRequests', v)}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
            />
          </View>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL), borderTopWidth: 1, borderTopColor: colors.line }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.streakAlertsLabel')}</Text>
              <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.streakAlertsHint')}</Text>
            </View>
            <Switch
              value={notifPrefs.streakAlerts}
              onValueChange={(v) => handleToggleNotifPref('streakAlerts', v)}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
            />
          </View>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL), borderTopWidth: 1, borderTopColor: colors.line }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.dailyReadyLabel')}</Text>
              <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.dailyReadyHint')}</Text>
            </View>
            <Switch
              value={notifPrefs.dailyReady}
              onValueChange={(v) => handleToggleNotifPref('dailyReady', v)}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
            />
          </View>
          <View style={[s.toggleRow, { flexDirection: rowDir(isRTL), borderTopWidth: 1, borderTopColor: colors.line }]}>
            <View style={[s.toggleInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
              <Text style={[s.toggleLabel, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.friendActivityLabel')}</Text>
              <Text style={[s.toggleHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.notifPrefs.friendActivityHint')}</Text>
            </View>
            <Switch
              value={notifPrefs.friendActivity}
              onValueChange={(v) => handleToggleNotifPref('friendActivity', v)}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Rate the app — native only */}
        {Platform.OS !== 'web' && (
          <View style={[s.section, { backgroundColor: colors.card }]}>
            <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
              {t('settings.rateAppHeader')}
            </Text>
            <PressScale
              style={[s.storeRow, { borderColor: colors.line, flexDirection: rowDir(isRTL), borderBottomWidth: 0 }]}
              onPress={handleRateApp}
            >
              <Ionicons name="star" size={22} color={colors.gold} />
              <View style={[s.storeInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                <Text style={[s.storeName, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
                  {t(Platform.OS === 'ios' ? 'settings.rateAppLabelIos' : 'settings.rateAppLabelAndroid')}
                </Text>
                <Text style={[s.storeHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t('settings.rateAppHint')}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color={colors.inkSoft} />
            </PressScale>
          </View>
        )}

        {/* Native app store links — web only */}
        {Platform.OS === 'web' && (
          <View style={[s.section, { backgroundColor: colors.card }]}>
            <Text style={[s.sectionHeader, { color: colors.ink, backgroundColor: colors.paper, borderColor: colors.line, textAlign: alignDir(isRTL) }]}>
              {t('settings.mobileAppHeader')}
            </Text>
            {STORE_LINKS.map((store) => (
              <PressScale
                key={store.key}
                style={[s.storeRow, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}
                onPress={() => Linking.openURL(store.url)}
              >
                <Ionicons name={store.icon} size={22} color={colors.ink} />
                <View style={[s.storeInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                  <Text style={[s.storeName, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{store.name}</Text>
                  <Text style={[s.storeHint, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{t(store.hintKey)}</Text>
                </View>
                <Ionicons name="open-outline" size={16} color={colors.inkSoft} />
              </PressScale>
            ))}
          </View>
        )}

        {/* Account */}
        {!social.isAnonymous && social.uid && (
          <PressScale
            style={[s.section, s.signOutRow, { backgroundColor: colors.card, flexDirection: rowDir(isRTL) }]}
            onPress={handleSignOut}
            disabled={signingOut}
          >
            <Ionicons name="log-out-outline" size={18} color={colors.wrong} />
            <Text style={[s.signOutTxt, { color: colors.wrong }]}>{t('settings.signOut')}</Text>
          </PressScale>
        )}

        {/* Deliberately small and unboxed — a quiet, deniable-by-accident
            link rather than a card matching sign-out's prominence. */}
        <PressScale
          style={[s.deleteLink, { flexDirection: rowDir(isRTL) }]}
          onPress={() => setDeleteSheetOpen(true)}
          disabled={signingOut || deletingAccount}
        >
          <Ionicons name="trash-outline" size={13} color={colors.wrong} />
          <Text style={[s.deleteLinkTxt, { color: colors.wrong }]}>{t('settings.deleteAccountLink')}</Text>
        </PressScale>

        <Text style={[s.version, { color: colors.inkSoft }]}>{t('settings.version', { version: APP_VERSION })}</Text>
      </ScrollView>

      <DeleteAccountSheet
        visible={deleteSheetOpen}
        onClose={() => setDeleteSheetOpen(false)}
        onConfirm={performDeleteAccount}
        deleting={deletingAccount}
        colors={colors}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  scroll: { padding: 16, gap: 16, paddingBottom: 32 },
  section: {
    borderRadius: radii.md, overflow: 'hidden',
    boxShadow: '0px 0px 4px rgba(0,0,0,0.05)', elevation: 2,
  },
  sectionHeader: {
    fontSize: 14, fontFamily: 'PlexArabic-Bold',
    padding: 14, borderBottomWidth: 1,
  },
  levelRow: { flexDirection: 'row', alignItems: 'flex-start', padding: 14, gap: 12, borderBottomWidth: 1 },
  disabled: { opacity: 0.5 },
  levelLeft: { paddingTop: 2 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  levelRight: { flex: 1 },
  levelName: { fontSize: 15, fontFamily: 'PlexArabic-SemiBold' },
  levelComment: { fontSize: 12, marginTop: 2 },
  toggleRow: { alignItems: 'center', padding: 14, gap: 12 },
  toggleInfo: { flex: 1 },
  toggleLabel: { fontSize: 14 },
  toggleHint: { fontSize: 11, marginTop: 2 },
  storeRow: { alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1 },
  storeInfo: { flex: 1 },
  storeName: { fontSize: 15, fontFamily: 'PlexArabic-SemiBold' },
  storeHint: { fontSize: 12, marginTop: 2 },
  signOutRow: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14 },
  signOutTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
  deleteLink: {
    alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 6, alignSelf: 'center',
  },
  deleteLinkTxt: { fontSize: 12, fontFamily: 'PlexArabic-SemiBold' },
  version: { textAlign: 'center', fontSize: 12, paddingBottom: 16 },

  // Delete-account confirmation sheet
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.lg + 4, borderTopRightRadius: radii.lg + 4,
    padding: 24, paddingBottom: 36, alignItems: 'center', gap: 6,
    width: '100%', maxWidth: 512, alignSelf: 'center',
  },
  sheetIconRing: {
    width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center', marginBottom: 6,
  },
  sheetTitle: { fontSize: 17, fontFamily: 'PlexArabic-Bold', textAlign: 'center' },
  sheetBody: { fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 14 },
  deleteConfirmBtn: {
    width: '100%', paddingVertical: 14, borderRadius: radii.md,
    alignItems: 'center', justifyContent: 'center',
  },
  deleteConfirmTxt: { color: '#fff', fontSize: 15, fontFamily: 'PlexArabic-Bold' },
  deleteCancelBtn: { paddingVertical: 12, marginTop: 2 },
  deleteCancelTxt: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
});
