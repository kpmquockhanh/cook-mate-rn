import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import RecipeThumbnail from './RecipeThumbnail';
import { useFavorites } from '../lib/FavoritesContext';
import { useTranslation } from '../lib/i18n';
import { formatDuration } from '../lib/duration';

/**
 * The full-width row: used wherever a list says "here is everything", as
 * opposed to a rail's "pick one of these".
 *
 * Slimmer than it was - the old 21pt padding around an 80pt image made four
 * rows fill a phone screen - and the thumbnail now falls back to a tinted
 * placeholder rather than a blank square, because most recipes ship without a
 * photo (see RecipeThumbnail).
 */
export default function RecipeCard({
  recipe,
  showHeart = false,
}: {
  recipe: any;
  showHeart: boolean;
}) {
  const router = useRouter();
  const { t } = useTranslation();
  const { isFavorite, toggle } = useFavorites();
  // The row carries the server's answer; the context carries anything the user
  // has changed since, so the same recipe's heart agrees with itself wherever
  // it appears.
  const favorite = isFavorite(recipe.id, recipe.isFavorite === true);

  const handleRecipePress = () => {
    try {
      router.push(`/recipe/${recipe.id || '1'}`);
    } catch (error) {
      console.warn('Navigation error:', error);
      // Fallback - could show an alert or handle gracefully
    }
  };

  // 4 of 45 recipes carry no rating at all. Five empty stars next to a blank
  // number is worse than no rating row, so the whole row is conditional.
  const rating = typeof recipe.rating === 'number' && recipe.rating > 0 ? recipe.rating : null;
  const aiScore = typeof recipe.aiScore === 'number' ? recipe.aiScore : null;

  return (
    <TouchableOpacity
      onPress={handleRecipePress}
      activeOpacity={0.85}
      className="mb-3 flex-row items-center rounded-2xl bg-white p-3"
      style={{
        borderColor: '#EDEDED',
        borderWidth: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.02,
        shadowRadius: 2,
        elevation: 2,
      }}>
      <RecipeThumbnail recipe={recipe} width={68} height={68} radius={14} />

      <View className="ml-3 flex-1">
        <View className="flex-row items-start justify-between">
          <Text
            className="mr-2 flex-1 text-[15px] font-semibold leading-5 text-gray-800"
            numberOfLines={2}>
            {recipe.title}
          </Text>
          {showHeart && (
            <TouchableOpacity hitSlop={8} onPress={() => toggle(recipe.id, !favorite)}>
              <Ionicons
                name={favorite ? 'heart' : 'heart-outline'}
                size={20}
                color={favorite ? '#FF6B6B' : '#D1D5DB'}
              />
            </TouchableOpacity>
          )}
        </View>

        <View className="mt-1.5 flex-row items-center">
          <Ionicons name="time-outline" size={13} color="#9CA3AF" />
          <Text className="ml-1 text-xs text-gray-500">
            {formatDuration(recipe.totalMinutes, t) ?? recipe.time}
          </Text>
          {!!recipe.difficulty && (
            <>
              <MaterialIcons
                name="signal-cellular-alt"
                size={13}
                color="#9CA3AF"
                style={{ marginLeft: 10 }}
              />
              <Text className="ml-1 text-xs capitalize text-gray-500">{recipe.difficulty}</Text>
            </>
          )}

          {rating !== null && (
            <>
              <Ionicons name="star" size={12} color="#FFC531" style={{ marginLeft: 10 }} />
              <Text className="ml-1 text-xs text-gray-500">{rating.toFixed(1)}</Text>
            </>
          )}

          {aiScore !== null && (
            <View className="ml-auto flex-row items-center rounded-full bg-primary/10 px-2 py-0.5">
              <Ionicons name="sparkles-outline" size={10} color="#ff6b6b" />
              <Text className="ml-1 text-[11px] font-semibold text-primary">
                {aiScore.toFixed(1)}
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}
