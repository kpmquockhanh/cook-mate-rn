import React, { ReactNode } from 'react';
import { View, Text, TouchableOpacity, Pressable, Switch, Platform } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

/**
 * The row vocabulary for the settings screen. Four shapes cover every setting
 * the app has: a switch, a choice between a handful of values, a number the
 * user nudges, and a row that does something when tapped.
 *
 * They live together in one file because they share the row metrics - a setting
 * whose label wraps differently from the one above it is the thing that makes a
 * settings screen look assembled rather than designed.
 */

const PRIMARY = '#ff6b6b';

/** Matches the cards on the recipe and cooking screens. */
const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
} as const;

export function SettingsSection({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View className="mb-6">
      <Text className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
        {title}
      </Text>
      <View className="overflow-hidden rounded-2xl bg-white" style={CARD_SHADOW}>
        {children}
      </View>
      {footer ? <Text className="ml-1 mt-2 text-xs leading-5 text-gray-400">{footer}</Text> : null}
    </View>
  );
}

/**
 * The shared frame: icon, label, optional second line, and whatever control the
 * row owns on the right. `divider` is drawn by the row rather than the section
 * so the last row in a card has no hairline hanging under it.
 */
function Row({
  icon,
  label,
  description,
  control,
  divider = true,
  disabled = false,
  destructive = false,
}: {
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  description?: string;
  control?: ReactNode;
  divider?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <View
      className={`flex-row items-center px-4 py-3 ${divider ? 'border-b border-gray-100' : ''}`}
      style={disabled ? { opacity: 0.45 } : undefined}>
      {icon ? (
        <View
          className={`mr-3 h-9 w-9 items-center justify-center rounded-full ${
            destructive ? 'bg-red-50' : 'bg-gray-100'
          }`}>
          <MaterialIcons name={icon} size={20} color={destructive ? '#EF4444' : '#6B7280'} />
        </View>
      ) : null}
      <View className="flex-1 pr-3">
        <Text className={`text-base font-medium ${destructive ? 'text-red-500' : 'text-gray-800'}`}>
          {label}
        </Text>
        {description ? (
          <Text className="mt-0.5 text-xs leading-5 text-gray-500">{description}</Text>
        ) : null}
      </View>
      {control}
    </View>
  );
}

export function ToggleRow({
  icon,
  label,
  description,
  value,
  onChange,
  divider,
  disabled,
}: {
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  divider?: boolean;
  disabled?: boolean;
}) {
  return (
    <Row
      icon={icon}
      label={label}
      description={description}
      divider={divider}
      disabled={disabled}
      control={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ false: '#E5E7EB', true: PRIMARY }}
          // iOS renders the knob white already; Android's default is a washed
          // green that fights the brand colour on the track.
          thumbColor={Platform.OS === 'android' ? '#FFFFFF' : undefined}
          accessibilityLabel={label}
        />
      }
    />
  );
}

export interface SegmentedOption<T> {
  label: string;
  value: T;
}

/**
 * A choice between two to five values. Below the label rather than beside it:
 * cooking settings need words ("Recipe's own", "Vibrate only"), and a row that
 * has to hold both a label and three word-length options runs out of width on a
 * small phone.
 */
export function SegmentedRow<T extends string | number | null>({
  icon,
  label,
  description,
  options,
  value,
  onChange,
  divider = true,
  disabled = false,
}: {
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  description?: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  divider?: boolean;
  disabled?: boolean;
}) {
  return (
    <View
      className={`px-4 py-3 ${divider ? 'border-b border-gray-100' : ''}`}
      style={disabled ? { opacity: 0.45 } : undefined}>
      <View className="flex-row items-center">
        {icon ? (
          <View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-gray-100">
            <MaterialIcons name={icon} size={20} color="#6B7280" />
          </View>
        ) : null}
        <View className="flex-1">
          <Text className="text-base font-medium text-gray-800">{label}</Text>
          {description ? (
            <Text className="mt-0.5 text-xs leading-5 text-gray-500">{description}</Text>
          ) : null}
        </View>
      </View>

      <View className="mt-3 flex-row rounded-xl bg-gray-100 p-1">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            /* Pressable rather than TouchableOpacity: onPress re-renders this button
                 with a new style, which strands TouchableOpacity's fade-back animation
                 and leaves the selected item washed out. Keep the style a plain
                 object/array -- NativeWind's jsx runtime ignores ({ pressed }) => []. */
            <Pressable
              key={String(option.value)}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              className={`flex-1 items-center rounded-lg py-2 ${selected ? 'bg-white' : ''}`}
              style={selected ? CARD_SHADOW : undefined}>
              <Text
                numberOfLines={1}
                className={`text-xs font-semibold ${selected ? 'text-gray-800' : 'text-gray-500'}`}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function StepperRow({
  icon,
  label,
  description,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  divider,
  disabled = false,
}: {
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Renders the value - "1.2×", "4 servings", and so on. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
  divider?: boolean;
  disabled?: boolean;
}) {
  // Rounded to the step's precision: 0.1 steps accumulate float error fast
  // enough to show up as "1.2000000000000002" on the third tap.
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));

  const button = (
    icon: React.ComponentProps<typeof MaterialIcons>['name'],
    next: number,
    enabled: boolean
  ) => (
    <TouchableOpacity
      onPress={() => onChange(clamp(next))}
      disabled={disabled || !enabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      className={`h-8 w-8 items-center justify-center rounded-full ${
        enabled && !disabled ? 'bg-gray-100' : 'bg-gray-50'
      }`}>
      <MaterialIcons name={icon} size={18} color={enabled && !disabled ? '#374151' : '#D1D5DB'} />
    </TouchableOpacity>
  );

  return (
    <Row
      icon={icon}
      label={label}
      description={description}
      divider={divider}
      disabled={disabled}
      control={
        <View className="flex-row items-center">
          {button('remove', value - step, value > min)}
          <Text className="mx-3 min-w-[64px] text-center text-sm font-semibold text-gray-800">
            {format ? format(value) : String(value)}
          </Text>
          {button('add', value + step, value < max)}
        </View>
      }
    />
  );
}

export function ActionRow({
  icon,
  label,
  description,
  value,
  onPress,
  destructive = false,
  divider,
}: {
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  description?: string;
  /** Read-only text shown on the right, e.g. an app version. */
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  divider?: boolean;
}) {
  const body = (
    <Row
      icon={icon}
      label={label}
      description={description}
      divider={divider}
      destructive={destructive}
      control={
        <View className="flex-row items-center">
          {value ? <Text className="mr-1 text-sm text-gray-400">{value}</Text> : null}
          {onPress ? (
            <MaterialIcons
              name="chevron-right"
              size={22}
              color={destructive ? '#EF4444' : '#9CA3AF'}
            />
          ) : null}
        </View>
      }
    />
  );

  if (!onPress) return body;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.6} accessibilityRole="button">
      {body}
    </TouchableOpacity>
  );
}
