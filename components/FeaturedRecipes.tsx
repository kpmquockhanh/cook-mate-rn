import { View, Text, TouchableOpacity } from 'react-native';
import RecipeCard from './RecipeCard';

const featuredRecipes = [
  {
    id: 3,
    title: 'Beef Tacos',
    time: '30 min',
    difficulty: 'Easy',
    rating: 4.3,
    image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=150&h=150&fit=crop',
    isFavorite: false,
  },
  {
    id: 4,
    title: 'Salmon Salad',
    time: '15 min',
    difficulty: 'Easy',
    rating: 4.7,
    image: 'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=150&h=150&fit=crop',
    isFavorite: false,
  },
];

export default function FeaturedRecipes() {
  return (
    <View className="mt-6 px-4">
      <View className="mb-4 flex-row items-center justify-between">
        <Text className="text-2xl font-bold text-gray-800">Featured Recipes</Text>
        <TouchableOpacity>
          <Text className="font-medium text-orange-500">See all</Text>
        </TouchableOpacity>
      </View>

      {featuredRecipes.map((recipe) => (
        <RecipeCard key={recipe.id} recipe={recipe} showHeart={true} />
      ))}
    </View>
  );
}
