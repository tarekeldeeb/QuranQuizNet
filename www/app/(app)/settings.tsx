// Settings screen — level, special questions, version, sign-out. Reached from
// Home via the gear icon in the header (see (app)/me.tsx) instead of living
// inline on Home, which used to do five jobs at once.
import { useEffect, useState } from 'react';
import { View, Text, Switch, StyleSheet, ScrollView, Platform, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { useProfileStore } from '../../src/stores/profileStore';
import {
  watchNotifPrefs, setNotifPref, pushCurrentProfile, type NotifCategory, type NotifPrefs,
} from '../../src/services/firebase';
import { useTheme, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir, mirror, switchStyle } from '../../src/theme/direction';
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

export default function SettingsScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  const router = useRouter();
  const profile = useProfileStore();
  const social = profile.social;
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

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['top', 'bottom']}>
      <View style={[s.header, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
        <PressScale onPress={() => router.navigate('/(app)/me')} hitSlop={10} style={s.backBtn}>
          <Ionicons name={mirror(isRTL, 'chevron-back', 'chevron-forward')} size={22} color={colors.ink} />
        </PressScale>
        <Text style={[s.title, { color: colors.ink, fontFamily: 'Amiri-Regular' }]}>{t('settings.title')}</Text>
        <View style={s.backBtn} />
      </View>
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
              style={switchStyle(isRTL)}
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
              style={switchStyle(isRTL)}
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
              style={switchStyle(isRTL)}
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
              style={switchStyle(isRTL)}
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
              style={switchStyle(isRTL)}
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
              style={switchStyle(isRTL)}
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

        <Text style={[s.version, { color: colors.inkSoft }]}>{t('settings.version', { version: APP_VERSION })}</Text>
      </ScrollView>
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
  title: { flex: 1, fontSize: 20, fontWeight: '700', textAlign: 'center' },
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
  version: { textAlign: 'center', fontSize: 12, paddingBottom: 16 },
});
