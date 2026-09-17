import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View, TouchableOpacity, TextInput, Text } from 'react-native';

type SearchProps = {
  /** Called when the user submits a query. Ignored in button mode. */
  onSearch?: (search: string) => void;
  /**
   * Button mode: the bar is not editable and the whole row acts as a single
   * tap target. Used on the home screen, where tapping opens the search page.
   */
  onPress?: () => void;
  initialValue?: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** Layout of the wrapper, so callers can drop the default spacing. */
  containerClassName?: string;
};

// Shared between both modes so the button and the real input stay pixel
// identical - the home -> search transition relies on them lining up.
const FIELD_CLASS = 'flex-1 flex-row items-center rounded-2xl bg-gray-100 px-4 py-3';
const FIELD_HEIGHT = 56;

export default function Search({
  onSearch,
  onPress,
  initialValue = '',
  autoFocus = false,
  placeholder = 'Search recipes...',
  containerClassName = 'mt-6 px-4',
}: SearchProps) {
  // `initialValue` seeds the field once. To point the same mounted bar at a
  // different query, give it a `key` so it remounts.
  const [search, setSearch] = useState(initialValue);

  const FilterButton = (
    <TouchableOpacity className="items-center justify-center rounded-2xl bg-gray-100 px-4">
      <Ionicons name="options-outline" size={20} color="#9CA3AF" />
    </TouchableOpacity>
  );

  if (onPress) {
    return (
      <View className={containerClassName}>
        <View className="flex-row gap-x-3" style={{ height: FIELD_HEIGHT }}>
          <TouchableOpacity className={FIELD_CLASS} activeOpacity={0.7} onPress={onPress}>
            <Ionicons name="search-outline" size={20} color="#9CA3AF" />
            <Text className="ml-3 flex-1 text-gray-400" style={{ padding: 12 }} numberOfLines={1}>
              {initialValue || placeholder}
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
        <View className={FIELD_CLASS}>
          <Ionicons name="search-outline" size={20} color="#9CA3AF" />
          <TextInput
            placeholder={placeholder}
            placeholderTextColor="#9CA3AF"
            className="ml-3 flex-1 text-gray-700"
            style={{ padding: 12 }}
            value={search}
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
