import { View, Text, TouchableOpacity } from 'react-native';
import RecipeCard from './RecipeCard';

const popularRecipes = [
  {
    id: 1,
    title: 'Pasta Carbonara',
    time: '25 min',
    difficulty: 'Medium',
    rating: 4.2,
    image: 'https://images.unsplash.com/photo-1621996346565-e3dbc353d2e5?w=150&h=150&fit=crop',
    isFavorite: false,
  },
  {
    id: 2,
    title: 'Chicken Stir Fry',
    time: '20 min',
    difficulty: 'Easy',
    rating: 4.8,
    image: 'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=150&h=150&fit=crop',
    isFavorite: true,
  },
];

export default function PopularRecipes() {
  return (
    <View className="mt-8 px-4">
      <View className="mb-4 flex-row items-center justify-between">
        <Text className="text-2xl font-bold text-gray-800">Popular Recipes</Text>
        <TouchableOpacity>
          <Text className="font-medium text-orange-500">See all</Text>
        </TouchableOpacity>
      </View>

      {popularRecipes.map((recipe) => (
        <RecipeCard key={recipe.id} recipe={recipe} showHeart={true} />
      ))}
    </View>
  );
}
