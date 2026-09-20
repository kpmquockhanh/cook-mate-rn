import { ScrollView, View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import HeaderSection from 'components/HeaderSection';
import Search from 'components/Search';
import RecipeCard from 'components/RecipeCard';
import FacetChips from 'components/Home/FacetChips';
import RecipeRail from 'components/Home/RecipeRail';
import ResumeCard from 'components/Home/ResumeCard';
import { useRecipes, RecipeListItem } from 'hooks/useRecipes';
import { useRecentCooking } from '../../../lib/recentCooking';
import { currentDaypart, HERO_TITLE_KEY_FOR_DAYPART, MEAL_FOR_DAYPART } from '../../../lib/daypart';
import { useTranslation } from '../../../lib/i18n';

/**
 * Home answers "what am I cooking now?", not "what is popular on the internet?".
 *
 * The two rails this replaced - Popular and Featured - were the same rows
 * sorted by two numbers no user can see: the scraped source rating (5.00 on
 * most rows) and the crawler's internal quality gate. What is on screen now is
 * ordered by the questions a cook actually arrives with: am I mid-recipe, what
 * meal is it, how long have I got, how much work is this.
 *
 * Each rail is its own query. The API filters on the facet columns directly
 * (migration 0012), so a rail asks for the eight rows it shows rather than the
 * screen pulling a page and sifting it - which is what it did while the columns
 * did not exist yet.
 */

/** Enough to fill a rail and suggest there is more behind "See all". */
const RAIL_SIZE = 8;

/** The quick rail's promise, in minutes. Also what its chip and heading say. */
const QUICK_MINUTES = 30;

export default function App() {
  const router = useRouter();
  const { t } = useTranslation();
  const { entry: resume, dismiss: dismissResume } = useRecentCooking();

  const daypart = currentDaypart();
  const heroMeal = MEAL_FOR_DAYPART[daypart];

  const hero = useRecipes({ meal: heroMeal, limit: RAIL_SIZE, orderBy: 'ai_score' });
  const quick = useRecipes({ maxMinutes: QUICK_MINUTES, limit: RAIL_SIZE, orderBy: 'ai_score' });
  const handsOff = useRecipes({ handsOff: true, limit: RAIL_SIZE, orderBy: 'ai_score' });
  // Real usage: recipes people finished cooking in the last 30 days. Empty
  // until someone does, and an empty rail renders nothing at all.
  const popular = useRecipes({ popular: true, limit: RAIL_SIZE });
  const fresh = useRecipes({ limit: 5, orderBy: 'created_at', order: 'desc' });

  // The home bar is only an entry point: tapping it hands off to the recipe
  // list, focused, which owns the keyboard and the results.
  const openSearch = () => router.push({ pathname: '/all-recipes', params: { focus: '1' } });
  // The filter button lands on the same screen with its sheet already open, so
  // the facets live in one place instead of two that have to agree.
  const openFilters = () => router.push({ pathname: '/all-recipes', params: { filter: '1' } });

  return (
    <>
      <GestureHandlerRootView>
        <Container>
          <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 80 }}>
            <HeaderSection />

            {!!resume && <ResumeCard entry={resume} onDismiss={dismissResume} />}

            <Search onPress={openSearch} onFilterPress={openFilters} />

            <FacetChips meal={heroMeal} />

            {!!fresh.error && (
              <View className="mx-5 mt-6 items-center rounded-2xl bg-red-50 p-4">
                <Text className="text-center text-red-500">{fresh.error}</Text>
              </View>
            )}

            <RecipeRail
              title={t(HERO_TITLE_KEY_FOR_DAYPART[daypart])}
              recipes={hero.data}
              loading={hero.loading}
              filter={{ meal: heroMeal }}
            />

            <RecipeRail
              title={t('home.quickTitle')}
              subtitle={t('home.quickSubtitle')}
              recipes={quick.data}
              loading={quick.loading}
              filter={{ maxMinutes: QUICK_MINUTES }}
            />

            <RecipeRail
              title={t('home.handsOffTitle')}
              subtitle={t('home.handsOffSubtitle')}
              recipes={handsOff.data}
              loading={handsOff.loading}
              filter={{ handsOff: true }}
            />

            <RecipeRail
              title={t('home.popularTitle')}
              subtitle={t('home.popularSubtitle')}
              recipes={popular.data.filter((recipe) => (recipe.cookCount ?? 0) > 0)}
              loading={popular.loading}
              filter={{ popular: true }}
            />

            {/* The tail of the page goes back to the full-width card: a rail
                says "pick one of these", a list says "here is everything". */}
            <View className="mt-8 px-5">
              <View className="mb-4 flex-row items-center justify-between">
                <Text className="text-xl font-bold text-gray-800">{t('home.newTitle')}</Text>
                <TouchableOpacity onPress={() => router.push('/all-recipes')}>
                  <Text className="font-medium text-primary">{t('common.seeAll')}</Text>
                </TouchableOpacity>
              </View>

              {fresh.loading ? (
                <View className="items-center py-4">
                  <ActivityIndicator size="large" color="#ff6b6b" />
                </View>
              ) : fresh.data.length > 0 ? (
                fresh.data.map((recipe: RecipeListItem) => (
                  <RecipeCard key={recipe.id} recipe={recipe} showHeart={true} />
                ))
              ) : (
                <View className="items-center py-8">
                  <MaterialIcons name="restaurant" size={48} color="#DDD" />
                  <Text className="mt-3 text-center text-gray-400">{t('home.emptyHint')}</Text>
                </View>
              )}
            </View>
          </ScrollView>
        </Container>
      </GestureHandlerRootView>
      <StatusBar style="auto" />
    </>
  );
}
