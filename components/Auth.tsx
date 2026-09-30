import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  TextInput,
  TouchableOpacity,
  Text,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { useSignIn, useSignUp, useSSO } from '@clerk/expo';
import { describeClerkError } from '../lib/clerkErrors';
import { env } from '../lib/env';
import { useTranslation } from '../lib/i18n';

// Dev-only convenience: start the sign-in form filled in with a throwaway test
// account so signing in during development is one tap. Release builds always
// start empty, whatever is in .env.
const devEmail = __DEV__ ? env.devEmail : '';
const devPassword = __DEV__ ? env.devPassword : '';

// Lets the OAuth browser session hand its result back on web; a no-op on native.
WebBrowser.maybeCompleteAuthSession();

export default function Auth() {
  const { t } = useTranslation();
  const passwordRef = React.useRef<TextInput>(null);
  const confirmPasswordRef = React.useRef<TextInput>(null);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState(devEmail);
  const [password, setPassword] = useState(devPassword);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | 'confirmPassword' | null>(
    null
  );
  // Shown inline rather than through Alert.alert, which is a no-op on web.
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { startSSOFlow } = useSSO();
  // The code step serves both a new account's email verification and a
  // new-device check on sign-in; `codeFor` says which one to finish.
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [codeFor, setCodeFor] = useState<'signIn' | 'signUp'>('signUp');
  const [code, setCode] = useState('');

  // Android opens Custom Tabs noticeably faster when warmed up first.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  function showError(error: unknown) {
    const described = describeClerkError(error);
    setMessage({ kind: 'error', text: 'key' in described ? t(described.key) : described.text });
  }

  function openCodeStep(target: 'signIn' | 'signUp') {
    setCodeFor(target);
    setCode('');
    setStep('code');
  }

  const isSignUp = mode === 'signUp';

  function switchMode() {
    setMode(isSignUp ? 'signIn' : 'signUp');
    setConfirmPassword('');
    setStep('form');
    setMessage(null);
  }

  /** Returns an error message, or null when the form can be submitted. */
  function validate(): string | null {
    const trimmed = email.trim();
    if (!trimmed || !password) return t('auth.errorMissingFields');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return t('auth.errorInvalidEmail');
    if (isSignUp) {
      // Clerk's default minimum; checked here so the user gets it in their language.
      if (password.length < 8) return t('auth.errorPasswordTooShort');
      if (password !== confirmPassword) return t('auth.errorPasswordMismatch');
    }
    return null;
  }

  function submit() {
    if (loading) return;
    const error = validate();
    if (error) {
      setMessage({ kind: 'error', text: error });
      return;
    }
    if (isSignUp) signUpWithEmail();
    else signInWithEmail();
  }

  async function signInWithEmail() {
    Keyboard.dismiss();
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await signIn.password({ identifier: email.trim(), password });
      if (error) return showError(error);
      await continueSignIn();
    } finally {
      setLoading(false);
    }
  }

  /** Finishes a sign-in whose password (or code) was accepted, or asks for a code. */
  async function continueSignIn() {
    if (signIn.status === 'complete') {
      const { error } = await signIn.finalize();
      if (error) showError(error);
      return;
    }
    // A new device (Clerk "client trust") or an email second factor.
    if (signIn.status === 'needs_client_trust' || signIn.status === 'needs_second_factor') {
      const { error } = await signIn.mfa.sendEmailCode();
      if (error) return showError(error);
      openCodeStep('signIn');
      return;
    }
    showError(null);
  }

  async function signUpWithEmail() {
    Keyboard.dismiss();
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await signUp.password({ emailAddress: email.trim(), password });
      if (error) return showError(error);
      const { error: sendError } = await signUp.verifications.sendEmailCode();
      if (sendError) return showError(sendError);
      openCodeStep('signUp');
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode() {
    if (loading) return;
    if (!code.trim()) {
      setMessage({ kind: 'error', text: t('auth.errorCodeIncorrect') });
      return;
    }
    Keyboard.dismiss();
    setLoading(true);
    setMessage(null);
    try {
      if (codeFor === 'signUp') {
        const { error } = await signUp.verifications.verifyEmailCode({ code: code.trim() });
        if (error) return showError(error);
        if (signUp.status !== 'complete') return showError(null);
        const { error: finalizeError } = await signUp.finalize();
        if (finalizeError) showError(finalizeError);
      } else {
        const { error } = await signIn.mfa.verifyEmailCode({ code: code.trim() });
        if (error) return showError(error);
        await continueSignIn();
      }
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    if (loading) return;
    setMessage(null);
    const { error } =
      codeFor === 'signUp'
        ? await signUp.verifications.sendEmailCode()
        : await signIn.mfa.sendEmailCode();
    if (error) showError(error);
    else setMessage({ kind: 'info', text: t('auth.codeResent') });
  }

  function backToForm() {
    setStep('form');
    setCode('');
    setMessage(null);
  }

  async function signInWithGoogle() {
    if (loading) return;
    setLoading(true);
    setMessage(null);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: AuthSession.makeRedirectUri({ scheme: 'cookmate', path: 'sso-callback' }),
      });
      // No session means the user closed the browser: stay put, say nothing.
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.mainContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          bounces={false}>
          {/* Header Section with Gradient */}
          <LinearGradient
            colors={['#FF8A65', '#FF7043']}
            style={styles.headerGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}>
            <View style={styles.logoContainer}>
              <View style={styles.logoCircle}>
                <Ionicons name="restaurant" size={24} color="#FF8A65" />
              </View>
            </View>
            <Text style={styles.appTitle}>CookMate</Text>
            <Text style={styles.appSubtitle}>{t('auth.tagline')}</Text>
          </LinearGradient>

          {/* Content Section */}
          <View style={styles.contentContainer}>
            {step === 'form' && (
              <>
                <Text style={styles.welcomeTitle}>
                  {isSignUp ? t('auth.createAccount') : t('auth.welcome')}
                </Text>
                <Text style={styles.welcomeSubtitle}>
                  {isSignUp ? t('auth.createAccountSubtitle') : t('auth.welcomeSubtitle')}
                </Text>
              </>
            )}

            {message && (
              <View
                style={[
                  styles.messageBox,
                  message.kind === 'error' ? styles.messageError : styles.messageInfo,
                ]}>
                <Ionicons
                  name={message.kind === 'error' ? 'alert-circle-outline' : 'mail-unread-outline'}
                  size={18}
                  color={message.kind === 'error' ? '#B91C1C' : '#047857'}
                />
                <Text
                  style={[
                    styles.messageText,
                    { color: message.kind === 'error' ? '#B91C1C' : '#047857' },
                  ]}>
                  {message.text}
                </Text>
              </View>
            )}

            {step === 'form' ? (
              <>
                <TouchableOpacity
                  style={[styles.googleButton, loading && styles.buttonDisabled]}
                  disabled={loading}
                  onPress={signInWithGoogle}>
                  <Ionicons name="logo-google" size={18} color="#1F2937" />
                  <Text style={styles.googleButtonText}>{t('auth.continueWithGoogle')}</Text>
                </TouchableOpacity>

                <View style={styles.dividerRow}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>{t('auth.or')}</Text>
                  <View style={styles.dividerLine} />
                </View>

                {/* Email Input */}
                <View style={styles.inputSection}>
                  <Text style={styles.inputLabel}>{t('auth.emailLabel')}</Text>
                  <View
                    style={[
                      styles.inputContainer,
                      focusedField === 'email' && styles.inputContainerFocused,
                    ]}>
                    <Ionicons
                      name="mail-outline"
                      size={18}
                      color="#9CA3AF"
                      style={styles.inputIcon}
                    />
                    <TextInput
                      style={styles.textInput}
                      onChangeText={(text: string) => setEmail(text)}
                      onFocus={() => setFocusedField('email')}
                      onBlur={() => setFocusedField(null)}
                      value={email}
                      placeholder={t('auth.emailPlaceholder')}
                      placeholderTextColor="#9CA3AF"
                      autoCapitalize="none"
                      keyboardType="email-address"
                      autoComplete="email"
                      returnKeyType="next"
                      onSubmitEditing={() => passwordRef.current?.focus()}
                      blurOnSubmit={false}
                    />
                  </View>
                </View>

                {/* Password Input */}
                <View style={styles.inputSection}>
                  <Text style={styles.inputLabel}>{t('auth.passwordLabel')}</Text>
                  <View
                    style={[
                      styles.inputContainer,
                      focusedField === 'password' && styles.inputContainerFocused,
                    ]}>
                    <Ionicons
                      name="lock-closed-outline"
                      size={18}
                      color="#9CA3AF"
                      style={styles.inputIcon}
                    />
                    <TextInput
                      ref={passwordRef}
                      style={styles.textInput}
                      onChangeText={(text: string) => setPassword(text)}
                      onFocus={() => setFocusedField('password')}
                      onBlur={() => setFocusedField(null)}
                      value={password}
                      placeholder={t('auth.passwordPlaceholder')}
                      placeholderTextColor="#9CA3AF"
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoComplete={isSignUp ? 'new-password' : 'password'}
                      onSubmitEditing={() =>
                        isSignUp ? confirmPasswordRef.current?.focus() : submit()
                      }
                      returnKeyType={isSignUp ? 'next' : 'go'}
                      blurOnSubmit={!isSignUp}
                    />
                    <TouchableOpacity
                      onPress={() => setShowPassword(!showPassword)}
                      style={styles.eyeIcon}>
                      <Ionicons
                        name={showPassword ? 'eye-outline' : 'eye-off-outline'}
                        size={18}
                        color="#9CA3AF"
                      />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Confirm Password (sign up only) */}
                {isSignUp && (
                  <View style={styles.inputSection}>
                    <Text style={styles.inputLabel}>{t('auth.confirmPasswordLabel')}</Text>
                    <View
                      style={[
                        styles.inputContainer,
                        focusedField === 'confirmPassword' && styles.inputContainerFocused,
                      ]}>
                      <Ionicons
                        name="lock-closed-outline"
                        size={18}
                        color="#9CA3AF"
                        style={styles.inputIcon}
                      />
                      <TextInput
                        ref={confirmPasswordRef}
                        style={styles.textInput}
                        onChangeText={setConfirmPassword}
                        onFocus={() => setFocusedField('confirmPassword')}
                        onBlur={() => setFocusedField(null)}
                        value={confirmPassword}
                        placeholder={t('auth.confirmPasswordPlaceholder')}
                        placeholderTextColor="#9CA3AF"
                        secureTextEntry={!showPassword}
                        autoCapitalize="none"
                        autoComplete="new-password"
                        onSubmitEditing={submit}
                        returnKeyType="go"
                      />
                    </View>
                  </View>
                )}

                {/* Remember Me and Forgot Password (sign in only) */}
                {!isSignUp && (
                  <View style={styles.optionsRow}>
                    <TouchableOpacity
                      style={styles.rememberMeContainer}
                      onPress={() => setRememberMe(!rememberMe)}>
                      <View style={[styles.checkbox, rememberMe && styles.checkboxChecked]}>
                        {rememberMe && <Ionicons name="checkmark" size={12} color="#FFFFFF" />}
                      </View>
                      <Text style={styles.rememberMeText}>{t('auth.rememberMe')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity>
                      <Text style={styles.forgotPasswordText}>{t('auth.forgotPassword')}</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Sign In Button */}
                <TouchableOpacity
                  style={[styles.signInButton, loading && styles.buttonDisabled]}
                  disabled={loading}
                  onPress={submit}>
                  <LinearGradient
                    colors={['#FF8A65', '#FF7043']}
                    style={styles.signInButtonGradient}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}>
                    <Text style={styles.signInButtonText}>
                      {isSignUp
                        ? loading
                          ? t('auth.signingUp')
                          : t('auth.signUp')
                        : loading
                          ? t('auth.signingIn')
                          : t('auth.signIn')}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>

                {/* Sign Up Link */}
                <TouchableOpacity
                  style={styles.signUpContainer}
                  disabled={loading}
                  onPress={switchMode}>
                  <Text style={styles.signUpText}>
                    {isSignUp ? t('auth.haveAccount') : t('auth.noAccount')}
                    <Text style={styles.signUpLink}>
                      {isSignUp ? t('auth.signIn') : t('auth.signUp')}
                    </Text>
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.welcomeTitle}>{t('auth.verifyTitle')}</Text>
                <Text style={styles.welcomeSubtitle}>
                  {t('auth.verifyHint', { email: email.trim() })}
                </Text>

                <View style={styles.inputSection}>
                  <Text style={styles.inputLabel}>{t('auth.codeLabel')}</Text>
                  <View style={[styles.inputContainer, styles.inputContainerFocused]}>
                    <Ionicons
                      name="key-outline"
                      size={18}
                      color="#9CA3AF"
                      style={styles.inputIcon}
                    />
                    <TextInput
                      style={styles.textInput}
                      value={code}
                      onChangeText={setCode}
                      placeholder={t('auth.codePlaceholder')}
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                      autoComplete="one-time-code"
                      textContentType="oneTimeCode"
                      maxLength={6}
                      autoFocus
                      onSubmitEditing={verifyCode}
                      returnKeyType="go"
                    />
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.signInButton, loading && styles.buttonDisabled]}
                  disabled={loading}
                  onPress={verifyCode}>
                  <LinearGradient
                    colors={['#FF8A65', '#FF7043']}
                    style={styles.signInButtonGradient}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}>
                    <Text style={styles.signInButtonText}>
                      {loading ? t('auth.verifying') : t('auth.verifyButton')}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>

                <View style={styles.codeActionsRow}>
                  <TouchableOpacity disabled={loading} onPress={backToForm}>
                    <Text style={styles.signUpText}>{t('auth.backToForm')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity disabled={loading} onPress={resendCode}>
                    <Text style={styles.signUpLink}>{t('auth.resendCode')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  mainContainer: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  headerGradient: {
    paddingVertical: 60,
    alignItems: 'center',
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
  },
  logoContainer: {
    marginBottom: 12,
  },
  logoCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    borderStyle: 'dashed',
  },
  appTitle: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
    textAlign: 'center',
  },
  appSubtitle: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
  },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 4,
  },
  welcomeSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 24,
  },
  inputSection: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingHorizontal: 14,
    paddingVertical: 2,
  },
  inputContainerFocused: {
    borderColor: '#FF7043',
    backgroundColor: '#FFFFFF',
  },
  inputIcon: {
    marginRight: 10,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    color: '#1F2937',
    paddingVertical: 12,
    // The focus ring is drawn on inputContainer; without this, web draws its
    // own square outline around the bare <input> inside the rounded box.
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  eyeIcon: {
    padding: 4,
  },
  messageBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  messageError: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  messageInfo: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  messageText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  optionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  rememberMeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 3,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    marginRight: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#FF7043',
    borderColor: '#FF7043',
  },
  rememberMeText: {
    fontSize: 13,
    color: '#6B7280',
  },
  forgotPasswordText: {
    fontSize: 13,
    color: '#FF7043',
    fontWeight: '500',
  },
  signInButton: {
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 16,
  },
  signInButtonGradient: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  signInButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  signUpContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  signUpText: {
    fontSize: 13,
    color: '#6B7280',
  },
  signUpLink: {
    color: '#FF7043',
    fontWeight: '600',
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    marginBottom: 20,
  },
  googleButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E5E7EB',
  },
  dividerText: {
    fontSize: 13,
    color: '#9CA3AF',
  },
  codeActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
});
