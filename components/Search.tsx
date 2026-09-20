import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View, TouchableOpacity, TextInput, Text } from 'react-native';
import { useTranslation } from '../lib/i18n';

type SearchProps = {
  /** Called when the user submits a query. Ignored in button mode. */
  onSearch?: (search: string) => void;
  /**
   * Button mode: the bar is not editable and the whole row acts as a single
   * tap target. Used on the home screen, where tapping opens All Recipes.
   */
  onPress?: () => void;
  initialValue?: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** Layout of the wrapper, so callers can drop the default spacing. */
  containerClassName?: string;
  /** Opens the filter sheet. Without it the filter button is not rendered. */
  onFilterPress?: () => void;
  /** How many facets are applied, for the badge on the filter button. */
  filterCount?: number;
};

// Shared between both modes so the button and the real input stay pixel
// identical.
const FIELD_CLASS = 'flex-1 flex-row items-center rounded-2xl bg-gray-100 px-4 py-3';
const FIELD_HEIGHT = 56;

export default function Search({
  onSearch,
  onPress,
  initialValue = '',
  autoFocus = false,
  placeholder,
  containerClassName = 'mt-6 px-4',
  onFilterPress,
  filterCount = 0,
}: SearchProps) {
  const { t } = useTranslation();
  // Defaulted here rather than in the signature so the fallback follows the
  // language: a default parameter would be evaluated against whatever the
  // module saw first.
  const hint = placeholder ?? t('search.placeholder');
  // `initialValue` seeds the field once. To point the same mounted bar at a
  // different query, give it a `key` so it remounts.
  const [search, setSearch] = useState(initialValue);
  const [focused, setFocused] = useState(false);

  // Hidden rather than inert when no handler is given: a button that does
  // nothing reads as a broken feature.
  const FilterButton = onFilterPress ? (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onFilterPress}
      accessibilityRole="button"
      accessibilityLabel={t('filter.open')}
      className={`items-center justify-center rounded-2xl px-4 ${
        filterCount > 0 ? 'bg-[#ff6b6b]' : 'bg-gray-100'
      }`}>
      <Ionicons name="options-outline" size={20} color={filterCount > 0 ? '#FFF' : '#9CA3AF'} />
      {filterCount > 0 && (
        <View className="absolute right-1 top-1 h-4 min-w-4 items-center justify-center rounded-full bg-white px-1">
          <Text className="text-[10px] font-bold text-[#ff6b6b]">{filterCount}</Text>
        </View>
      )}
    </TouchableOpacity>
  ) : null;

  if (onPress) {
    return (
      <View className={containerClassName}>
        <View className="flex-row gap-x-3" style={{ height: FIELD_HEIGHT }}>
          <TouchableOpacity className={FIELD_CLASS} activeOpacity={0.7} onPress={onPress}>
            <Ionicons name="search-outline" size={20} color="#9CA3AF" />
            <Text className="ml-3 flex-1 text-gray-400" style={{ padding: 12, paddingLeft: 0 }} numberOfLines={1}>
              {initialValue || hint}
            </Text>
          </TouchableOpacity>
          {FilterButton}
        </View>
      </View>
    );
  }

  return (
    <View className={containerClassName}>
      <View className="flex-row gap-x-3" style={{ height: FIELD_HEIGHT }}>
        {/* The focus ring lives on the pill: the browser's default outline would
            hug the bare <input> as a square box inside it. A border is always
            present (transparent at rest) so focusing doesn't shift layout. */}
        <View
          className={`${FIELD_CLASS} border ${focused ? 'border-gray-300' : 'border-transparent'}`}>
          <Ionicons name="search-outline" size={20} color="#9CA3AF" />
          <TextInput
            placeholder={hint}
            placeholderTextColor="#9CA3AF"
            className="ml-3 flex-1 text-gray-700"
            style={{ padding: 12, paddingLeft: 0, outlineStyle: 'none' } as any}
            value={search}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoFocus={autoFocus}
            returnKeyType="search"
            onChangeText={setSearch}
            onSubmitEditing={() => onSearch?.(search)}
          />
          {search.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setSearch('');
                onSearch?.('');
              }}>
              <Ionicons name="close-circle" size={18} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>
        {FilterButton}
      </View>
    </View>
  );
}
