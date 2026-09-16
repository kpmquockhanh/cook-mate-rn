/**
 * Root stack routes, declared once and consumed by both stack implementations.
 *
 * `transition` is platform-neutral on purpose: react-native-screens has no web
 * implementation (Screen.web.js just toggles `display`), so web renders these
 * through @react-navigation/stack instead. Each stack maps these names onto its
 * own animation vocabulary.
 */
export type ScreenTransition = 'slide' | 'fade' | 'modal';

export const ROOT_SCREENS: { name: string; transition: ScreenTransition }[] = [
  { name: '(tabs)', transition: 'fade' },
  { name: 'all-recipes', transition: 'slide' },
  { name: 'recipe/[id]', transition: 'slide' },
  { name: 'cooking/[id]', transition: 'modal' },
];

export const TRANSITION_DURATION = 280;
