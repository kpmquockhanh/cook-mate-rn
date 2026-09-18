import { Alert, Platform } from 'react-native';
import { t } from '../lib/i18n/translate';

/**
 * A yes/no prompt that works on every platform the app builds for.
 *
 * `Alert` is a no-op under react-native-web, so a destructive action guarded by
 * it there simply does nothing when tapped - the user reads that as a broken
 * button, not as a cancelled action. The browser's own `confirm` is blocking
 * and ugly, but it is the one dialog that is always there.
 */
export function confirmAction({
  title,
  message,
  // Defaulted in the body rather than in the signature so the fallback follows
  // the language rather than whatever it was when the module loaded.
  confirmLabel,
  cancelLabel,
  destructive = false,
}: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    const text = message ? `${title}\n\n${message}` : title;
    return Promise.resolve(
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(text)
        : true
    );
  }

  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel ?? t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmLabel ?? t('common.ok'),
        style: destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

/** The same platform split for a one-button notice. */
export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return;
  }
  Alert.alert(title, message);
}
