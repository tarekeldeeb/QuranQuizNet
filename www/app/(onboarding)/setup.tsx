import { useState } from 'react';
import {
  View, Text, FlatList, Switch, TouchableOpacity, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useProfileStore } from '../../src/stores/profileStore';
import { useTheme } from '../../src/theme/tokens';
import { useDirection, alignDir, switchStyle } from '../../src/theme/direction';
import { translatePartName } from '../../src/models/constants';

export default function SetupScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isRTL } = useDirection();
  const profile = useProfileStore();
  const [parts, setParts] = useState(() => profile.parts.map((p) => ({ ...p })));

  function toggle(index: number) {
    if (index === 0) return;
    const next = [...parts];
    next[index] = { ...next[index], checked: !next[index].checked };
    setParts(next);
  }

  function selectAll() {
    setParts(parts.map((p, i) => (i === 0 ? p : { ...p, checked: true })));
  }

  function selectNone() {
    setParts(parts.map((p, i) => (i === 0 ? p : { ...p, checked: false })));
  }

  function selectLast() {
    setParts(parts.map((p, i) => ({
      ...p,
      checked: i === 0 ? true : i >= 45 && i <= 49,
    })));
  }

  // The level-select screen is skipped — new users start at the default
  // level (1) silently; it's still changeable later from Settings.
  // This screen now only runs for guests, right after anonymous sign-in
  // (see (auth)/index.tsx), so confirming sends them straight into the app.
  async function confirm() {
    useProfileStore.setState({ parts });
    await profile.saveParts();
    await profile.saveSettings();
    router.replace('/(app)/me');
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.paper }]}>
      <View style={s.header}>
        <Text style={[s.title, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
          {t('onboarding.setup.title')}
        </Text>
        <Text style={[s.subtitle, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
          {t('onboarding.setup.subtitle')}
        </Text>
      </View>

      <View style={s.actionRow}>
        <TouchableOpacity style={[s.actionBtn, { backgroundColor: colors.card, borderColor: colors.line }]} onPress={selectAll}>
          <Text style={[s.actionTxt, { color: colors.ink }]}>{t('onboarding.setup.all')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.actionBtn, { backgroundColor: colors.card, borderColor: colors.line }]} onPress={selectNone}>
          <Text style={[s.actionTxt, { color: colors.ink }]}>{t('onboarding.setup.none')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.actionBtn, { backgroundColor: colors.card, borderColor: colors.line }]} onPress={selectLast}>
          <Text style={[s.actionTxt, { color: colors.ink }]}>{t('onboarding.setup.recent')}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={parts}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item, index }) => (
          <View style={[s.row, { backgroundColor: colors.card }]}>
            <Switch
              value={item.checked}
              onValueChange={() => toggle(index)}
              disabled={index === 0}
              trackColor={{ false: colors.line, true: colors.gold }}
              thumbColor="#fff"
              style={switchStyle(isRTL)}
            />
            <Text style={[s.partName, { color: colors.ink, textAlign: alignDir(isRTL) }, index === 0 && { color: colors.goldDeep, fontWeight: '600' }]}>
              {translatePartName(item.name)}
            </Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={[s.sep, { backgroundColor: colors.line }]} />}
        contentContainerStyle={s.list}
        style={s.flatList}
      />

      <TouchableOpacity style={[s.confirmBtn, { backgroundColor: colors.navy }]} onPress={confirm}>
        <Text style={s.confirmTxt}>{t('onboarding.setup.confirm')}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, marginTop: 4 },
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  actionTxt: { fontSize: 13, fontWeight: '600' },
  flatList: { flex: 1 },
  list: { paddingBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  partName: { flex: 1, fontSize: 15 },
  sep: { height: 1 },
  confirmBtn: {
    margin: 16,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  confirmTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
