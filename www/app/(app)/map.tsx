// خريطة الحفظ — the progression map. Replaces the old parts-editor modal
// list: one glance answers "where am I, what's next, what needs repair" via
// the khatam-star mastery tier on every sura/juz, instead of a color dot plus
// a separate 🏅 badge. Tapping a row starts a focused run on it (the same
// customPart deep-link the old "تدرّب" button used); the switch on the edge
// is the explicit, secondary control for which parts count toward the profile.
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Switch, Animated, Platform, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useProfileStore, CORRECT_RATIO_RANGE, tierFromRatioRange } from '../../src/stores/profileStore';
import KhatamStar from '../../src/components/KhatamStar';
import PressScale from '../../src/components/PressScale';
import { useTheme, localeNum, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir, mirror, switchStyle } from '../../src/theme/direction';
import { translatePartName } from '../../src/models/constants';

type BulkAction = 'all' | 'good' | 'weak';

const NATIVE_DRIVER = Platform.OS !== 'web';

/** Short, soft bell chime on web (no native dependency). No-op elsewhere. */
function playBell() {
  if (Platform.OS !== 'web') return;
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.36);
    o.onended = () => ctx.close();
  } catch { /* audio is non-critical */ }
}

/** Active-parts counter that tweens up/down, with a bell that rings on increase. */
function ActiveCountBadge({ value, color, bg }: { value: number; color: string; bg: string }) {
  const { isRTL, language } = useDirection();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const prevRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  const shake = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from !== to) {
      const duration = 450;
      const start = Date.now();
      const tick = () => {
        const t = Math.min(1, (Date.now() - start) / duration);
        const eased = 1 - (1 - t) ** 3;
        setDisplay(Math.round(from + (to - from) * eased));
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
        else { fromRef.current = to; rafRef.current = null; }
      };
      rafRef.current = requestAnimationFrame(tick);
    }
    if (to > prevRef.current) {
      shake.setValue(0);
      Animated.sequence([
        Animated.timing(shake, { toValue: 1, duration: 80, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(shake, { toValue: -1, duration: 80, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(shake, { toValue: 0.5, duration: 70, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(shake, { toValue: 0, duration: 70, useNativeDriver: NATIVE_DRIVER }),
      ]).start();
      playBell();
    }
    prevRef.current = to;
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, shake]);

  const rotate = shake.interpolate({ inputRange: [-1, 1], outputRange: ['-22deg', '22deg'] });

  return (
    <View style={[s.countBadge, { backgroundColor: bg, flexDirection: rowDir(isRTL) }]}>
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Ionicons name="notifications" size={15} color={color} />
      </Animated.View>
      <Text style={[s.countNum, { color }]}>{localeNum(display, language)}</Text>
    </View>
  );
}

export default function MapScreen() {
  const { t } = useTranslation();
  const { isRTL, language } = useDirection();
  const { colors } = useTheme();
  const router = useRouter();
  const profile = useProfileStore();

  function togglePart(index: number) {
    if (index === 0) return;
    const parts = [...profile.parts];
    parts[index] = { ...parts[index], checked: !parts[index].checked };
    useProfileStore.setState({ parts });
    profile.saveParts();
  }

  function applyBulk(action: BulkAction) {
    const parts = profile.parts.map((p, i) => {
      if (i === 0) return p; // Al-Fatiha always stays checked
      const range = profile.getCorrectRatioRange(i);
      let checked: boolean;
      if (action === 'all') checked = true;
      else if (action === 'good') checked = range === CORRECT_RATIO_RANGE.HIGH;
      else checked = range !== CORRECT_RATIO_RANGE.HIGH;
      return { ...p, checked };
    });
    const hasSubstantive = parts.some((p, i) => i !== 0 && p.checked);
    if (!hasSubstantive && parts.length > 0) {
      const juzAmma = parts.length - 1;
      parts[juzAmma] = { ...parts[juzAmma], checked: true };
    }
    useProfileStore.setState({ parts });
    profile.saveParts();
  }

  const activeParts = profile.parts.filter((p) => p.checked).length;

  // No 'bottom' edge: the tab bar reserves the bottom safe-area inset itself.
  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['top']}>
      <View style={[s.header, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
        <PressScale onPress={() => router.back()} hitSlop={10} style={s.backBtn}>
          <Ionicons name={mirror(isRTL, 'chevron-back', 'chevron-forward')} size={22} color={colors.ink} />
        </PressScale>
        <Text style={[s.title, { color: colors.ink, fontFamily: 'Amiri-Regular' }]}>{t('map.title')}</Text>
        <ActiveCountBadge value={activeParts} color={colors.goldDeep} bg={colors.goldPale} />
      </View>

      <View style={[s.filterRow, { flexDirection: rowDir(isRTL) }]}>
        {(([ ['all', t('map.filterAll')], ['good', t('map.filterGood')], ['weak', t('map.filterWeak')] ]) as [BulkAction, string][]).map(([action, label]) => (
          <PressScale
            key={action}
            style={[s.filterBtn, { backgroundColor: colors.card, borderColor: colors.line }]}
            onPress={() => applyBulk(action)}
          >
            <Text style={[s.filterBtnTxt, { color: colors.ink }]}>{label}</Text>
          </PressScale>
        ))}
      </View>

      <FlatList
        data={profile.parts}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={s.list}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        renderItem={({ item: part, index }) => {
          const range = profile.getCorrectRatioRange(index);
          const tier = tierFromRatioRange(range);
          const correct = part.numCorrect[1] + part.numCorrect[2] + part.numCorrect[3] + (part.numCorrect[4] ?? 0);
          const questions = part.numQuestions[1] + part.numQuestions[2] + part.numQuestions[3] + (part.numQuestions[4] ?? 0);
          return (
            <View style={[s.row, { backgroundColor: colors.card, opacity: part.checked ? 1 : 0.6, flexDirection: rowDir(isRTL) }]}>
              <PressScale
                style={[s.rowMain, { flexDirection: rowDir(isRTL) }]}
                onPress={() => router.push({ pathname: '/(app)/quiz', params: { customPart: String(index), nonce: String(Date.now()) } })}
              >
                <KhatamStar tier={tier} size={38} colors={colors} />
                <View style={[s.rowInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                  <Text style={[s.rowName, { color: colors.ink, textAlign: alignDir(isRTL) }]} numberOfLines={1}>{translatePartName(part.name)}</Text>
                  <Text style={[s.rowSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
                    {questions > 0 ? t('map.correctOf', { correct: localeNum(correct, language), questions: localeNum(questions, language) }) : t('map.notTested')}
                  </Text>
                </View>
              </PressScale>
              <Switch
                value={part.checked}
                onValueChange={() => togglePart(index)}
                disabled={index === 0}
                trackColor={{ false: colors.line, true: colors.gold }}
                thumbColor="#fff"
                style={switchStyle(isRTL)}
              />
            </View>
          );
        }}
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
  title: { flex: 1, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  countBadge: {
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
  },
  countNum: { fontSize: 14, fontFamily: 'PlexArabic-Bold', minWidth: 14, textAlign: 'center' },
  filterRow: { padding: 12, gap: 8 },
  filterBtn: { flex: 1, paddingVertical: 9, borderRadius: radii.md, alignItems: 'center', borderWidth: 1 },
  filterBtnTxt: { fontSize: 13, fontFamily: 'PlexArabic-SemiBold' },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  row: {
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: radii.md,
  },
  rowMain: {
    flex: 1,
    alignItems: 'center',
    gap: 10,
  },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
  rowSub: { fontSize: 11, marginTop: 1 },
});
