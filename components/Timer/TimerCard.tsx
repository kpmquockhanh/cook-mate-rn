import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import TimerRing from './TimerRing';
import {
  formatDuration,
  timerTone,
  type ActiveTimer,
  type TimerTone,
} from '../../lib/TimerContext';
import { useTranslation, type TranslationKey } from '../../lib/i18n';

/**
 * One running timer.
 *
 * Everything on the card is driven by `timerTone`, so the colour, the label and
 * the controls can never disagree about what state the timer is in - which they
 * did before, when the colour came from a `priority` written once at creation
 * and the label came from somewhere else entirely.
 */

export const TONE_STYLE: Record<TimerTone, { color: string; colorEnd: string; tint: string }> = {
  done: { color: '#10B981', colorEnd: '#34D399', tint: '#ECFDF5' },
  critical: { color: '#EF4444', colorEnd: '#F87171', tint: '#FEF2F2' },
  warning: { color: '#F59E0B', colorEnd: '#FBBF24', tint: '#FFFBEB' },
  active: { color: '#4ECDC4', colorEnd: '#2DD4BF', tint: '#F0FDFA' },
  paused: { color: '#94A3B8', colorEnd: '#CBD5E1', tint: '#F8FAFC' },
};

/** The badge wording for each tone, kept beside the colours it labels. */
const TONE_LABEL_KEY: Record<TimerTone, TranslationKey> = {
  done: 'timer.toneDone',
  critical: 'timer.toneCritical',
  warning: 'timer.toneWarning',
  active: 'timer.toneActive',
  paused: 'timer.tonePaused',
};

const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.07,
  shadowRadius: 10,
  elevation: 2,
} as const;

/** Keeps the countdown from jittering as the digits change width. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };

const RING_SIZE = 92;

function ControlButton({
  icon,
  label,
  onPress,
  tone,
  filled = false,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  onPress: () => void;
  tone: { color: string; tint: string };
  filled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="h-10 flex-1 flex-row items-center justify-center rounded-xl"
      style={{ backgroundColor: filled ? tone.color : tone.tint }}>
      <MaterialIcons name={icon} size={18} color={filled ? '#FFFFFF' : tone.color} />
    </TouchableOpacity>
  );
}

export default function TimerCard({
  timer,
  onToggle,
  onAddTime,
  onRestart,
  onDismiss,
}: {
  timer: ActiveTimer;
  onToggle: () => void;
  onAddTime: (seconds: number) => void;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const tone = timerTone(timer);
  const style = TONE_STYLE[tone];
  const done = tone === 'done';
  const name = timer.name || t('timer.unnamed');

  const progress =
    timer.totalSeconds > 0 ? (timer.totalSeconds - timer.remainingSeconds) / timer.totalSeconds : 0;

  return (
    <View className="mb-3 overflow-hidden rounded-2xl bg-white" style={CARD_SHADOW}>
      {/* A stripe rather than a coloured card: the countdown has to stay black
          on white to be readable at arm's length, and the stripe is what makes
          the urgency legible in a list of several timers. */}
      <View className="flex-row">
        <View style={{ width: 5, backgroundColor: style.color }} />

        <View className="flex-1 p-4">
          <View className="flex-row items-center">
            <TimerRing
              size={RING_SIZE}
              progress={done ? 1 : progress}
              color={style.color}
              colorEnd={style.colorEnd}>
              <View className="items-center">
                <Text className="text-lg" accessibilityElementsHidden>
                  {timer.emoji}
                </Text>
                <Text className="text-lg font-bold text-gray-800" style={TABULAR}>
                  {formatDuration(timer.remainingSeconds)}
                </Text>
              </View>
            </TimerRing>

            <View className="ml-4 flex-1">
              <Text className="text-base font-bold text-gray-800" numberOfLines={2}>
                {name}
              </Text>

              <View
                className="mt-1 self-start rounded-full px-2 py-1"
                style={{ backgroundColor: style.tint }}>
                <Text className="text-[11px] font-bold" style={{ color: style.color }}>
                  {t(TONE_LABEL_KEY[tone]).toUpperCase()}
                </Text>
              </View>

              <Text className="mt-2 text-xs text-gray-400">
                {done
                  ? t('timer.ranFor', { duration: formatDuration(timer.totalSeconds) })
                  : t('timer.ofTotal', { duration: formatDuration(timer.totalSeconds) })}
              </Text>
            </View>
          </View>

          <View className="mt-4 flex-row gap-2">
            {done ? (
              <>
                <ControlButton
                  icon="replay"
                  label={t('timer.restartLabel', { name })}
                  onPress={onRestart}
                  tone={style}
                  filled
                />
                <ControlButton
                  icon="add"
                  label={t('timer.addMinuteLabel', { name })}
                  onPress={() => onAddTime(60)}
                  tone={style}
                />
                <ControlButton
                  icon="check"
                  label={t('timer.dismissLabel', { name })}
                  onPress={onDismiss}
                  tone={style}
                />
              </>
            ) : (
              <>
                <ControlButton
                  icon={timer.status === 'running' ? 'pause' : 'play-arrow'}
                  label={
                    timer.status === 'running'
                      ? t('timer.pauseLabel', { name })
                      : t('timer.resumeLabel', { name })
                  }
                  onPress={onToggle}
                  tone={style}
                  filled
                />
                <ControlButton
                  icon="remove"
                  label={t('timer.removeMinuteLabel', { name })}
                  onPress={() => onAddTime(-60)}
                  tone={style}
                />
                <ControlButton
                  icon="add"
                  label={t('timer.addMinuteLabel', { name })}
                  onPress={() => onAddTime(60)}
                  tone={style}
                />
                <ControlButton
                  icon="replay"
                  label={t('timer.restartLabel', { name })}
                  onPress={onRestart}
                  tone={style}
                />
                <ControlButton
                  icon="close"
                  label={t('timer.cancelLabel', { name })}
                  onPress={onDismiss}
                  tone={style}
                />
              </>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}
