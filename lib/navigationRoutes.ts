/**
 * Stack routes, declared once and consumed by RootStack.
 *
 * `transition` is platform-neutral on purpose: RootStack maps these names onto
 * expo-router's own `animation` vocabulary for the current platform.
 */
import { router, type Href } from 'expo-router';

export type ScreenTransition = 'slide' | 'fade' | 'modal';

export type StackScreen = { name: string; transition: ScreenTransition };

// Cooking mode sits above the tabs: it has its own bottom controls, and a tab
// bar under them would crowd the screen and invite mis-taps mid-recipe.
export const ROOT_SCREENS: StackScreen[] = [
  { name: '(tabs)', transition: 'fade' },
  { name: 'cooking/[id]', transition: 'modal' },
  // Development only: the wake-word spike and model parity checks. The screen
  // itself refuses to render outside __DEV__.
  { name: 'dev/wake-word', transition: 'slide' },
];

// Lives inside the Home tab rather than the root stack, so the tab bar stays
// visible on these screens.
export const HOME_SCREENS: StackScreen[] = [
  { name: 'index', transition: 'fade' },
  { name: 'all-recipes', transition: 'slide' },
  { name: 'recipe/[id]', transition: 'slide' },
];

/**
 * The tab bar floats over the bottom of each screen: it is TAB_BAR_HEIGHT tall
 * but screens only stop TAB_SCENE_INSET short of the bottom edge. Screens with
 * their own bottom-anchored controls pad by the difference to clear it.
 */
export const TAB_BAR_HEIGHT = 80;
export const TAB_SCENE_INSET = 40;
export const TAB_BAR_OVERLAP = TAB_BAR_HEIGHT - TAB_SCENE_INSET;

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
