import { useProfileStore } from '../stores/profileStore';
import { LANGUAGE_META, type Language } from '../i18n/languages';

export const isRTLLang = (lang: Language): boolean => LANGUAGE_META[lang].isRTL;
export const rowDir = (isRTL: boolean): 'row-reverse' | 'row' => (isRTL ? 'row-reverse' : 'row');
export const alignDir = (isRTL: boolean): 'right' | 'left' => (isRTL ? 'right' : 'left');
export const writingDir = (isRTL: boolean): 'rtl' | 'ltr' => (isRTL ? 'rtl' : 'ltr');

export function mirror<T>(isRTL: boolean, ltrValue: T, rtlValue: T): T {
  return isRTL ? rtlValue : ltrValue;
}

// <Switch>'s thumb slides using logical (inline-start/end) CSS properties,
// which only flip for a real `direction: rtl` on the DOM. This app fakes RTL
// per-component instead (rowDir/alignDir), so the native/web switch widget
// never mirrors on its own — flip it by hand with a horizontal transform.
export function switchStyle(isRTL: boolean) {
  return isRTL ? { transform: [{ scaleX: -1 }] } : undefined;
}

export function useDirection() {
  const language = useProfileStore((s) => s.language);
  return { language, isRTL: isRTLLang(language) };
}
