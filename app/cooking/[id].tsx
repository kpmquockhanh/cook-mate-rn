import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StatusBar,
  Animated,
  ScrollView,
  ActivityIndicator,
  Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as Brightness from 'expo-brightness';
import * as Speech from 'expo-speech';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useTimer } from '../../lib/TimerContext';
import { useSettings } from '../../lib/SettingsContext';
import { logger } from '../../lib/log';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useRecipe } from '../../hooks/useRecipe';
import LiveKitVoice from '../../components/LiveKitVoice';
import SoundWaves from '../../components/SoundWaves';
import { buildCookingState } from '../../lib/cookingContext';
import { clearRecentCooking, saveRecentCooking } from '../../lib/recentCooking';
import { reportRecipeEvent } from '../../lib/recipeEvents';
import { useLiveKitToken } from '../../lib/livekitToken';
import {
  describeVoiceStatus,
  type VoiceSessionStatus,
  type VoiceStatus,
  type VoiceTone,
} from '../../lib/voiceSession';
import { speechLocaleFor, useTranslation } from '../../lib/i18n';

/**
 * NativeWind only registers a fixed list of react-native components for web
 * (react-native-css-interop/runtime/components.js) and `Animated.View` is not
 * on it, so className is dropped there while working fine on native. Animated
 * wrappers in this file therefore carry `style` only, with the layout classes
 * on a plain View inside.
 */

// Matches the stats card on the recipe detail screen so the two screens read as
// one product.
const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.12,
  shadowRadius: 12,
  elevation: 5,
} as const;

const PRIMARY = '#ff6b6b';
const SECONDARY = '#ff8e53';

// Width of one step pill plus its margin, used to keep the active pill in view.
const STEP_PILL_STRIDE = 48;

/**
 * The header is drawn behind a translucent status bar, so it needs the top
 * inset to clear it. `useSafeAreaInsets` reports 0 on web and on Android until
 * the provider has measured, which leaves the controls jammed against the top
 * edge - hence the platform floor.
 */
const FALLBACK_TOP_INSET = Platform.OS === 'ios' ? 44 : RNStatusBar.currentHeight || 24;

/** Tag for this screen's keep-awake lock, so it releases only its own. */
const KEEP_AWAKE_TAG = 'cookmate-cooking';

/** Brightness applied while cooking, when the setting is on. */
const COOKING_BRIGHTNESS = 1;

const log = logger('cooking');

/** Icon colour for the voice status banner and its header control. */
const VOICE_TONE_COLOR: Record<VoiceTone, string> = {
  neutral: 'rgba(255,255,255,0.9)',
  active: '#FDE68A',
  warn: '#FDE68A',
  error: '#FCA5A5',
};

export default function CookingPage() {
  const router = useRouter();
  const { t, language } = useTranslation();
  const { id } = useLocalSearchParams();
  const recipeId = Array.isArray(id) ? id[0] : id || '1';

  const { data: recipeData, loading, error } = useRecipe({ id: recipeId });
  const insets = useSafeAreaInsets();
  const headerTopInset = Math.max(insets.top, FALLBACK_TOP_INSET);
  const { activeTimers, startTimer } = useTimer();
  const { settings, isLoaded: settingsLoaded } = useSettings();

  const [currentStep, setCurrentStep] = useState(0);
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [stepTimers, setStepTimers] = useState<{ [stepId: string]: string }>({});

  // What the voice component last reported. It owns everything from 'ready'
  // onwards; the two states before that ('preparing', 'unavailable') belong to
  // the token fetch below, and the two are merged into `voiceStatus`.
  const [voiceSession, setVoiceSession] = useState<{
    status: VoiceSessionStatus;
    detail: string | null;
  }>({ status: 'ready', detail: null });

  const handleVoiceStatus = useCallback(
    (status: VoiceSessionStatus, detail: string | null) => setVoiceSession({ status, detail }),
    []
  );

  // Per-user, per-recipe credentials from the livekit-token edge function.
  // Passing null while the assistant is off (or before the setting has been
  // read) is what stops a token being minted for a user who never wanted one.
  const voiceEnabled = settingsLoaded && settings.voiceEnabled;
  const {
    credentials: livekit,
    loading: livekitLoading,
    error: livekitError,
    refresh: refreshLivekit,
  } = useLiveKitToken(voiceEnabled ? recipeId : null);

  // Without credentials there is nothing to connect to, so the token fetch's own
  // state is what the user needs to see. With them, the session state is.
  const voiceStatus: VoiceStatus = !settingsLoaded
    ? 'preparing'
    : !settings.voiceEnabled
      ? 'disabled'
      : livekit
        ? voiceSession.status
        : livekitLoading
          ? 'preparing'
          : 'unavailable';
  const voiceDetail = livekit ? voiceSession.detail : livekitError;
  const voiceCopy = describeVoiceStatus(voiceStatus, voiceDetail, t);
  const voiceListening = voiceStatus === 'listening';

  // This screen is normally pushed from the recipe detail screen, but a deep
  // link or a dev-mode reload can land here as the stack's only entry, where
  // `router.back()` has nothing to pop and React Navigation warns. Falling
  // back to the recipe detail screen keeps "go back" meaningful either way.
  const exitCooking = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(`/recipe/${recipeId}`);
    }
  }, [router, recipeId]);

  // Update ingredients when recipe data changes
  useEffect(() => {
    if (recipeData?.ingredients) {
      setIngredients(
        recipeData.ingredients.map((ing: any) => ({
          ...ing,
          checked: false,
        }))
      );
    }
  }, [recipeData]);

  // Hold the display on for the session. Tagged rather than using
  // `useKeepAwake`, because the hook cannot be turned off by a preference -
  // hooks cannot be called conditionally, and the lock has to be released the
  // moment the user switches the setting off, not on unmount.
  useEffect(() => {
    if (!settings.keepScreenAwake) return;

    // Unsupported browsers reject rather than no-op, and a screen that dims is
    // not worth an error dialog over.
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((e) =>
      log.warn('Could not keep the screen awake', e)
    );

    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch((e) =>
        log.warn('Could not release the keep-awake lock', e)
      );
    };
  }, [settings.keepScreenAwake]);

  // Brighten the screen for a phone propped up across the counter. This is the
  // app's own brightness, not the system's: it needs no permission and the OS
  // drops it as soon as the app is backgrounded, so a forgotten session cannot
  // leave the device at full brightness.
  useEffect(() => {
    if (!settings.boostBrightness || Platform.OS === 'web') return;

    let cancelled = false;
    Brightness.setBrightnessAsync(COOKING_BRIGHTNESS).catch((e) => {
      if (!cancelled) log.warn('Could not raise the brightness', e);
    });

    return () => {
      cancelled = true;
      Brightness.restoreSystemBrightnessAsync().catch((e) =>
        log.warn('Could not restore the brightness', e)
      );
    };
  }, [settings.boostBrightness]);

  // Animation refs
  const stepTransitionAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const stepStripRef = useRef<ScrollView>(null);

  // Update progress animation when step changes
  useEffect(() => {
    const steps = recipeData?.instructions || [];
    const progress = steps.length > 0 ? (currentStep + 1) / steps.length : 0;
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [currentStep, recipeData?.instructions, progressAnim]);

  // Keep the active pill on screen when the step changes by voice, where the
  // user never touches the strip themselves.
  useEffect(() => {
    stepStripRef.current?.scrollTo({
      x: Math.max(0, currentStep * STEP_PILL_STRIDE - STEP_PILL_STRIDE * 2),
      animated: true,
    });
  }, [currentStep]);

  const animateStepTransition = useCallback(() => {
    Animated.sequence([
      Animated.timing(stepTransitionAnim, {
        toValue: 0.95,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(stepTransitionAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();
  }, [stepTransitionAnim]);

  // Returned to the voice agent as the RPC result so it can read the resulting
  // step aloud instead of inventing its own confirmation.
  const describeStep = useCallback(
    (index: number) => {
      const steps = recipeData?.instructions || [];
      const step = steps[index];
      if (!step) return t('cooking.noInstruction');
      return t('cooking.describeStep', {
        current: index + 1,
        total: steps.length,
        text: step.instruction_text || t('cooking.noInstruction'),
      });
    },
    [recipeData?.instructions, t]
  );

  const repeatCurrentStep = useCallback(
    () => describeStep(currentStep),
    [describeStep, currentStep]
  );

  const goToNextStep = useCallback(() => {
    const steps = recipeData?.instructions || [];
    if (currentStep >= steps.length - 1) {
      return t('cooking.lastStep', { step: describeStep(currentStep) });
    }

    const nextStep = currentStep + 1;
    animateStepTransition();
    setCurrentStep(nextStep);
    return describeStep(nextStep);
  }, [currentStep, recipeData?.instructions, describeStep, animateStepTransition, t]);

  const goToPreviousStep = useCallback(() => {
    if (currentStep <= 0) {
      return t('cooking.firstStep', { step: describeStep(currentStep) });
    }

    const previousStep = currentStep - 1;
    animateStepTransition();
    setCurrentStep(previousStep);
    return describeStep(previousStep);
  }, [currentStep, describeStep, animateStepTransition, t]);

  const jumpToStep = (index: number) => {
    if (index === currentStep) return;
    animateStepTransition();
    setCurrentStep(index);
  };

  const toggleIngredientCheck = (ingredientId: string) => {
    setIngredients((prev) =>
      prev.map((ingredient) =>
        ingredient.id === ingredientId
          ? { ...ingredient, checked: !ingredient.checked }
          : ingredient
      )
    );
  };

  const startStepTimer = (seconds: number, customName?: string) => {
    // Through the context's own helper, so this timer gets the same wall-clock
    // end time as one started from the timer tab and stays accurate while the
    // app is backgrounded.
    const id = startTimer({
      name: customName || t('cooking.stepTimerName', { number: currentStep + 1 }),
      seconds,
      emoji: '👨‍🍳',
    });
    setStepTimers((prev) => ({ ...prev, [currentStep]: id }));
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const steps = recipeData?.instructions || [];
  const currentStepData = steps[currentStep];
  const isLastStep = steps.length > 0 && currentStep === steps.length - 1;
  const progressPercent =
    steps.length > 0 ? Math.round(((currentStep + 1) / steps.length) * 100) : 0;

  // Cooking Mode opened: the weaker of the two signals, but the one that says
  // someone meant to cook this rather than read it.
  useEffect(() => {
    if (recipeId) reportRecipeEvent(recipeId, 'started');
  }, [recipeId]);

  // Stepping back off the last step and onto it again is one cook, not two.
  const completedReportedFor = useRef<string | null>(null);

  // Remember where this session got to, so home can offer to come back to it.
  // Written on every step change rather than on unmount: cooking screens are
  // left by walking away from the phone as often as by tapping Close, and an
  // unmount handler never runs when the app is killed from the background.
  useEffect(() => {
    if (!recipeData || steps.length === 0) return;
    // The last step is the end of the recipe, not a place to resume from - and
    // reaching it is the only event that means someone actually cooked this,
    // which is what the "most cooked" rail counts.
    if (currentStep >= steps.length - 1) {
      clearRecentCooking();
      if (completedReportedFor.current !== recipeId) {
        completedReportedFor.current = recipeId;
        reportRecipeEvent(recipeId, 'completed');
      }
      return;
    }
    saveRecentCooking({
      id: String(recipeId),
      title: recipeData.title,
      thumbnail: recipeData.thumbnail,
      step: currentStep + 1,
      totalSteps: steps.length,
    });
  }, [recipeId, recipeData, currentStep, steps.length]);

  // Published to the voice agent so it knows the recipe and follows the user's
  // position, whether they navigated by voice or by tapping.
  const cookingState = useMemo(
    () => buildCookingState(recipeData, currentStep),
    [recipeData, currentStep]
  );
  const currentStepIngredients = ingredients.filter(
    (ing) =>
      currentStepData?.ingredients?.some((stepIng: string) =>
        ing.ingredient_text?.toLowerCase().includes(stepIng.toLowerCase())
      ) || false
  );

  const currentStepTimer = stepTimers[currentStep]
    ? activeTimers.find((timer) => timer.id === stepTimers[currentStep])
    : null;

  // Read the step aloud with the device's own synthesiser. Suppressed while the
  // LiveKit agent is connected: the agent narrates steps itself, and two voices
  // reading the same instruction over each other is worse than neither.
  const stepText = currentStepData?.instruction_text;
  useEffect(() => {
    if (!settings.spokenSteps || voiceListening || !stepText) return;

    // Cut off whatever is still being said: on a fast double-tap through the
    // steps the queue would otherwise read every step the user skipped.
    Speech.stop();
    // The locale matters as much as the words: without it the platform reads
    // Vietnamese text with an English voice.
    Speech.speak(t('cooking.spokenStep', { number: currentStep + 1, text: stepText }), {
      rate: settings.speechRate,
      language: speechLocaleFor(language),
    });

    return () => {
      Speech.stop();
    };
  }, [
    settings.spokenSteps,
    settings.speechRate,
    voiceListening,
    stepText,
    currentStep,
    t,
    language,
  ]);

  // Circular control that stays legible over the gradient header.
  const headerButton = (
    icon: React.ComponentProps<typeof Ionicons>['name'],
    onPress: () => void,
    color = 'white'
  ) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      className="h-11 w-11 items-center justify-center rounded-full bg-white/20">
      <Ionicons name={icon} size={22} color={color} />
    </TouchableOpacity>
  );

  // Show loading state
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <StatusBar barStyle="dark-content" />
        <ActivityIndicator size="large" color={PRIMARY} />
        <Text className="mt-4 text-base text-gray-500">{t('recipe.loading')}</Text>
      </View>
    );
  }

  // Show error state
  if (error || !recipeData) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-6">
        <StatusBar barStyle="dark-content" />
        <Ionicons name="alert-circle-outline" size={64} color="#EF4444" />
        <Text className="mb-2 mt-4 text-xl font-semibold text-gray-800">
          {t('recipe.loadError')}
        </Text>
        <Text className="mb-6 text-center text-gray-600">{error || t('recipe.notFound')}</Text>
        <TouchableOpacity className="rounded-lg bg-primary px-6 py-3" onPress={exitCooking}>
          <Text className="font-semibold text-white">{t('common.goBack')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-white">
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Header */}
      <LinearGradient
        colors={[PRIMARY, SECONDARY]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          paddingTop: headerTopInset + 12,
          paddingHorizontal: 20,
          paddingBottom: 20,
          borderBottomLeftRadius: 24,
          borderBottomRightRadius: 24,
        }}>
        <View className="flex-row items-center justify-between">
          {headerButton('close', exitCooking)}

          <View className="mx-3 flex-1">
            <Text className="text-center text-xs font-semibold uppercase tracking-wide text-white/70">
              {t('cooking.header')}
            </Text>
            <Text className="text-center text-lg font-bold text-white" numberOfLines={1}>
              {recipeData.title}
            </Text>
          </View>

          {livekit ? (
            <View className="h-11 w-11 items-center justify-center rounded-full bg-white/20">
              <LiveKitVoice
                serverUrl={livekit.serverUrl}
                token={livekit.token}
                cookingState={cookingState}
                onNextStep={goToNextStep}
                onPreviousStep={goToPreviousStep}
                onRepeatStep={repeatCurrentStep}
                autoStart={settings.voiceAutoStart}
                onStatusChange={handleVoiceStatus}
              />
            </View>
          ) : (
            // No credentials yet: the control retries the fetch rather than
            // sitting there as an icon the user cannot act on.
            <TouchableOpacity
              onPress={() => {
                if (!livekitLoading) refreshLivekit();
              }}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={voiceCopy.label}
              className="h-11 w-11 items-center justify-center rounded-full bg-white/20">
              <Ionicons name={voiceCopy.icon} size={22} color={VOICE_TONE_COLOR[voiceCopy.tone]} />
            </TouchableOpacity>
          )}
        </View>

        {/* Progress */}
        <View className="mt-5">
          <View className="mb-2 flex-row items-baseline justify-between">
            <Text className="text-sm font-semibold text-white">
              {t('cooking.progress', { current: currentStep + 1, total: steps.length })}
            </Text>
            <Text className="text-xs text-white/70">
              {t('cooking.percentDone', { percent: progressPercent })}
            </Text>
          </View>

          <View className="h-2 w-full overflow-hidden rounded-full bg-white/25">
            {/* Inline style, not className: NativeWind does not register
                Animated components for web, so className is dropped there. */}
            <Animated.View
              style={{
                height: 8,
                borderRadius: 9999,
                backgroundColor: '#fff',
                width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              }}
            />
          </View>
        </View>

        {/* Voice status. Always shown: before this the screen only spoke up once
            a session was already running, so "ready to use" and "silently
            broken" looked exactly the same - like nothing at all. */}
        <View className="mt-4 items-center">
          <TouchableOpacity
            // The banner only ever retries the token fetch. Once credentials
            // exist the retry is the header mic - the copy says so - so the
            // banner goes back to being a label.
            disabled={!voiceCopy.canRetry || !!livekit}
            onPress={() => {
              if (!livekitLoading) refreshLivekit();
            }}
            activeOpacity={0.8}
            accessibilityRole={voiceCopy.canRetry && !livekit ? 'button' : 'text'}
            accessibilityLabel={voiceCopy.label}
            className="max-w-full items-center rounded-2xl bg-white/15 px-4 py-2">
            {voiceListening && <SoundWaves />}
            <View className="flex-row items-center">
              <Ionicons name={voiceCopy.icon} size={14} color={VOICE_TONE_COLOR[voiceCopy.tone]} />
              <Text
                className="ml-2 flex-shrink text-xs font-medium text-white/90"
                numberOfLines={2}>
                {voiceCopy.label}
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Main Content */}
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: 20, paddingBottom: 32 }}>
        {/* The card cannot be pulled up over the header the way the recipe
            screen overlaps its hero: there, hero and card share one ScrollView,
            whereas this header is a sibling outside it, so a negative margin
            here is clipped by the ScrollView's own bounds. */}
        <Animated.View style={{ transform: [{ scale: stepTransitionAnim }] }}>
          <View className="mx-5 rounded-2xl bg-white p-5" style={CARD_SHADOW}>
            <View className="mb-4 flex-row items-center">
              <View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-primary">
                <Text className="text-sm font-bold text-white">{currentStep + 1}</Text>
              </View>
              <Text className="flex-1 text-sm font-semibold uppercase tracking-wide text-gray-400">
                {t('cooking.currentStep')}
              </Text>
              {currentStepData?.duration ? (
                <View className="flex-row items-center rounded-full bg-gray-100 px-3 py-1">
                  <Ionicons name="timer-outline" size={14} color="#6B7280" />
                  <Text className="ml-1 text-xs font-medium text-gray-600">
                    {t('duration.minutes', {
                      count: Math.round(currentStepData.duration / 60),
                    })}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text className="text-2xl font-bold leading-9 text-gray-800">
              {currentStepData?.instruction_text || t('cooking.noInstruction')}
            </Text>

            {/* Only while the agent is actually listening. Shown unconditionally
                it told users to talk to an assistant that was not connected. */}
            {voiceListening && (
              <View className="mt-5 flex-row rounded-2xl bg-orange-50 p-4">
                <Ionicons name="mic-outline" size={20} color={SECONDARY} />
                <Text className="ml-3 flex-1 text-sm leading-6 text-gray-700">
                  {t('cooking.voiceHint')}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>

        {/* Step Strip */}
        {steps.length > 1 && (
          <View className="pt-6">
            <Text className="mb-3 px-5 text-base font-semibold text-gray-800">
              {t('cooking.allSteps', { count: steps.length })}
            </Text>
            <ScrollView
              ref={stepStripRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20 }}>
              {steps.map((step, index: number) => {
                const isCurrent = index === currentStep;
                const isDone = index < currentStep;
                return (
                  /* Pressable rather than TouchableOpacity: onPress re-renders this button
                 with a new style, which strands TouchableOpacity's fade-back animation
                 and leaves the selected item washed out. Keep the style a plain
                 object/array -- NativeWind's jsx runtime ignores ({ pressed }) => []. */
                  <Pressable
                    key={step.id ?? index}
                    onPress={() => jumpToStep(index)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isCurrent }}
                    className="mr-2 h-10 w-10 items-center justify-center rounded-full"
                    style={{
                      backgroundColor: isCurrent ? PRIMARY : isDone ? '#FFEDE8' : '#F3F4F6',
                    }}>
                    {isDone ? (
                      <Ionicons name="checkmark" size={18} color={PRIMARY} />
                    ) : (
                      <Text
                        className="text-sm font-semibold"
                        style={{ color: isCurrent ? '#fff' : '#6B7280' }}>
                        {index + 1}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* Step Ingredients */}
        {currentStepIngredients.length > 0 && (
          <View className="px-5 pt-7">
            <View className="mb-1 flex-row items-baseline justify-between">
              <Text className="text-xl font-semibold text-gray-800">
                {t('cooking.youWillNeed')}
              </Text>
              <Text className="text-sm text-gray-400">
                {t('cooking.ingredientCount', { count: currentStepIngredients.length })}
              </Text>
            </View>

            {currentStepIngredients.map((ingredient) => (
              <TouchableOpacity
                key={ingredient.id}
                onPress={() => toggleIngredientCheck(ingredient.id)}
                activeOpacity={0.7}
                className="flex-row items-center border-b border-gray-100 py-3.5">
                <View
                  className={`mr-4 h-6 w-6 items-center justify-center rounded-md border-2 ${
                    ingredient.checked ? 'border-primary bg-primary' : 'border-gray-300'
                  }`}>
                  {ingredient.checked && <Ionicons name="checkmark" size={15} color="white" />}
                </View>
                <Text
                  className={`flex-1 text-base ${
                    ingredient.checked ? 'text-gray-400 line-through' : 'text-gray-800'
                  }`}>
                  {ingredient.ingredient_text}
                </Text>
                {ingredient.amount ? (
                  <Text
                    className={`ml-3 text-sm font-medium ${
                      ingredient.checked ? 'text-gray-300' : 'text-gray-500'
                    }`}>
                    {ingredient.amount}
                  </Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Timer Section */}
        {(currentStepData?.duration || currentStepTimer) && (
          <View className="px-5 pt-7">
            <Text className="mb-3 text-xl font-semibold text-gray-800">{t('cooking.timer')}</Text>

            {currentStepTimer ? (
              <View className="rounded-2xl bg-white p-5" style={CARD_SHADOW}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <Ionicons name="timer-outline" size={20} color={PRIMARY} />
                    <Text className="ml-2 text-base font-medium text-gray-700">
                      {currentStepTimer.name}
                    </Text>
                  </View>
                  <Text className="text-3xl font-bold text-gray-800">
                    {formatTime(currentStepTimer.remainingSeconds)}
                  </Text>
                </View>
                <View className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                  <View
                    className="h-2 rounded-full bg-primary"
                    style={{
                      width: `${((currentStepTimer.totalSeconds - currentStepTimer.remainingSeconds) / currentStepTimer.totalSeconds) * 100}%`,
                    }}
                  />
                </View>
              </View>
            ) : (
              currentStepData?.duration && (
                <TouchableOpacity
                  className="overflow-hidden rounded-2xl"
                  activeOpacity={0.9}
                  onPress={() => startStepTimer(currentStepData.duration!)}>
                  <LinearGradient
                    colors={[PRIMARY, SECONDARY]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingVertical: 16,
                    }}>
                    <Ionicons name="timer-outline" size={22} color="white" />
                    <Text className="ml-2 text-lg font-semibold text-white">
                      {t('cooking.startStepTimer', {
                        count: Math.round(currentStepData.duration / 60),
                      })}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>
              )
            )}
          </View>
        )}
      </ScrollView>

      {/* Bottom Navigation */}
      <View
        className="border-t border-gray-100 bg-white px-5 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}>
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => goToPreviousStep()}
            disabled={currentStep === 0}
            activeOpacity={0.8}
            className={`mr-3 h-14 w-14 items-center justify-center rounded-2xl border ${
              currentStep === 0 ? 'border-gray-100 bg-gray-50' : 'border-gray-300'
            }`}>
            <Ionicons
              name="chevron-back"
              size={22}
              color={currentStep === 0 ? '#D1D5DB' : '#374151'}
            />
          </TouchableOpacity>

          <TouchableOpacity
            // The last step used to be a dead end: a disabled "Finish" that did
            // nothing. It now closes the session and returns to the recipe.
            onPress={() => (isLastStep ? exitCooking() : goToNextStep())}
            activeOpacity={0.9}
            className="h-14 flex-1 overflow-hidden rounded-2xl">
            <LinearGradient
              colors={isLastStep ? ['#4ecdc4', '#2fb3aa'] : [PRIMARY, SECONDARY]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <Text className="mr-2 text-lg font-semibold text-white">
                {isLastStep ? t('cooking.finish') : t('cooking.nextStep')}
              </Text>
              <Ionicons
                name={isLastStep ? 'checkmark-circle' : 'chevron-forward'}
                size={22}
                color="white"
              />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
