import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onReconnect, retryNow, useConnectivity } from '../lib/connectivity';
import { useTranslation } from '../lib/i18n';

/** How long "Back online" stays up after the connection returns. */
const RESTORED_MS = 2_000;
/** Longer than any backoff, so a countdown read against a stale clock is hidden. */
const MAX_COUNTDOWN_MS = 30_000;

/**
 * A floating pill under the status bar while the API is unreachable, telling
 * the user why nothing is loading and when the app will try again, with a
 * button to try now. Screens do not render their own "you're offline" state -
 * they keep what they had and reload on reconnect (see lib/connectivity.ts).
 */
export default function ConnectionBanner() {
  const { status, checking, nextRetryAt } = useConnectivity();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(() => Date.now());
  const [showRestored, setShowRestored] = useState(false);

  // Tick the countdown only while there is one to show.
  useEffect(() => {
    if (!nextRetryAt) return;
    const tick = () => setNow(Date.now());
    // `now` is from the last countdown, possibly long ago; catch up at once.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [nextRetryAt]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onReconnect(() => {
      setShowRestored(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShowRestored(false), RESTORED_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const down = status !== 'online';
  if (!down && !showRestored) return null;

  const seconds =
    nextRetryAt && nextRetryAt - now <= MAX_COUNTDOWN_MS
      ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000))
      : 0;
  const detail = checking
    ? t('connection.checking')
    : seconds > 0
      ? t('connection.retryingIn', { seconds })
      : null;

  return (
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + 8 }]}>
      <Animated.View
        key={down ? 'down' : 'restored'}
        entering={FadeInUp.duration(200)}
        exiting={FadeOutUp.duration(200)}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[styles.pill, down ? styles.pillDown : styles.pillRestored]}>
        <Ionicons
          name={
            !down
              ? 'checkmark-circle'
              : status === 'offline'
                ? 'cloud-offline-outline'
                : 'server-outline'
          }
          size={18}
          color="#fff"
        />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {!down
              ? t('connection.restored')
              : status === 'offline'
                ? t('connection.offline')
                : t('connection.serverDown')}
          </Text>
          {down && !!detail && <Text style={styles.detail}>{detail}</Text>}
        </View>
        {down &&
          (checking ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Pressable
              onPress={retryNow}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => [styles.retry, pressed && { opacity: 0.7 }]}>
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </Pressable>
          ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 420,
    width: '100%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  pillDown: { backgroundColor: '#1F2937' },
  pillRestored: { backgroundColor: '#059669' },
  text: { flex: 1 },
  title: { color: '#fff', fontSize: 14, fontWeight: '600' },
  detail: { color: '#D1D5DB', fontSize: 12, marginTop: 1 },
  retry: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  retryText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
