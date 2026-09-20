import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import RecipeThumbnail from './RecipeThumbnail';
import { facetsOf } from '../lib/recipeFacets';
import { DIFFICULTY_LABEL } from '../lib/facetLabels';
import { useTranslation } from '../lib/i18n';
import { formatDuration } from '../lib/duration';

/**
 * The card a horizontal rail is made of: a picture, a title, and the one fact
 * that decides whether a cook taps it.
 *
 * That fact is time, not rating. The scraped rating is 5.00 on most rows and
 * means nothing here, while "25m" answers the question the user arrived with.
 * A hands-off recipe says so instead, because "8h 20m" on its own reads as a
 * reason to close the app.
 *
 * Kept deliberately small. A rail is for scanning, so three cards should be in
 * view at once on a phone - at that size the eye moves along the shelf instead
 * of stopping on each one, which is what the full-width card below is for.
 */

/** Three abreast on a 390pt phone, with the fourth peeking. */
export const COMPACT_CARD_WIDTH = 132;
const MEDIA_HEIGHT = 84;

export default function RecipeCardCompact({ recipe }: { recipe: any }) {
  const router = useRouter();
  const { t } = useTranslation();
  const facets = facetsOf(recipe);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => router.push(`/recipe/${recipe.id}`)}
      style={{ width: COMPACT_CARD_WIDTH }}
      className="mr-2.5">
      <View>
        <RecipeThumbnail
          recipe={recipe}
          width={COMPACT_CARD_WIDTH}
          height={MEDIA_HEIGHT}
          radius={14}
        />
        {facets.handsOff && (
          <View className="absolute left-1.5 top-1.5 flex-row items-center rounded-full bg-black/55 px-1.5 py-0.5">
            <Ionicons name="hourglass-outline" size={9} color="white" />
            <Text className="ml-0.5 text-[9px] font-semibold text-white">
              {facets.activeMinutes !== null
                ? t('facet.handsOnMinutes', { count: facets.activeMinutes })
                : t('facet.handsOff')}
            </Text>
          </View>
        )}
      </View>

      <Text
        className="mt-1.5 text-[13px] font-semibold leading-[17px] text-gray-800"
        numberOfLines={2}>
        {recipe.title}
      </Text>

      {/* One line, and it never wraps: the time is the point, the difficulty is
          context, and a two-line meta row would undo the compactness above. */}
      <Text className="mt-0.5 text-[11px] text-gray-400" numberOfLines={1}>
        {formatDuration(recipe.totalMinutes, t) ?? recipe.time ?? recipe.cooking_time}
        {!!facets.difficulty && ` · ${t(DIFFICULTY_LABEL[facets.difficulty])}`}
      </Text>
    </TouchableOpacity>
  );
}
