// PvP journey screen — the world-map counterpart of me.tsx's lifetime-score
// rank ladder (RankSheet): profile.pvp.points → current city on the map →
// the full 20-city ladder below it. One-way progress (see pvpTiers.ts) — a
// loss never moves the avatar back.
import { useMemo, useState } from 'react';
import { View, Text, Image, FlatList, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import JourneyMap from '../../src/components/JourneyMap';
import CityCard from '../../src/components/CityCard';
import PressScale from '../../src/components/PressScale';
import { useProfileStore } from '../../src/stores/profileStore';
import { getPvpTierInfo, getCityLadder, cityName, type PvpCity, type PvpCityLadderEntry } from '../../src/models/pvpTiers';
import { CITY_IMAGES, CITY_IMAGE_ASPECT } from '../../src/models/cityImages';
import { useTheme, radii } from '../../src/theme/tokens';
import { useDirection, rowDir, alignDir, mirror } from '../../src/theme/direction';

// Row background photo fade: fully opaque (hides the image, protects text
// legibility) near the name/tier text, fully transparent (image shows
// through) at the row's trailing end — mirrored for RTL since the SVG
// overlay itself isn't flipped by flexDirection the way the row's children are.
function rowFadeStops(isRTL: boolean) {
  return isRTL
    ? [
        { offset: '0%', opacity: 0 }, { offset: '15%', opacity: 0 },
        { offset: '55%', opacity: 1 }, { offset: '100%', opacity: 1 },
      ]
    : [
        { offset: '0%', opacity: 1 }, { offset: '45%', opacity: 1 },
        { offset: '85%', opacity: 0 }, { offset: '100%', opacity: 0 },
      ];
}

const TIER_EMOJI: Record<string, string> = {
  bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎', hafizGold: '🏆',
};

export default function PvpJourneyScreen() {
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  const { colors } = useTheme();
  const router = useRouter();
  const profile = useProfileStore();
  const [cityCardTarget, setCityCardTarget] = useState<PvpCity | null>(null);

  const points = profile.pvp.points;
  // getPvpTierInfo/getCityLadder call i18n.t() internally (cityName,
  // pvpTierTitle) — `t` must be a dep too, or a language switch with no
  // `points` change leaves these memoized in the previous language (t's
  // reference changes per language, see (auth)/index.tsx's `stats` memo).
  const tierInfo = useMemo(() => getPvpTierInfo(points), [points, t]);
  const ladder = useMemo(() => getCityLadder(points), [points, t]);
  const nextCityLabel = tierInfo.nextCity ? cityName(tierInfo.nextCity.id) : null;
  const fadeStops = useMemo(() => rowFadeStops(isRTL), [isRTL]);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]} edges={['top', 'bottom']}>
      <View style={[s.header, { borderColor: colors.line, flexDirection: rowDir(isRTL) }]}>
        <PressScale onPress={() => router.navigate('/(app)/me')} hitSlop={10} style={s.backBtn}>
          <Ionicons name={mirror(isRTL, 'chevron-back', 'chevron-forward')} size={22} color={colors.ink} />
        </PressScale>
        <Text style={[s.title, { color: colors.ink, fontFamily: 'Amiri-Regular' }]}>{t('pvpJourney.title')}</Text>
        <Text style={s.headerEmoji}>{TIER_EMOJI[tierInfo.tier]}</Text>
      </View>

      <FlatList
        data={ladder}
        keyExtractor={(item) => item.city.id}
        contentContainerStyle={s.list}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListHeaderComponent={
          <View style={s.mapSection}>
            <JourneyMap
              currentIndex={tierInfo.city.index}
              avatarUri={profile.social.photoURL}
              colors={colors}
              onPressCurrentCity={() => setCityCardTarget(tierInfo.city)}
            />
            <View style={[s.summaryCard, { backgroundColor: colors.card, borderColor: colors.line }]}>
              <Text style={[s.summaryTitle, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
                {tierInfo.tierTitle} · {tierInfo.cityName}
              </Text>
              <Text style={[s.summarySub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
                {tierInfo.journeyComplete || !nextCityLabel
                  ? t('pvpJourney.complete')
                  : t('pvpJourney.toNextCity', { count: tierInfo.pointsToNextCity, cityName: nextCityLabel })}
              </Text>
              <View style={[s.track, { backgroundColor: colors.goldPale }]}>
                <View style={[s.fill, { width: `${tierInfo.progress * 100}%`, backgroundColor: colors.gold, [isRTL ? 'right' : 'left']: 0 }]} />
              </View>
            </View>
          </View>
        }
        renderItem={({ item }: { item: PvpCityLadderEntry }) => (
          <PressScale
            onPress={() => setCityCardTarget(item.city)}
            style={[
              s.row,
              { backgroundColor: colors.card, borderColor: colors.line },
              !item.reached && { opacity: 0.55 },
              item.current && { borderColor: colors.gold, borderWidth: 1.5 },
            ]}
          >
            <View style={[StyleSheet.absoluteFill, s.photoClip]}>
              <Image
                source={CITY_IMAGES[item.city.id]}
                style={{ width: '100%', aspectRatio: CITY_IMAGE_ASPECT[item.city.id] }}
              />
            </View>
            <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
              <Defs>
                <LinearGradient id={`rowFade-${item.city.id}`} x1="0" y1="0" x2="1" y2="0">
                  {fadeStops.map((stop) => (
                    <Stop key={stop.offset} offset={stop.offset} stopColor={colors.card} stopOpacity={stop.opacity} />
                  ))}
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="100" height="100" fill={`url(#rowFade-${item.city.id})`} />
            </Svg>

            <View style={[s.rowContent, { flexDirection: rowDir(isRTL) }]}>
              <Text style={s.rowEmoji}>{TIER_EMOJI[item.city.tier]}</Text>
              <View style={[s.rowInfo, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                <Text style={[s.rowName, { color: colors.ink, textAlign: alignDir(isRTL) }]}>{item.cityName}</Text>
                <Text style={[s.rowSub, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>{item.tierTitle}</Text>
              </View>
              {item.current ? (
                <View
                  style={[
                    s.nowBadge,
                    { backgroundColor: colors.gold },
                    isRTL ? { marginLeft: 6 } : { marginRight: 6 },
                  ]}
                >
                  <Text style={[s.nowTxt, { color: colors.navy }]}>{t('pvpJourney.here')}</Text>
                </View>
              ) : item.reached ? (
                <View
                  style={[
                    s.checkBadge,
                    { backgroundColor: colors.card },
                    isRTL ? { marginLeft: 6 } : { marginRight: 6 },
                  ]}
                >
                  <Ionicons name="checkmark-circle" size={18} color={colors.gold} />
                </View>
              ) : null}
            </View>
          </PressScale>
        )}
      />

      <CityCard
        city={cityCardTarget}
        visible={cityCardTarget !== null}
        onClose={() => setCityCardTarget(null)}
        colors={colors}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    alignItems: 'center', padding: 16, gap: 8, borderBottomWidth: 1,
  },
  backBtn: { padding: 2 },
  title: { flex: 1, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  headerEmoji: { fontSize: 20 },
  list: { padding: 12 },
  mapSection: { gap: 12, marginBottom: 16 },
  summaryCard: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 6 },
  summaryTitle: { fontSize: 15, fontFamily: 'PlexArabic-Bold' },
  summarySub: { fontSize: 12.5 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', position: 'relative' },
  fill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },
  row: {
    height: 84, borderRadius: radii.md, borderWidth: 1, overflow: 'hidden',
  },
  photoClip: { justifyContent: 'center' },
  rowContent: {
    flex: 1, alignItems: 'center', gap: 10, padding: 10,
  },
  rowEmoji: { fontSize: 18 },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 14, fontFamily: 'PlexArabic-SemiBold' },
  rowSub: { fontSize: 11, marginTop: 1 },
  nowBadge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radii.pill },
  nowTxt: { fontSize: 10.5, fontFamily: 'PlexArabic-Bold' },
  checkBadge: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
  },
});
