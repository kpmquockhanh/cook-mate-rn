import { View, Text, Image, TouchableOpacity } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getImageUrl } from '../utils/index';

export default function RecipeCard({ recipe, showHeart = false }: { recipe: any; showHeart: boolean }) {
  const router = useRouter();

  const handleRecipePress = () => {
    try {
      router.push(`/recipe/${recipe.id || '1'}`);
    } catch (error) {
      console.warn('Navigation error:', error);
      // Fallback - could show an alert or handle gracefully
    }
  };

  return (
    <TouchableOpacity
      onPress={handleRecipePress}
      className="mb-4 rounded-2xl border border-gray-100 bg-white p-4"
      style={{
        borderColor: '#E5E5E5',
        borderWidth: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: .02,
        shadowRadius: 2,
        elevation: 5,
        padding: 21,
      }}>
      
      <View className="flex-row">
        <Image
          source={{ uri: getImageUrl(recipe.thumbnail) }}
          className="mr-4 h-20 w-20 rounded-xl"
          resizeMode="cover"
        />
        <View className="flex-1">
          <View className="flex-row items-start justify-between">
            <Text className="mr-2 flex-1 text-lg font-semibold text-gray-800">{recipe.title}</Text>
            {showHeart && (
              <TouchableOpacity>
                <Ionicons
                  name={recipe.isFavorite ? 'heart' : 'heart-outline'}
                  size={24}
                  color={recipe.isFavorite ? '#FF6B6B' : '#9CA3AF'}
                />
              </TouchableOpacity>
            )}
          </View>

          <View className="mt-2 flex-row items-center">
            <Ionicons name="time-outline" size={16} color="#9CA3AF" />
            <Text className="ml-1 mr-4 text-gray-500">{recipe.time}</Text>
            <MaterialIcons name="signal-cellular-alt" size={16} color="#9CA3AF" />
            <Text className="ml-1 text-gray-500">{recipe.difficulty}</Text>
          </View>

          <View className="mt-2 flex-row items-center">
            <View className="flex-row">
              {[1, 2, 3, 4, 5].map((star) => (
                <Ionicons
                  key={star}
                  name={
                    star <= Math.floor(recipe.rating)
                      ? 'star'
                      : star === Math.ceil(recipe.rating)
                        ? 'star-half'
                        : 'star-outline'
                  }
                  size={14}
                  color="#FFD700"
                />
              ))}
            </View>
            <Text className="ml-2 text-gray-500">{recipe.rating}</Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}
