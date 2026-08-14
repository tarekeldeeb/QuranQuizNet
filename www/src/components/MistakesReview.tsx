import React from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import QuranText from './QuranText';
import { MistakeRecord } from '../models/mistakes';
import { suraNameLocalized } from '../models/constants';
import { useTheme, localeNum, radii } from '../theme/tokens';
import { useDirection, alignDir } from '../theme/direction';

const QURAN_FONT = Platform.OS === 'web' ? 'UthmanTN' : undefined;
const AMIRI_FONT = 'Amiri-Regular';

interface Props {
  mistakes: MistakeRecord[];
}

export default function MistakesReview({ mistakes }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { isRTL, language } = useDirection();

  if (!mistakes || mistakes.length === 0) {
    return null;
  }

  return (
    <View style={s.container}>
      <Text style={[s.title, { color: colors.ink, textAlign: alignDir(isRTL) }]}>
        {t('quiz.mistakes.title', { count: mistakes.length })}
      </Text>
      <ScrollView
        style={s.answerScroll}
        contentContainerStyle={s.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {mistakes.map((m) => {
          const suraName = suraNameLocalized(m.suraNum - 1);
          const suraAyaLabel = `${suraName} · ${t('quizCard.ayahLabel', { number: localeNum(m.aya, language) })}`;

          return (
            <View
              key={m.id}
              style={[s.rowCard, { backgroundColor: colors.paper, borderColor: colors.line }]}
            >
              <Text style={[s.suraAyaCaption, { color: colors.inkSoft, textAlign: alignDir(isRTL) }]}>
                {suraAyaLabel}
              </Text>

              {m.isQuranText && (
                <View style={s.quranBox}>
                  <QuranText
                    sura={m.suraNum}
                    aya={m.aya}
                    words={m.words}
                    error={m.errorWords}
                    hideTitle={m.hideTitle}
                    text={m.correctText}
                    style={[s.quranText, { color: colors.ink }]}
                  />
                </View>
              )}

              {!!m.correctText && (
                <Text style={[s.captionText, { color: colors.correct, textAlign: alignDir(isRTL) }]}>
                  {t('quiz.mistakes.correct', { text: m.correctText })}
                </Text>
              )}

              {!!m.pickedText && (
                <Text style={[s.captionText, { color: colors.wrong, textAlign: alignDir(isRTL) }]}>
                  {t('quiz.mistakes.picked', { text: m.pickedText })}
                </Text>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    width: '100%',
    marginVertical: 10,
  },
  title: {
    fontSize: 15,
    fontFamily: 'PlexArabic-Bold',
    marginBottom: 8,
  },
  answerScroll: {
    maxHeight: 260,
  },
  scrollContent: {
    gap: 8,
    paddingVertical: 2,
  },
  rowCard: {
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: 10,
    gap: 6,
  },
  suraAyaCaption: {
    fontSize: 13,
    fontFamily: AMIRI_FONT,
    fontWeight: '700',
  },
  quranBox: {
    paddingVertical: 4,
  },
  quranText: {
    fontSize: 20,
    fontFamily: QURAN_FONT,
    lineHeight: 40,
    textAlign: 'right',
    writingDirection: 'rtl',
    alignItems: 'center',
  },
  captionText: {
    fontSize: 13,
    fontFamily: 'PlexArabic-SemiBold',
    writingDirection: 'rtl',
  },
});
