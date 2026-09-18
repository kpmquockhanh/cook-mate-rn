import { Text, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTranslation } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n/en';
import type { FacetFilter, Meal } from '../../lib/recipeFacets';
import { MEAL_LABEL } from '../../lib/facetLabels';
import { facetFilterToParams } from '../../lib/facetRoute';

/**
 * The row of shortcuts under the search bar.
 *
 * These are the four questions a cook actually arrives with - how long have I
 * got, how much effort is this, which meal, and (once) what am I in the mood
 * for - rather than the scraped `category` column, which holds 25 values
 * across 45 recipes and could never be navigation.
 *
 * Every chip is a link into All Recipes with the filter in the route. Nothing
 * filters in place, so there is one results screen and one empty state.
 */

type Chip = {
  key: string;
  label: TranslationKey;
  icon: keyof typeof Ionicons.glyphMap;
  filter: FacetFilter;
};

/** The meal of the moment leads, so the row is never the same all day. */
function chipsFor(meal: Meal): Chip[] {
  return [
    { key: 'meal', label: MEAL_LABEL[meal], icon: 'restaurant-outline', filter: { meal } },
    {
      key: 'quick',
      label: 'facet.under30',
      icon: 'flash-outline',
      filter: { maxMinutes: 30 },
    },
    { key: 'easy', label: 'facet.easy', icon: 'happy-outline', filter: { difficulty: 'easy' } },
    {
      key: 'handsOff',
      label: 'facet.handsOff',
      icon: 'hourglass-outline',
      filter: { handsOff: true },
    },
    {
      key: 'chicken',
      label: 'facet.chicken',
      icon: 'egg-outline',
      filter: { mainIngredient: 'chicken' },
    },
    { key: 'veg', label: 'facet.veg', icon: 'leaf-outline', filter: { mainIngredient: 'veg' } },
    {
      key: 'vegetarian',
      label: 'facet.vegetarian',
      icon: 'leaf-outline',
      filter: { diet: 'vegetarian' },
    },
    { key: 'saved', label: 'facet.saved', icon: 'heart-outline', filter: { favorites: true } },
  ];
}

export default function FacetChips({ meal }: { meal: Meal }) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mt-5"
      contentContainerStyle={{ paddingHorizontal: 20 }}>
      {chipsFor(meal).map((chip) => (
        <TouchableOpacity
          key={chip.key}
          activeOpacity={0.7}
          onPress={() =>
            router.push({ pathname: '/all-recipes', params: facetFilterToParams(chip.filter) })
          }
          className="mr-2 flex-row items-center rounded-full border border-gray-200 bg-white px-4 py-2.5">
          <Ionicons name={chip.icon} size={15} color="#ff6b6b" />
          <Text className="ml-1.5 text-sm font-medium text-gray-700">{t(chip.label)}</Text>
        </TouchableOpacity>
      ))}
      {/* The way out of every facet: the unfiltered list. */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => router.push('/all-recipes')}
        className="mr-2 flex-row items-center rounded-full bg-gray-100 px-4 py-2.5">
        <Text className="text-sm font-medium text-gray-500">{t('facet.all')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
