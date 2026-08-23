import { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, radii } from '../theme/tokens';
import PressScale from './PressScale';

const DRAWER_WIDTH = 272;

export interface DrawerItem {
  key: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export function DrawerMenu({
  visible,
  onClose,
  items,
  footerItems,
}: {
  visible: boolean;
  onClose: () => void;
  items: DrawerItem[];
  footerItems?: DrawerItem[];
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const slideX = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const backdropFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideX, {
        toValue: visible ? 0 : -DRAWER_WIDTH,
        duration: visible ? 240 : 200,
        useNativeDriver: true,
      }),
      Animated.timing(backdropFade, {
        toValue: visible ? 1 : 0,
        duration: visible ? 240 : 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible]);

  function renderItem(item: DrawerItem) {
    const iconColor = item.destructive ? colors.wrong : colors.gold;
    const labelColor = item.destructive ? colors.wrong : colors.ink;
    return (
      <PressScale
        key={item.key}
        style={[s.item, { borderBottomColor: colors.line }]}
        onPress={() => { onClose(); item.onPress(); }}
      >
        <Ionicons name={item.icon} size={22} color={iconColor} />
        <Text style={[s.itemLabel, { color: labelColor }]}>{item.label}</Text>
        {!item.destructive && <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />}
      </PressScale>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={s.root}>
        <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: backdropFade }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            s.drawer,
            { backgroundColor: colors.card, paddingTop: insets.top + 12, transform: [{ translateX: slideX }] },
          ]}
        >
          <View style={[s.drawerHead, { borderBottomColor: colors.line }]}>
            <PressScale onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.inkSoft} />
            </PressScale>
          </View>

          <View style={s.navItems}>
            {items.map(renderItem)}
          </View>

          {footerItems && footerItems.length > 0 && (
            <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
              <View style={[s.footerSep, { backgroundColor: colors.line }]} />
              {footerItems.map(renderItem)}
            </View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  drawer: {
    position: 'absolute',
    top: 0, left: 0, bottom: 0,
    width: DRAWER_WIDTH,
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 16,
    flexDirection: 'column',
  },
  navItems: { flex: 1 },
  footer: { width: '100%' },
  drawerHead: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemLabel: { flex: 1, fontSize: 15, fontFamily: 'PlexArabic-SemiBold' },
  footerSep: { height: StyleSheet.hairlineWidth, marginTop: 8, marginBottom: 8 },
});
