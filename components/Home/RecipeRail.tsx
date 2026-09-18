import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import RecipeCardCompact from '../RecipeCardCompact';
import { useTranslation } from '../../lib/i18n';
import type { FacetFilter } from '../../lib/recipeFacets';
import { facetFilterToParams } from '../../lib/facetRoute';

/**
 * One horizontal shelf of recipes under a heading.
 *
 * A rail with nothing in it renders nothing at all. Four "No recipes found"
 * panels stacked down the home screen say the app is broken; a shorter home
 * screen just says this shelf had nothing today, which is the truth and reads
 * as calm. The loading state is the exception - it holds the row's height so
 * the page does not jump as each rail arrives.
 */
export default function RecipeRail({
  title,
  subtitle,
  recipes,
  loading = false,
  /** Where "See all" goes. Omitted rails show no link. */
  filter,
}: {
  title: string;
  subtitle?: string;
  recipes: any[];
  loading?: boolean;
  filter?: FacetFilter;
}) {
  const router = useRouter();
  const { t } = useTranslation();

  if (!loading && recipes.length === 0) return null;

  const openAll = () =>
    router.push({ pathname: '/all-recipes', params: facetFilterToParams(filter ?? {}) });

  return (
    <View className="mt-7">
      <View className="mb-3 flex-row items-end justify-between px-5">
        <View className="flex-1">
          <Text className="text-xl font-bold text-gray-800">{title}</Text>
          {!!subtitle && <Text className="mt-0.5 text-sm text-gray-400">{subtitle}</Text>}
        </View>
        {!!filter && (
          <TouchableOpacity className="ml-3 flex-row items-center" onPress={openAll}>
            <Text className="text-sm font-medium text-primary">{t('common.seeAll')}</Text>
            <Ionicons name="chevron-forward" size={14} color="#ff6b6b" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View className="h-44 items-center justify-center">
          <ActivityIndicator color="#ff6b6b" />
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20 }}>
          {recipes.map((recipe) => (
            <RecipeCardCompact key={recipe.id} recipe={recipe} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
