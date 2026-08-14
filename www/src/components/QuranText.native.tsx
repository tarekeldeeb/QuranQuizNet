// Native (iOS/Android) renderer: hosts the same <quran-madina-html> custom
// element QuranText.web.tsx uses, inside a WebView loaded from the local copy
// src/services/madinaAssets.ts extracts on first run (mirrors public/quran-madina/'s
// dist/ + assets/ layout exactly, so the library's relative fetches resolve
// the same way they do on web — see that file and quran-madina-html's README
// for the data-cdn contract).
//
// The library "reads its attributes on creation" (see QuranText.web.tsx's
// remount-on-key comment) — same constraint applies inside this WebView, so a
// fresh HTML document (current attributes baked in) is generated whenever the
// selection changes rather than mutating the element in place.
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleProp, ViewStyle, LayoutChangeEvent } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import { getMadinaBaseUri } from '../services/madinaAssets';
import { madinaFontSizeForWidth } from '../models/madinaWidth';
import type { QuranTextProps } from './QuranText';
import { useTheme } from '../theme/tokens';

// Same font QuranText.web.tsx configures the loader with. Font *size* isn't
// fixed here — see madinaFontSizeForWidth — since each question gets a fresh
// WebView document (unlike web, where the library's loader config is only
// honored on the first-ever mounted instance for the whole page session), a
// size can be picked per render to fit this instance's actual measured width.
const FONT = 'Hafs';
const MIN_HEIGHT = 60; // matches QuizCard's questionBox minHeight

function buildHtml(
  sura: number,
  aya: number,
  words: string,
  hideTitle: boolean,
  fontSize: number,
  ink: string,
  paper: string,
  error?: string,
): string {
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
html,body{margin:0;padding:0;background:transparent;color:${ink};}
/* Blend the Madina renderer into the quiz card, same as app/+html.tsx (web) and
   scripts/og-image/og-image.html: drop the library's beige tint, rounded corners,
   the inset mushaf-page gutter shadow (set inline by the library, so this needs
   !important to win — see app/+html.tsx), and any header.
   Word text has no color of its own in the library CSS — it's just inherited
   currentColor (see QuranText.web.tsx's hover-fix comment) — so unlike web,
   where an ancestor DOM node's color naturally cascades in, this WebView's
   document has no such ancestor and needs its own theme-aware color set
   directly, or it falls back to the browser default (black), unreadable
   against a dark-mode card. --qmh-background mirrors web's own-background
   override for the same reason (the library's muted/header colors are a
   color-mix off of it). */
quran-madina-html {
  background: transparent !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  --qmh-background: ${paper};
}
quran-madina-html-header { display: none !important; }
/* The sura-start line's ornamental frame is a fixed black SVG background-image
   (see quran-madina-html.css) — theme-blind, same as the word text was before
   this component set its own color above. Swapping it from a background-image
   (fixed black pixels) to a mask-image (an alpha stencil) painted with
   background-color: currentColor makes it inherit the ink color set on
   html,body above, so it's light-on-dark instead of a near-invisible black
   smear on a dark-mode card. See QuranText.web.tsx's mirror of this fix for
   the library-side context (a commented-out WIP left in its own source).
   The mask must live on a ::before overlay, NOT on the line element itself:
   mask-image clips an element's entire rendered box — content and all — not
   just its background paint layer. The line's own children include the
   sura-name text (the library appends it as a normal child of this same
   element, per its README), so masking the line directly clipped that text
   away everywhere the SVG's alpha is 0 — i.e. everywhere except the
   ornamental corners — making the name invisible instead of just recolored.
   The overlay is its own empty box, so masking it only clips itself; z-index
   -1 plus isolation on the line keeps it behind the in-flow text. */
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
  -webkit-mask-image: url(assets/img/sura_border_sym4.svg) !important;
  mask-image: url(assets/img/sura_border_sym4.svg) !important;
  -webkit-mask-size: 95% 100% !important;
  mask-size: 95% 100% !important;
  -webkit-mask-position: center !important;
  mask-position: center !important;
  -webkit-mask-repeat: no-repeat !important;
  mask-repeat: no-repeat !important;
}
</style>
<script>
(function () {
  // WKWebView reports XHR status 0 for local file:// requests even when they
  // succeed (there's no real HTTP status for a local file) — confirmed by
  // instrumenting a real load: the response body is fully populated, status
  // is just 0. The library's loader checks for a success status via its own
  // onreadystatechange handler, so on iOS it silently treats every local
  // DB/CSS load as failed and never renders. A flag set from a 'load'
  // listener arrives too late to fix this — 'readystatechange' at
  // readyState 4 fires before 'load' — so this computes success straight
  // from whether a body actually came back, every time status is read.
  // A failed local read (e.g. a size/font variant we didn't bundle) still
  // reaches readyState 4 but with an empty body, so this doesn't mask real
  // errors. Android isn't affected — file:// XHR there already reports
  // normal 200s.
  if (location.protocol === 'file:') {
    var OrigXHR = window.XMLHttpRequest;
    var origOpen = OrigXHR.prototype.open;
    OrigXHR.prototype.open = function () {
      var xhr = this;
      Object.defineProperty(xhr, 'status', {
        configurable: true,
        get: function () {
          if (xhr.readyState !== 4) return 0;
          try {
            return xhr.responseText && xhr.responseText.length > 0 ? 200 : 0;
          } catch (e) {
            return xhr.response ? 200 : 0;
          }
        },
      });
      return origOpen.apply(xhr, arguments);
    };
  }
  var s = document.createElement('script');
  s.setAttribute('data-cdn', './');
  s.setAttribute('data-font', '${FONT}');
  s.setAttribute('data-font-size', '${fontSize}');
  s.src = 'dist/quran-madina-html.min.js';
  document.head.appendChild(s);
})();
</script>
</head><body>
<quran-madina-html sura="${sura}" aya="${aya}" words="${words}" headless quotes="no" inline="no"${hideTitle ? ' notitle' : ''}${error ? ` error="${error}"` : ''}></quran-madina-html>
<script>
(function () {
  function post(h) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(String(h)); }
  function report() { post(document.body.scrollHeight); }
  // The custom element renders asynchronously (it fetches its DB JSON before
  // laying out text), so a single on-load measurement isn't enough — observe
  // for the reflow, with a couple of timed fallbacks in case ResizeObserver
  // isn't available or misses the first paint.
  if ('ResizeObserver' in window) { new ResizeObserver(report).observe(document.body); }
  window.addEventListener('load', report);
  setTimeout(report, 50);
  setTimeout(report, 400);
})();
</script>
</body></html>`;
}

let instanceCounter = 0;

export default function QuranText({ sura, aya, words, hideTitle, error, style }: QuranTextProps) {
  const { colors } = useTheme();
  const [height, setHeight] = useState(MIN_HEIGHT);
  // The `style` prop QuizCard passes in (questionText/answerText) sets
  // `alignItems: 'center'` on this wrapper (a web-only fix to center the
  // quran-madina-html block instead of hugging the edge — see QuranText.web.tsx).
  // On native, a WebView child has no intrinsic content size to size itself by
  // under that cross-axis alignment, so it collapses to 0 width — its viewport
  // then genuinely has 0px to lay out in, and the RTL text renders entirely
  // off-screen (negative x). Measuring the wrapper and passing an explicit
  // pixel width sidesteps the flex/alignItems interaction rather than fighting it.
  const [width, setWidth] = useState(0);

  // A front and back QuranText are mounted at the same time per QuizCard (see
  // QuizCard's flip faces), each independently re-selecting text over its
  // lifetime — a stable per-instance filename avoids two mounted instances
  // clobbering each other's file while still being safe to overwrite in place
  // as this instance's own selection changes.
  const instanceId = useRef(++instanceCounter).current;
  const [fileUri, setFileUri] = useState<string | null>(null);
  // Bumped on every write. The file path itself stays fixed per instance (see
  // above), so overwriting it in place for a new round is invisible to the
  // WebView unless the URL it's asked to load actually changes — without
  // this, "reloading" the identical file:// URL is a no-op navigation on
  // both platforms, and the WebView keeps showing the previous round's text
  // even though the file underneath it was rewritten (e.g. the question
  // growing a word each round never visibly updated).
  const version = useRef(0);

  function onLayout(e: LayoutChangeEvent) {
    setWidth(e.nativeEvent.layout.width);
  }

  useEffect(() => {
    // Wait for a real measured width (see the width state comment above) so
    // the very first file written already has the right font size, instead
    // of writing once at a fallback size and immediately rewriting.
    if (width <= 0) return;
    // WKWebView's loadHTMLString:baseURL: (what `source={{html, baseUrl}}` maps
    // to) does not reliably grant read access to sibling local files on iOS —
    // the library's own script/css/DB fetches silently fail and nothing renders.
    // Writing the document to a real file and loading it via `source={{uri}}`
    // instead routes through loadFileURL:allowingReadAccessToURL:, which does
    // grant that access (confirmed against react-native-webview's iOS source).
    // Works identically on Android, which only ever used source.uri's plain
    // file:// loading path here.
    let cancelled = false;
    const fontSize = madinaFontSizeForWidth(width);
    const html = buildHtml(sura, aya, words, hideTitle, fontSize, colors.ink, colors.paper, error);
    const uri = `${getMadinaBaseUri()}_render_${instanceId}.html`;
    FileSystem.writeAsStringAsync(uri, html).then(() => {
      if (cancelled) return;
      version.current += 1;
      setFileUri(`${uri}?v=${version.current}`);
    });
    return () => {
      cancelled = true;
    };
  }, [sura, aya, words, hideTitle, error, instanceId, width, colors.ink, colors.paper]);

  function onMessage(e: WebViewMessageEvent) {
    const h = Number(e.nativeEvent.data);
    if (Number.isFinite(h) && h > 0) setHeight(Math.max(h, MIN_HEIGHT));
  }

  return (
    <View style={[wrap, style as StyleProp<ViewStyle>, { height }]} onLayout={onLayout}>
      {width > 0 && fileUri && (
        <WebView
          source={{ uri: fileUri }}
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          // iOS-only: without this, RNWebView's loadFileURL:allowingReadAccessToURL:
          // defaults read access to the HTML file itself, not its containing
          // directory — every sibling fetch (the library's JS/CSS/DB/font) then
          // gets blocked and nothing renders. Android ignores this prop; it
          // already gets equivalent access via allowFileAccessFromFileURLs above.
          allowingReadAccessToURL={getMadinaBaseUri()}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          onMessage={onMessage}
          style={[webviewStyle, { width }]}
        />
      )}
    </View>
  );
}

const wrap: StyleProp<ViewStyle> = { width: '100%' };
const webviewStyle: StyleProp<ViewStyle> = { height: '100%', backgroundColor: 'transparent' };
