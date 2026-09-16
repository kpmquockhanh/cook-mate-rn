import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StatusBar,
  Animated,
  ScrollView,
  Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTimer, ActiveTimer } from '../../lib/TimerContext';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useRecipe } from '../../hooks/useRecipe';
import LiveKitVoice from '../../components/LiveKitVoice';
import SoundWaves from '../../components/SoundWaves';
import { buildCookingState } from '../../lib/cookingContext';
import { useLiveKitToken } from '../../lib/livekitToken';

export default function CookingPage() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const recipeId = Array.isArray(id) ? id[0] : id || '1';

  const { data: recipeData, loading, error } = useRecipe({ id: recipeId });
  const statusBarHeight = Platform.OS === 'ios' ? 44 : RNStatusBar.currentHeight || 24;
  const { activeTimers, setActiveTimers } = useTimer();

  const [currentStep, setCurrentStep] = useState(0);
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [stepTimers, setStepTimers] = useState<{ [stepId: string]: string }>({});
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  // Assume the agent is there until the room tells us otherwise, so the banner
  // does not flicker during the normal join delay.
  const [agentAvailable, setAgentAvailable] = useState(true);

  // Per-user, per-recipe credentials from the livekit-token edge function.
  const { credentials: livekit, error: livekitError } = useLiveKitToken(recipeId);

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

  // Animation refs
  const stepTransitionAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

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
      if (!step) return 'No instruction available';
      return `Step ${index + 1} of ${steps.length}: ${step.instruction_text || 'No instruction available'}`;
    },
    [recipeData?.instructions]
  );

  const repeatCurrentStep = useCallback(
    () => describeStep(currentStep),
    [describeStep, currentStep]
  );

  const goToNextStep = useCallback(() => {
    const steps = recipeData?.instructions || [];
    if (currentStep >= steps.length - 1) {
      return `This is the last step. ${describeStep(currentStep)}`;
    }

    const nextStep = currentStep + 1;
    animateStepTransition();
    setCurrentStep(nextStep);
    return describeStep(nextStep);
  }, [currentStep, recipeData?.instructions, describeStep, animateStepTransition]);

  const goToPreviousStep = useCallback(() => {
    if (currentStep <= 0) {
      return `This is already the first step. ${describeStep(currentStep)}`;
    }

    const previousStep = currentStep - 1;
    animateStepTransition();
    setCurrentStep(previousStep);
    return describeStep(previousStep);
  }, [currentStep, describeStep, animateStepTransition]);

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
    const timerName = customName || `Step ${currentStep + 1}`;

    const newTimer: ActiveTimer = {
      id: `cooking-step-${currentStep}-${Date.now()}`,
      name: timerName,
      totalSeconds: seconds,
      remainingSeconds: seconds,
      status: 'running',
      priority: 'critical',
      emoji: '👨‍🍳',
    };

    setActiveTimers((prev) => [...prev, newTimer]);
    setStepTimers((prev) => ({ ...prev, [currentStep]: newTimer.id }));
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const steps = recipeData?.instructions || [];
  const currentStepData = steps[currentStep];

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

  // Show loading state
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <StatusBar barStyle="light-content" backgroundColor="primary" />
        <Text className="mb-4 text-lg text-gray-600">Loading recipe...</Text>
      </View>
    );
  }

  // Show error state
  if (error || !recipeData) {
    return (
      <View className="flex-1 items-center justify-center bg-primary px-6">
        <StatusBar barStyle="light-content" backgroundColor="#EA580C" />
        <Ionicons name="alert-circle-outline" size={64} color="#EF4444" />
        <Text className="mb-2 mt-4 text-xl font-semibold text-gray-800">Error Loading Recipe</Text>
        <Text className="mb-6 text-center text-gray-600">{error || 'Recipe not found'}</Text>
        <TouchableOpacity className="rounded-lg bg-primary px-6 py-3" onPress={() => router.back()}>
          <Text className="font-semibold text-white">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-white">
      <StatusBar barStyle="light-content" backgroundColor="primary" />

      {/* Header with Voice Controls */}
      <View className="bg-primary px-6 pt-4" style={{ paddingTop: statusBarHeight + 16 }}>
        <View className="mb-4 flex-row items-center justify-between">
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="close" size={28} color="white" />
          </TouchableOpacity>

          <Text
            className="mx-4 flex-1 text-center text-lg font-semibold text-white"
            numberOfLines={1}>
            {recipeData.title}
          </Text>

          {livekit ? (
            <LiveKitVoice
              serverUrl={livekit.serverUrl}
              token={livekit.token}
              cookingState={cookingState}
              onNextStep={goToNextStep}
              onPreviousStep={goToPreviousStep}
              onRepeatStep={repeatCurrentStep}
              onStarted={() => {
                setAgentAvailable(true);
                setVoiceEnabled(true);
              }}
              onEnded={() => setVoiceEnabled(false)}
              onAgentAvailabilityChange={setAgentAvailable}
            />
          ) : (
            <Ionicons
              name={livekitError ? 'alert-circle-outline' : 'ellipsis-horizontal-sharp'}
              size={24}
              color={livekitError ? '#FCA5A5' : 'white'}
            />
          )}
        </View>

        {/* Progress Bar */}
        <View className="mb-2 flex-row items-center">
          <View className="mr-3 h-2 flex-1 rounded-full bg-white/20">
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

        <Text className="pb-6 text-center text-sm text-white/80">
          Step {currentStep + 1} of {steps.length}
        </Text>

        {/* Voice/Listening Status */}
        {voiceEnabled && (
          <View>
            {agentAvailable ? (
              <>
                <View className="flex-row items-center justify-center">
                  <SoundWaves />
                </View>
                <View className="flex-row items-center justify-center">
                  <Ionicons name="mic" size={16} color="#FDE68A" />
                  <Text className="ml-2 text-sm text-white/90">Listening for commands...</Text>
                </View>
              </>
            ) : (
              <View className="flex-row items-center justify-center">
                <Ionicons name="cloud-offline-outline" size={16} color="#FDE68A" />
                <Text className="ml-2 text-sm text-white/90">
                  Assistant unavailable - use the buttons below
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Main Content */}
      <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
        {/* Current Step */}
        <Animated.View style={{ transform: [{ scale: stepTransitionAnim }] }}>
          <View className="mb-6 rounded-2xl bg-white p-6 shadow-lg">
            <View className="mb-4 flex-row items-start justify-between">
              <Text className="flex-1 text-2xl font-bold leading-8 text-gray-800">
                {currentStepData?.instruction_text || 'No instruction available'}
              </Text>
            </View>
            {/* Hint Card */}
            <View className="mt-2 rounded-xl border border-orange-100 bg-orange-50 p-4">
              <Text className="text-sm text-orange-700">
                Say &quot;next step&quot; or &quot;previous step&quot; to navigate
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* Step Ingredients */}
        {currentStepIngredients.length > 0 && (
          <View className="mb-6 rounded-2xl bg-white p-6 shadow-lg">
            <Text className="mb-4 text-lg font-semibold text-gray-800">
              Ingredients for this step
            </Text>

            {currentStepIngredients.map((ingredient) => (
              <TouchableOpacity
                key={ingredient.id}
                onPress={() => toggleIngredientCheck(ingredient.id)}
                className="flex-row items-center border-b border-gray-100 py-3 last:border-b-0">
                <View
                  className={`mr-4 h-6 w-6 items-center justify-center rounded border-2 ${
                    ingredient.checked ? 'border-green-500 bg-green-500' : 'border-gray-300'
                  }`}>
                  {ingredient.checked && <Ionicons name="checkmark" size={16} color="white" />}
                </View>
                <Text
                  className={`flex-1 text-base ${
                    ingredient.checked ? 'text-gray-500 line-through' : 'text-gray-800'
                  }`}>
                  {ingredient.ingredient_text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Timer Section */}
        {(currentStepData?.duration || currentStepTimer) && (
          <View className="mb-6 rounded-2xl bg-white p-6 shadow-lg">
            <Text className="mb-4 text-lg font-semibold text-gray-800">Timers</Text>

            {currentStepTimer ? (
              <View className="rounded-xl bg-blue-50 p-4">
                <View className="flex-row items-center justify-between">
                  <Text className="font-medium text-blue-900">{currentStepTimer.name}</Text>
                  <Text className="text-2xl font-bold text-blue-900">
                    {formatTime(currentStepTimer.remainingSeconds)}
                  </Text>
                </View>
                <View className="mt-2 h-2 rounded-full bg-blue-200">
                  <View
                    className="h-2 rounded-full bg-blue-600"
                    style={{
                      width: `${((currentStepTimer.totalSeconds - currentStepTimer.remainingSeconds) / currentStepTimer.totalSeconds) * 100}%`,
                    }}
                  />
                </View>
              </View>
            ) : (
              currentStepData?.duration && (
                <TouchableOpacity
                  onPress={() => startStepTimer(currentStepData.duration!)}
                  className="flex-row items-center justify-center rounded-xl bg-primary p-4">
                  <Ionicons name="timer-outline" size={24} color="white" />
                  <Text className="ml-3 text-lg font-semibold text-white">
                    Start Timer ({Math.floor(currentStepData.duration / 60)}m)
                  </Text>
                </TouchableOpacity>
              )
            )}
          </View>
        )}
      </ScrollView>

      {/* Enhanced Bottom Navigation with Voice Feedback */}
      <View className="border-t border-gray-200 bg-white px-6 py-4" style={{ paddingBottom: 16 }}>
        {/* Primary actions: Previous / Next */}
        <View className="mb-3 flex-row justify-between">
          <TouchableOpacity
            onPress={() => goToPreviousStep()}
            disabled={currentStep === 0}
            className={`flex-row items-center rounded-xl px-6 py-3 ${
              currentStep === 0 ? 'bg-gray-100' : 'bg-gray-200'
            }`}>
            <Ionicons
              name="chevron-back"
              size={20}
              color={currentStep === 0 ? '#9CA3AF' : '#374151'}
            />
            <Text
              className={`ml-2 font-medium ${
                currentStep === 0 ? 'text-gray-400' : 'text-gray-700'
              }`}>
              Say &quot;Back&quot;
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => goToNextStep()}
            disabled={currentStep === steps.length - 1}
            className={`flex-row items-center rounded-xl px-6 py-3 ${
              currentStep === steps.length - 1 ? 'bg-gray-100' : 'bg-primary'
            }`}>
            <Text
              className={`mr-2 font-medium ${
                currentStep === steps.length - 1 ? 'text-gray-400' : 'text-white'
              }`}>
              {currentStep === steps.length - 1 ? 'Finish' : 'Say "Next"'}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={20}
              color={currentStep === steps.length - 1 ? '#9CA3AF' : 'white'}
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
