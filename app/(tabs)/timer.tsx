import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView } from 'react-native';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import TimerCard, { TONE_STYLE } from 'components/Timer/TimerCard';
import { useTimer, formatDuration, timerTone, type ActiveTimer } from '../../lib/TimerContext';
import { useTranslation, type TranslationKey, type Translator } from '../../lib/i18n';

interface QuickStartTimer {
  id: string;
  /** Looked up at render time, so the preset follows the language. */
  nameKey: TranslationKey;
  minutes: number;
  emoji: string;
}

const quickStartTimers: QuickStartTimer[] = [
  { id: '1', nameKey: 'timer.presetQuick', minutes: 3, emoji: '⚡' },
  { id: '2', nameKey: 'timer.presetPasta', minutes: 8, emoji: '🍝' },
  { id: '3', nameKey: 'timer.presetEggs', minutes: 10, emoji: '🥚' },
  { id: '4', nameKey: 'timer.presetVeggies', minutes: 15, emoji: '🥬' },
  { id: '5', nameKey: 'timer.presetChicken', minutes: 20, emoji: '🍗' },
  { id: '6', nameKey: 'timer.presetBread', minutes: 30, emoji: '🍞' },
];

/** Chips for building a custom duration, in seconds. */
const TIME_CHIPS = [30, 60, 300, 600];

const PRIMARY = '#ff6b6b';
const SECONDARY = '#ff8e53';

const MAX_CUSTOM_SECONDS = 12 * 60 * 60;

const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.07,
  shadowRadius: 10,
  elevation: 2,
} as const;

const TABULAR = { fontVariant: ['tabular-nums' as const] };

/**
 * The duration in words, under the digits - "1 hour 5 min" reads back what the
 * user just built, where "1:05:00" on its own can be misread as an hour or as
 * a minute.
 */
function describeDuration(totalSeconds: number, t: Translator): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    hours > 0 ? t('duration.hours', { count: hours }) : null,
    minutes > 0 ? t('duration.minutes', { count: minutes }) : null,
    seconds > 0 ? t('duration.seconds', { count: seconds }) : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Done first, because a finished timer is the only one asking the user for
 * something. Then whatever runs out soonest - the order a cook has to act in.
 * Paused timers sink to the bottom: they are not counting, so their remaining
 * time says nothing about when they need attention.
 */
function byUrgency(a: ActiveTimer, b: ActiveTimer): number {
  const rank = (timer: ActiveTimer) => {
    const tone = timerTone(timer);
    if (tone === 'done') return 0;
    if (tone === 'paused') return 2;
    return 1;
  };

  const difference = rank(a) - rank(b);
  return difference !== 0 ? difference : a.remainingSeconds - b.remainingSeconds;
}

function SectionHeading({
  title,
  icon,
  right,
}: {
  title: string;
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  right?: React.ReactNode;
}) {
  return (
    <View className="mb-3 flex-row items-center justify-between">
      <View className="flex-row items-center gap-2">
        <Text className="text-xl font-bold text-gray-800">{title}</Text>
        {icon ? <MaterialIcons name={icon} size={18} color={PRIMARY} /> : null}
      </View>
      {right}
    </View>
  );
}

export default function Timer() {
  const { t } = useTranslation();
  const {
    activeTimers,
    isLoaded,
    runningTimersCount,
    startTimer,
    toggleTimer,
    addTime,
    restartTimer,
    dismissTimer,
    dismissFinished,
  } = useTimer();

  const [customTimerName, setCustomTimerName] = useState('');
  const [customSeconds, setCustomSeconds] = useState(5 * 60);

  const sorted = useMemo(() => [...activeTimers].sort(byUrgency), [activeTimers]);
  const finishedCount = activeTimers.filter((timer) => timer.remainingSeconds <= 0).length;

  // The headline: whatever needs attention first. A finished timer outranks a
  // running one, which is the same rule the list is sorted by.
  const headline = sorted[0];
  const headlineTone = headline ? timerTone(headline) : null;

  const startCustomTimer = () => {
    if (customSeconds <= 0) return;
    startTimer({
      name: customTimerName.trim() || formatDuration(customSeconds),
      seconds: customSeconds,
      emoji: '⏰',
    });
    setCustomTimerName('');
    setCustomSeconds(5 * 60);
  };

  const adjustCustom = (seconds: number) =>
    setCustomSeconds((current) => Math.min(MAX_CUSTOM_SECONDS, Math.max(0, current + seconds)));

  return (
    <>
      <Container>
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 90 }}>
          {/* Header. Mirrors the home tab's gradient block so the two read as
              one app, and carries the one number the user opened the tab for. */}
          <LinearGradient
            colors={[PRIMARY, SECONDARY]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{
              paddingHorizontal: 24,
              paddingVertical: 24,
              borderBottomLeftRadius: 24,
              borderBottomRightRadius: 24,
            }}>
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-3">
                <Text className="text-xl font-bold text-white">{t('timer.title')}</Text>
                <Text className="mt-1 text-sm text-white/90">
                  {runningTimersCount > 0
                    ? finishedCount > 0
                      ? t('timer.runningAndDone', {
                          running: runningTimersCount,
                          done: finishedCount,
                        })
                      : t('timer.running', { count: runningTimersCount })
                    : finishedCount > 0
                      ? t('timer.finishedCount', { count: finishedCount })
                      : t('timer.idle')}
                </Text>
              </View>

              <View className="h-12 w-12 items-center justify-center rounded-full bg-white/20">
                <MaterialIcons name="timer" size={24} color="white" />
              </View>
            </View>

            {headline ? (
              <View className="mt-5 flex-row items-center rounded-2xl bg-white/15 px-4 py-3">
                <Text className="text-2xl">{headline.emoji}</Text>
                <View className="ml-3 flex-1">
                  <Text className="text-xs font-semibold uppercase tracking-wide text-white/70">
                    {headlineTone === 'done'
                      ? t('timer.headlineFinished')
                      : t('timer.headlineNext')}
                  </Text>
                  <Text className="text-base font-bold text-white" numberOfLines={1}>
                    {headline.name || t('timer.unnamed')}
                  </Text>
                </View>
                <Text className="text-2xl font-bold text-white" style={TABULAR}>
                  {formatDuration(headline.remainingSeconds)}
                </Text>
              </View>
            ) : null}
          </LinearGradient>

          {/* Active timers come before the presets: once something is cooking,
              the countdown is the reason the tab was opened, and it used to sit
              below two screens of buttons. */}
          <View className="mt-6 px-4">
            <SectionHeading
              title={t('timer.active')}
              right={
                finishedCount > 0 ? (
                  <TouchableOpacity
                    onPress={dismissFinished}
                    activeOpacity={0.7}
                    accessibilityRole="button">
                    <Text
                      className="text-sm font-semibold"
                      style={{ color: TONE_STYLE.done.color }}>
                      {t('timer.clearFinished')}
                    </Text>
                  </TouchableOpacity>
                ) : null
              }
            />

            {sorted.length > 0 ? (
              sorted.map((timer) => (
                <TimerCard
                  key={timer.id}
                  timer={timer}
                  onToggle={() => toggleTimer(timer.id)}
                  onAddTime={(seconds) => addTime(timer.id, seconds)}
                  onRestart={() => restartTimer(timer.id)}
                  onDismiss={() => dismissTimer(timer.id)}
                />
              ))
            ) : (
              // Previously this was a bare heading over empty space, which is
              // what made the screen look broken rather than idle.
              <View className="items-center rounded-2xl bg-white px-6 py-10" style={CARD_SHADOW}>
                <View className="h-16 w-16 items-center justify-center rounded-full bg-gray-50">
                  <MaterialIcons name="hourglass-empty" size={28} color="#CBD5E1" />
                </View>
                <Text className="mt-4 text-base font-semibold text-gray-700">
                  {isLoaded ? t('timer.noneRunning') : t('timer.checking')}
                </Text>
                <Text className="mt-1 text-center text-sm leading-5 text-gray-400">
                  {t('timer.emptyHint')}
                </Text>
              </View>
            )}
          </View>

          {/* Quick Start */}
          <View className="mt-7 px-4">
            <SectionHeading title={t('timer.quickStart')} icon="bolt" />

            <View className="flex-row flex-wrap" style={{ gap: 10 }}>
              {quickStartTimers.map((preset) => {
                const name = t(preset.nameKey);
                return (
                  <TouchableOpacity
                    key={preset.id}
                    onPress={() =>
                      startTimer({
                        name,
                        seconds: preset.minutes * 60,
                        emoji: preset.emoji,
                      })
                    }
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('timer.quickStartLabel', {
                      count: preset.minutes,
                      name,
                    })}
                    className="items-center rounded-2xl bg-white py-4"
                    style={[CARD_SHADOW, { width: '31%' }]}>
                    <Text className="text-2xl">{preset.emoji}</Text>
                    <Text className="mt-2 text-sm font-semibold text-gray-800">{name}</Text>
                    <Text className="mt-0.5 text-xs text-gray-400">
                      {t('duration.minutes', { count: preset.minutes })}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Custom timer */}
          <View className="mt-7 px-4">
            <SectionHeading title={t('timer.custom')} icon="tune" />

            <View className="rounded-2xl bg-white p-4" style={CARD_SHADOW}>
              <TextInput
                value={customTimerName}
                onChangeText={setCustomTimerName}
                placeholder={t('timer.customNamePlaceholder')}
                placeholderTextColor="#9CA3AF"
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={startCustomTimer}
                className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-base text-gray-800"
              />

              <View className="mt-4 flex-row items-center justify-between">
                <TouchableOpacity
                  onPress={() => adjustCustom(-60)}
                  disabled={customSeconds <= 0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={t('timer.oneMinuteLess')}
                  className="h-12 w-12 items-center justify-center rounded-full bg-gray-100"
                  style={customSeconds <= 0 ? { opacity: 0.4 } : undefined}>
                  <MaterialIcons name="remove" size={22} color="#374151" />
                </TouchableOpacity>

                <View className="items-center">
                  <Text className="text-4xl font-bold text-gray-800" style={TABULAR}>
                    {formatDuration(customSeconds)}
                  </Text>
                  <Text className="mt-1 text-xs text-gray-400">
                    {customSeconds > 0
                      ? describeDuration(customSeconds, t)
                      : t('timer.setDuration')}
                  </Text>
                </View>

                <TouchableOpacity
                  onPress={() => adjustCustom(60)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={t('timer.oneMinuteMore')}
                  className="h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                  <MaterialIcons name="add" size={22} color="#374151" />
                </TouchableOpacity>
              </View>

              {/* The minute stepper alone made a 45-minute roast a 45-tap job. */}
              <View className="mt-4 flex-row justify-center" style={{ gap: 8 }}>
                {TIME_CHIPS.map((seconds) => (
                  <TouchableOpacity
                    key={seconds}
                    onPress={() => adjustCustom(seconds)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    className="rounded-full bg-gray-100 px-3 py-2">
                    <Text className="text-xs font-semibold text-gray-700">
                      +{formatDuration(seconds)}
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  onPress={() => setCustomSeconds(0)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  className="rounded-full bg-gray-100 px-3 py-2">
                  <Text className="text-xs font-semibold text-gray-500">{t('common.clear')}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                onPress={startCustomTimer}
                disabled={customSeconds <= 0}
                activeOpacity={0.85}
                accessibilityRole="button"
                className="mt-4 h-12 flex-row items-center justify-center rounded-xl"
                style={{
                  backgroundColor: PRIMARY,
                  opacity: customSeconds <= 0 ? 0.45 : 1,
                }}>
                <MaterialIcons name="play-arrow" size={22} color="white" />
                <Text className="ml-1 text-base font-semibold text-white">{t('timer.start')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}
