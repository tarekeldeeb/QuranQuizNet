// Quran text renderer. Native fallback: the quran-madina-html library is a DOM
// custom element and only exists on web, so on iOS/Android we render the plain
// text we already have. The web override (QuranText.web.tsx) renders the
// Madina-style custom element from sura/aya/words.
import React from 'react';
import { Text, TextStyle, StyleProp } from 'react-native';

export interface QuranTextProps {
  text: string;     // plain text fallback (shown on native)
  sura: number;     // 1-based sura number (web only)
  aya: number;      // 1-based aya number within the sura (web only)
  words: string;    // "start-end", counted from the aya start (web only)
  error?: string;   // 1-based inclusive word range with error-highlight styling
  // Hide the crossed-into sura's name (web only). Pass true until the excerpt reaches
  // that sura's own real (post-basmala) content — see QuizCard's reachesNewSuraContent.
  hideTitle: boolean;
  style?: StyleProp<TextStyle>;
}

export default function QuranText({ text, style }: QuranTextProps) {
  return <Text style={style}>{text}</Text>;
}
