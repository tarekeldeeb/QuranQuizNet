// Web renderer using the official React wrapper around <quran-madina-html>.
// The wrapper injects the library <script> at runtime and, left to its
// defaults, loads its CSS/DB from unpkg (unversioned "latest" — see the
// src/cdn override below for why we don't use that). Font + size are loader
// config honored on the first mounted instance.
//
// The underlying custom element reads its attributes on creation, so we key the
// element on its selection to force a remount when `words` changes (the question
// grows each round). The DB is fetched once and cached, so remounts are cheap.
import React from 'react';
import { View, StyleProp, ViewStyle, Dimensions } from 'react-native';
import QuranMadinaHtml from '@tarekeldeeb/quran-madina-react';
import type { QuranTextProps } from './QuranText';
import { madinaFontSizeForWidth } from '../models/madinaWidth';
import { useTheme } from '../theme/tokens';

// Self-hosted (same-origin) copy of the library instead of the wrapper's
// unpkg default, so the quiz works fully offline after the first load (the
// service worker cache-firsts same-origin static assets, but never touches
// cross-origin unpkg requests) and so an upstream publish can't silently
// change rendering underneath us. Assets are synced from the pinned
// "quran-madina-html" version via `npm run sync:madina` — see
// scripts/sync-madina-assets.mjs.
const MADINA_BASE = '/quran-madina/';
const MADINA_SRC = `${MADINA_BASE}dist/quran-madina-html.min.js`;

// The wrapper's loader config (including fontSize) is only honored on the
// first <QuranMadinaHtml> mounted per page session — see the "Global config
// caveat" in @tarekeldeeb/quran-madina-react's README — so this can't be a
// per-render/per-question value on web the way it is on native (a fresh
// WebView document per question there). Computed once instead, the same way
// QuizCard.tsx computes its own CARD_W once from Dimensions at module load.
// Mirrors CARD_W's own math (window width, capped at 480, minus the 32px
// outer margin) minus the more conservative of the two paddings the front
// (questionBox, 12px) and back (answerContent, 14px) faces wrap this in.
const { width: SW } = Dimensions.get('window');
const CARD_W = Math.min(SW - 32, 480);
const MADINA_FONT_SIZE = madinaFontSizeForWidth(CARD_W - 14 * 2);

// The custom element re-validates its {sura, aya} / {page} attributes on every
// individual attribute write, so during the remount below there's a brief,
// harmless window where React has set some but not all of them yet — the
// library logs this exact message every time, even though the next attribute
// write (a tick later) completes the render correctly. Filter just this one
// known-benign string; everything else still reaches the console untouched.
const QMH_BAD_ARGS_MSG = 'quran-madina-html> Bad arguments: Not rendering!';
type PatchedConsole = Console & { __qmhFiltered?: boolean };
const patchedConsole = console as PatchedConsole;
if (!patchedConsole.__qmhFiltered) {
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes(QMH_BAD_ARGS_MSG)) return;
    origError(...args);
  };
  patchedConsole.__qmhFiltered = true;
}

// The library wires a raw mouseover/mouseout pair on its word-group elements
// that sets element.style.backgroundColor = "lightgrey" directly (hardcoded
// in the minified bundle — not a CSS rule, not a themeable prop, the only
// place in the whole library that sets an inline background-color; mouseout
// resets it to "transparent", also inline). Word text separately inherits
// its color from us via currentColor, which is correctly theme-aware — so in
// dark mode that left our light (dark-mode) text sitting on a literal
// "lightgrey" box: light-on-light, reported as "the hover highlight is too
// shiny, losing all text contrast."
//
// An inline style only loses to a stylesheet rule that's !important, so this
// needs a real injected rule — but [style*="background-color"] (an earlier,
// broken version of this fix) matched BOTH states, since "background-color"
// appears in the attribute text of the resting `background-color:transparent`
// just as much as the hover `background-color:lightgrey` — forcing every
// word permanently to var(--qmh-background), which turned out to resolve to
// the library's own #F5F5DC default rather than our override, painting every
// line pale yellow at all times (reported: "now it's horrible"). Matching
// the literal "lightgrey" substring instead only ever catches the actual
// hover moment.
//
// A translucent light-grey wash — the library's own hover color, just no
// longer opaque — mixes only partway toward whatever's underneath rather
// than replacing it outright. Checked against both palettes' actual text/
// background pairs (see src/theme/__tests__/contrast.test.ts's approach):
// worst case is dark mode's card background at ~5.5:1, still comfortably
// past WCAG AA's 4.5:1. Doesn't depend on the custom-property channel a
// previous version of this fix already proved unreliable.
const QMH_HOVER_FIX_CSS = `
quran-madina-html [style*="lightgrey"] {
  background-color: rgba(211, 211, 211, 0.3) !important;
}
`;
function injectHoverFix() {
  if (typeof document === 'undefined' || document.getElementById('qmh-hover-fix')) return;
  const el = document.createElement('style');
  el.id = 'qmh-hover-fix';
  el.textContent = QMH_HOVER_FIX_CSS;
  document.head.appendChild(el);
}
injectHoverFix();

// The sura-start line's ornamental frame is painted via a fixed black SVG
// background-image (see quran-madina-html.css) — theme-blind, same class of
// bug as the hover fix above. Left commented out in the library's own source
// as an abandoned attempt (`f8698f8 Enhance Css for dark/light contexts`) at
// exactly this: swapping the image from a background-image (fixed black
// pixels) to a mask-image (an alpha stencil) painted with background-color:
// currentColor instead. currentColor already carries the theme's ink color
// this deep (see QuranText's own `color: colors.ink` on the wrapping node),
// so this makes the frame automatically light-on-dark instead of a
// near-invisible black smear on dark mode's near-black card background.
//
// The mask must live on a `::before` overlay, NOT on the line element
// itself: `mask-image` clips an element's entire rendered box — content and
// all — not just its background paint layer (unlike `background-image`,
// which only ever affects the background). The line's own children include
// the sura-name text div (`.quran-madina-html-sura-start`), so masking the
// line directly clipped that text away everywhere the SVG's alpha is 0 —
// i.e. everywhere except the ornamental corners — making the name invisible
// (regression: the name stopped showing at all, not just losing contrast).
// The overlay is its own empty box, so masking it only clips itself.
// `isolation: isolate` on the line scopes the overlay's `z-index: -1` to
// just this line's own paint order, so it sits behind the in-flow text
// instead of escaping to interfere with unrelated stacking elsewhere.
// !important + re-declaring background-image guards against load-order races
// with the library's own async-fetched stylesheet.
const QMH_SURA_BORDER_FIX_CSS = `
quran-madina-html-line:has(.quran-madina-html-sura-start) {
  position: relative;
  isolation: isolate;
  background-image: none !important;
}
quran-madina-html-line:has(.quran-madina-html-sura-start)::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background-color: currentColor;
  -webkit-mask-image: url(${MADINA_BASE}assets/img/sura_border_sym4.svg) !important;
  mask-image: url(${MADINA_BASE}assets/img/sura_border_sym4.svg) !important;
  -webkit-mask-size: 95% 100% !important;
  mask-size: 95% 100% !important;
  -webkit-mask-position: center !important;
  mask-position: center !important;
  -webkit-mask-repeat: no-repeat !important;
  mask-repeat: no-repeat !important;
}
`;
function injectSuraBorderFix() {
  if (typeof document === 'undefined' || document.getElementById('qmh-sura-border-fix')) return;
  const el = document.createElement('style');
  el.id = 'qmh-sura-border-fix';
  el.textContent = QMH_SURA_BORDER_FIX_CSS;
  document.head.appendChild(el);
}
injectSuraBorderFix();

export default function QuranText({ sura, aya, words, hideTitle, error, style }: QuranTextProps) {
  const { colors } = useTheme();
  return (
    <View style={[wrap, style as StyleProp<ViewStyle>]}>
      <QuranMadinaHtml
        key={`${sura}:${aya}:${words}:${hideTitle}:${error}`}
        sura={sura}
        aya={aya}
        words={words}
        error={error}
        headless
        quotes="no"
        inline="no"
        src={MADINA_SRC}
        cdn={MADINA_BASE}
        // Suppresses the crossed-into sura's name while the excerpt hasn't reached any of
        // that sura's real (post-basmala) words yet — see QuizCard's reachesNewSuraContent,
        // which decides hideTitle per excerpt so the label only appears once it's earned.
        notitle={hideTitle}
        font="Hafs"
        fontSize={MADINA_FONT_SIZE}
        // The element's own background is a 10%-strength color-mix wash of
        // --qmh-background (a fixed light cream, #F5F5DC by default,
        // unrelated to our theme) over transparent. Word text separately
        // inherits its color from the wrapping element via currentColor (see
        // caller's `color: colors.ink`), which DOES flip with theme — so in
        // dark mode that left light text sitting on this library's own
        // still-light wash: light-on-light, the reported contrast loss.
        // Overriding the custom property to our own paper tone makes the
        // wash blend into the surrounding card instead of fighting it.
        style={{ background: 'transparent', '--qmh-background': colors.paper } as React.CSSProperties}
      />
    </View>
  );
}

const wrap: StyleProp<ViewStyle> = {
  // Cross-axis alignment on a column flex container follows inline
  // direction, and the page is RTL, so flex-start (not flex-end) is what
  // hugs the right edge here.
  alignItems: 'flex-start',
  width: '100%',
};
