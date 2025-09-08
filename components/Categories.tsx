import { View, Text, ScrollView, TouchableOpacity } from 'react-native';

const categories = ['All', 'Quick', 'Healthy', 'Favorites', 'test', 'test2', 'test3', 'test4', 'test5', 'test6', 'test7', 'test8', 'test9', 'test10'];

export default function Categories() {
  return (
    <View className="mt-6 px-4">
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row">
      {categories.map((category, index) => (
        <TouchableOpacity
          key={category}
          className={`mr-3 rounded-full px-6 py-3 ${
            index === 0 ? 'bg-primary' : 'bg-gray-100'
          }`}>
          <Text className={`font-medium ${index === 0 ? 'text-white' : 'text-gray-600'}`}>
            {category}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  </View>
  );
}