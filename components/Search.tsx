import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View, TouchableOpacity, TextInput } from 'react-native';

export default function Search({ onSearch }: { onSearch: (search: string) => void }) {

  const [search, setSearch] = useState('');

  const handleSearch = (text: string) => {
    onSearch(text);
  };

  return (
    <View className="mt-6 px-4">
    <View className="flex-row gap-x-3">
      <View className="flex-1 flex-row items-center rounded-2xl bg-gray-100 px-4 py-3">
        <Ionicons name="search-outline" size={20} color="#9CA3AF" />
        <TextInput
          placeholder="Search recipes..."
          placeholderTextColor="#9CA3AF"
          className="ml-3 flex-1 text-gray-700"
          style={{
            padding: 12,
          }}
          onChangeText={setSearch}
          onSubmitEditing={() => handleSearch(search)}
        />
      </View>
      <TouchableOpacity className="items-center justify-center rounded-2xl bg-gray-100 px-4 py-3">
        <Ionicons name="options-outline" size={20} color="#9CA3AF" />
      </TouchableOpacity>
    </View>
  </View>
  );
}