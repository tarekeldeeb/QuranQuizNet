const { withAndroidStyles } = require('@expo/config-plugins');

// Expo's internal splash-screen prebuild step unconditionally sets
// androidStatusBar.backgroundColor to match the splash background, then
// writes it into AppTheme as `android:statusBarColor`. That step runs after
// react-native-edge-to-edge's own Expo plugin (the one that sets AppTheme's
// parent to Theme.EdgeToEdge), whose cleanup pass is supposed to strip that
// exact attribute — so it survives into the final theme. `statusBarColor` is
// deprecated under edge-to-edge (Android 15+ ignores it and Play Console
// flags it as "deprecated APIs ... for edge-to-edge" / "may not display for
// all users"). Registered as the last plugin in app.config.js so this runs
// after both of those mods and removes it for good.
const DEPRECATED_EDGE_TO_EDGE_ITEMS = new Set([
  'android:statusBarColor',
  'android:navigationBarColor',
  'android:windowDrawsSystemBarBackgrounds',
  'android:fitsSystemWindows',
  'android:windowTranslucentStatus',
  'android:windowTranslucentNavigation',
  'android:enforceStatusBarContrast',
  'android:enforceNavigationBarContrast',
  'enforceNavigationBarContrast',
]);

module.exports = function withEdgeToEdgeStatusBarCleanup(config) {
  return withAndroidStyles(config, (config) => {
    config.modResults.resources.style = config.modResults.resources.style?.map((style) => {
      if (style.$.name === 'AppTheme' && style.item != null) {
        style.item = style.item.filter((item) => !DEPRECATED_EDGE_TO_EDGE_ITEMS.has(item.$.name));
      }
      return style;
    });
    return config;
  });
};
