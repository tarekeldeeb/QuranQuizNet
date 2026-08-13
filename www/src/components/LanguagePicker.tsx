import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radii } from '../theme/tokens';
import { useDirection, rowDir, alignDir } from '../theme/direction';
import { SUPPORTED_LANGUAGES, LANGUAGE_META, type Language } from '../i18n/languages';
import PressScale from './PressScale';

interface Props {
  value: Language;
  onChange: (lang: Language) => void;
}

const OPTIONS: { lang: Language; label: string }[] = SUPPORTED_LANGUAGES.map((lang) => ({
  lang,
  label: LANGUAGE_META[lang].nativeLabel,
}));

export default function LanguagePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const { colors } = useTheme();
  const { isRTL } = useDirection();

  const selectedOption = OPTIONS.find((opt) => opt.lang === value) || OPTIONS[0];

  const handleSelect = (lang: Language) => {
    onChange(lang);
    setOpen(false);
  };

  return (
    <View style={s.container}>
      <PressScale
        style={[
          s.trigger,
          {
            backgroundColor: colors.card,
            borderColor: colors.line,
            flexDirection: rowDir(isRTL),
          },
        ]}
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="combobox"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={selectedOption.label}
      >
        <Ionicons name="globe-outline" size={18} color={colors.inkSoft} />
        <Text style={[s.triggerText, { color: colors.ink, textAlign: alignDir(isRTL) }]} numberOfLines={1}>{selectedOption.label}</Text>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={colors.inkSoft}
        />
      </PressScale>

      {open && (
        <View
          style={[
            s.dropdown,
            {
              backgroundColor: colors.card,
              borderColor: colors.line,
              shadowColor: colors.shadow,
            },
          ]}
        >
          <ScrollView style={s.dropdownScroll} nestedScrollEnabled showsVerticalScrollIndicator>
            {OPTIONS.map((opt) => {
              const active = opt.lang === value;
              return (
                <Pressable
                  key={opt.lang}
                  style={({ pressed }) => [
                    s.option,
                    { flexDirection: rowDir(isRTL) },
                    active && { backgroundColor: colors.goldPale },
                    pressed && { opacity: 0.8 },
                  ]}
                  onPress={() => handleSelect(opt.lang)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={opt.label}
                >
                  <Text
                    style={[
                      s.optionText,
                      { color: active ? colors.navy : colors.ink, textAlign: alignDir(isRTL) },
                      active && s.optionTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {opt.label}
                  </Text>
                  {active && <Ionicons name="checkmark" size={16} color={colors.navy} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'relative',
    zIndex: 10,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minWidth: 108,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 8,
  },
  triggerText: {
    fontSize: 14,
    fontFamily: 'PlexArabic-SemiBold',
  },
  dropdown: {
    marginTop: 4,
    minWidth: 108,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
    elevation: 4,
  },
  // 14 languages no longer fit on screen at once — cap the height and let the
  // rest scroll instead of overflowing past the screen edge.
  dropdownScroll: {
    maxHeight: 280,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  optionText: {
    fontSize: 14,
    fontFamily: 'PlexArabic-Regular',
  },
  optionTextActive: {
    fontFamily: 'PlexArabic-Bold',
  },
});
