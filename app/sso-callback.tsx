import { Redirect } from 'expo-router';

/**
 * Google sign-in returns to cookmate://sso-callback. The browser session hands
 * the result to Clerk before this renders; the route only exists so the deep
 * link lands somewhere instead of on Expo Router's unmatched-route screen.
 */
export default function SsoCallback() {
  return <Redirect href="/" />;
}
