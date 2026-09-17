/**
 * Root stack routes, declared once and consumed by RootStack.
 *
 * `transition` is platform-neutral on purpose: RootStack maps these names onto
 * expo-router's own `animation` vocabulary for the current platform.
 */
import { router, type Href } from 'expo-router';

export type ScreenTransition = 'slide' | 'fade' | 'modal';

export const ROOT_SCREENS: { name: string; transition: ScreenTransition }[] = [
  { name: '(tabs)', transition: 'fade' },
  { name: 'all-recipes', transition: 'slide' },
  // Crossfade: the search bar is in almost the same place on both screens, so
  // fading reads as the bar staying put while the page around it changes.
  { name: 'search', transition: 'fade' },
  { name: 'recipe/[id]', transition: 'slide' },
  { name: 'cooking/[id]', transition: 'modal' },
];

export const TRANSITION_DURATION = 280;

/**
 * `router.back()` silently does nothing when there is nothing to pop - a deep
 * link, a web reload landing straight on the screen, or a cold start - which
 * reads as a dead back arrow. Fall back to the home tab so it always moves.
 */
export function goBack(fallback: Href = '/'): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallback);
}
