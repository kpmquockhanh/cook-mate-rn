import React, { useState, useEffect, useRef } from 'react';
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
import * as Speech from 'expo-speech';
import WebRTC from '../../components/WebRTC';
import SoundWaves from '../../components/SoundWaves';

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

  // Update ingredients when recipe data changes
  useEffect(() => {
    if (recipeData?.ingredients) {
      setIngredients(recipeData.ingredients.map((ing: any) => ({
        ...ing,
        checked: false
      })));
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

  // Voice synthesis function
  const speak = (text: string, options?: Speech.SpeechOptions) => {
    if (voiceEnabled) {
      // Speech.speak(text, {
      //   language: 'en',
      //   pitch: 1.0,
      //   rate: 1.0,
      //   ...options
      // });
    }
  };

  // Repeat current step with voice
  const repeatCurrentStep = () => {
    const instruction = currentStepData?.instruction_text || 'No instruction available';
    speak(`Step ${currentStep + 1}: ${instruction}`);
  };

  // Enhanced step navigation with voice feedback
  const goToNextStep = () => {
    const steps = recipeData?.instructions || [];
    if (currentStep < steps.length - 1) {
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

      setCurrentStep(prev => prev + 1);
    } else {
      speak("You've completed all steps! Great job!");
    }
  };

  const goToPreviousStep = () => {
    if (currentStep > 0) {
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

      setCurrentStep(prev => prev - 1);
    }
  };

  const toggleIngredientCheck = (ingredientId: string) => {
    setIngredients(prev =>
      prev.map(ingredient =>
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

    setActiveTimers(prev => [...prev, newTimer]);
    setStepTimers(prev => ({ ...prev, [currentStep]: newTimer.id }));
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const steps = recipeData?.instructions || [];
  const currentStepData = steps[currentStep];
  const currentStepIngredients = ingredients.filter(ing =>
    currentStepData?.ingredients?.some((stepIng: string) =>
      ing.ingredient_text?.toLowerCase().includes(stepIng.toLowerCase())
    ) || false
  );

  const currentStepTimer = stepTimers[currentStep]
    ? activeTimers.find(timer => timer.id === stepTimers[currentStep])
    : null;

  // Auto-speak when step changes
  useEffect(() => {
    if (recipeData?.instructions?.[currentStep]) {
      const instruction = recipeData?.instructions[currentStep].instruction_text;
      speak(`Step ${currentStep + 1}: ${instruction}`);
    }
  }, [currentStep, recipeData?.instructions]);

  // Show loading state
  if (loading) {
    return (
      <View className="flex-1 bg-white justify-center items-center">
        <StatusBar barStyle="light-content" backgroundColor="primary" />
        <Text className="text-lg text-gray-600 mb-4">Loading recipe...</Text>
      </View>
    );
  }

  // Show error state
  if (error || !recipeData) {
    return (
      <View className="flex-1 bg-primary justify-center items-center px-6">
        <StatusBar barStyle="light-content" backgroundColor="#EA580C" />
        <Ionicons name="alert-circle-outline" size={64} color="#EF4444" />
        <Text className="text-xl font-semibold text-gray-800 mt-4 mb-2">Error Loading Recipe</Text>
        <Text className="text-gray-600 text-center mb-6">{error || 'Recipe not found'}</Text>
        <TouchableOpacity
          className="bg-primary px-6 py-3 rounded-lg"
          onPress={() => router.back()}>
          <Text className="text-white font-semibold">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-white">
      <StatusBar barStyle="light-content" backgroundColor="primary" />

      {/* Header with Voice Controls */}
      <View
        className="bg-primary px-6 pt-4"
        style={{ paddingTop: statusBarHeight + 16 }}>
        <View className="flex-row items-center justify-between mb-4">
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="close" size={28} color="white" />
          </TouchableOpacity>

          <Text className="flex-1 text-center text-lg font-semibold text-white mx-4" numberOfLines={1}>
            {recipeData.title}
          </Text>

          {/* Voice Control Toggle */}
          <WebRTC
            onNextStep={goToNextStep}
            onPreviousStep={goToPreviousStep}
            onRepeatStep={repeatCurrentStep}
            onStarted={() => setVoiceEnabled(true)}
            onEnded={() => setVoiceEnabled(false)}
          />
        </View>

        {/* Progress Bar */}
        <View className="flex-row items-center mb-2">
          <View className="flex-1 bg-white/20 rounded-full h-2 mr-3">
            <Animated.View
              className="bg-white rounded-full h-2"
              style={{
                width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              }}
            />
          </View>
        </View>

        <Text className="text-white/80 text-center text-sm pb-6">
          Step {currentStep + 1} of {steps.length}
        </Text>

        {/* Voice/Listening Status */}
        {voiceEnabled && (
          <View>
             <View className="flex-row items-center justify-center">
              <SoundWaves />
            </View>
            <View className="flex-row items-center justify-center">
              <Ionicons name="mic" size={16} color="#FDE68A" />
              <Text className="text-white/90 text-sm ml-2">Listening for commands...</Text>
            </View>
          </View>
        )}
      </View>

      {/* Main Content */}
      <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>

        {/* Current Step */}
        <Animated.View
          className="bg-white rounded-2xl p-6 mb-6 shadow-lg"
          style={{ transform: [{ scale: stepTransitionAnim }] }}>
          <View className="flex-row items-start justify-between mb-4">
            <Text className="text-2xl font-bold text-gray-800 flex-1 leading-8">
              {currentStepData?.instruction_text || 'No instruction available'}
            </Text>
          </View>
          {/* Hint Card */}
          <View className="mt-2 bg-orange-50 rounded-xl p-4 border border-orange-100">
            <Text className="text-orange-700 text-sm">
              Say "next step" or "previous step" to navigate
            </Text>
          </View>
        </Animated.View>

        {/* Step Ingredients */}
        {currentStepIngredients.length > 0 && (
          <View className="bg-white rounded-2xl p-6 mb-6 shadow-lg">
            <Text className="text-lg font-semibold text-gray-800 mb-4">
              Ingredients for this step
            </Text>

            {currentStepIngredients.map((ingredient) => (
              <TouchableOpacity
                key={ingredient.id}
                onPress={() => toggleIngredientCheck(ingredient.id)}
                className="flex-row items-center py-3 border-b border-gray-100 last:border-b-0">
                <View
                  className={`mr-4 h-6 w-6 items-center justify-center rounded border-2 ${ingredient.checked ? 'border-green-500 bg-green-500' : 'border-gray-300'
                    }`}>
                  {ingredient.checked && (
                    <Ionicons name="checkmark" size={16} color="white" />
                  )}
                </View>
                <Text
                  className={`flex-1 text-base ${ingredient.checked ? 'text-gray-500 line-through' : 'text-gray-800'
                    }`}>
                  {ingredient.ingredient_text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Timer Section */}
        {(currentStepData?.duration || currentStepTimer) && (
          <View className="bg-white rounded-2xl p-6 mb-6 shadow-lg">
            <Text className="text-lg font-semibold text-gray-800 mb-4">Timers</Text>

            {currentStepTimer ? (
              <View className="bg-blue-50 rounded-xl p-4">
                <View className="flex-row items-center justify-between">
                  <Text className="font-medium text-blue-900">{currentStepTimer.name}</Text>
                  <Text className="text-2xl font-bold text-blue-900">
                    {formatTime(currentStepTimer.remainingSeconds)}
                  </Text>
                </View>
                <View className="mt-2 bg-blue-200 rounded-full h-2">
                  <View
                    className="bg-blue-600 rounded-full h-2"
                    style={{
                      width: `${((currentStepTimer.totalSeconds - currentStepTimer.remainingSeconds) / currentStepTimer.totalSeconds) * 100}%`
                    }}
                  />
                </View>
              </View>
            ) : currentStepData?.duration && (
              <TouchableOpacity
                onPress={() => startStepTimer(currentStepData.duration!)}
                className="bg-primary rounded-xl p-4 flex-row items-center justify-center">
                <Ionicons name="timer-outline" size={24} color="white" />
                <Text className="ml-3 text-white font-semibold text-lg">
                  Start Timer ({Math.floor(currentStepData.duration / 60)}m)
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>

      {/* Enhanced Bottom Navigation with Voice Feedback */}
      <View className="bg-white border-t border-gray-200 px-6 py-4" style={{ paddingBottom: 16 }}>
        {/* Primary actions: Previous / Next */}
        <View className="flex-row justify-between mb-3">
          <TouchableOpacity
            onPress={goToPreviousStep}
            disabled={currentStep === 0}
            className={`flex-row items-center px-6 py-3 rounded-xl ${currentStep === 0 ? 'bg-gray-100' : 'bg-gray-200'
              }`}>
            <Ionicons
              name="chevron-back"
              size={20}
              color={currentStep === 0 ? '#9CA3AF' : '#374151'}
            />
            <Text
              className={`ml-2 font-medium ${currentStep === 0 ? 'text-gray-400' : 'text-gray-700'
                }`}>
              Say "Back"
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={goToNextStep}
            disabled={currentStep === steps.length - 1}
            className={`flex-row items-center px-6 py-3 rounded-xl ${currentStep === steps.length - 1 ? 'bg-gray-100' : 'bg-primary'
              }`}>
            <Text
              className={`mr-2 font-medium ${currentStep === steps.length - 1 ? 'text-gray-400' : 'text-white'
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
