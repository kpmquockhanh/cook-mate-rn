import { Container } from 'components/Container';
import { ScrollView, View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import HeaderSection from 'components/HeaderSection';
import Search from 'components/Search';
import RecipeCard from 'components/RecipeCard';
import { useRecipes } from 'hooks/useRecipes';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default function App() {
  const router = useRouter();
  const popular = useRecipes({ popular: true, limit: 5 });
  const featured = useRecipes({ featured: true, limit: 5 });

  const onSearch = (search: string) => {
    popular.refetch({ search });
    featured.refetch({ search });
  };

  const EmptyState = ({ title }: { title: string }) => (
    <View className="py-8 items-center">
      <Text className="text-gray-400 text-lg mb-2">No {title} Found</Text>
      <Text className="text-gray-300 text-sm text-center">Try adjusting your search or check back later</Text>
    </View>
  );

  return (
    <>
      <GestureHandlerRootView>
        <Container>
          <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 80 }}>
            <HeaderSection />

            {/* Search Section */}
            <Search onSearch={onSearch} />

            {/* Categories */}
            {/* <Categories /> */}

            {/* Popular Recipes */}
            <View className="mt-8 px-4">
              <View className="mb-4 flex-row items-center justify-between">
                <Text className="text-2xl font-bold text-gray-800">Popular Recipes</Text>
                <TouchableOpacity onPress={() => router.push('/(tabs)/all-recipes')}>
                  <Text className="font-medium text-orange-500">See all</Text>
                </TouchableOpacity>
              </View>
              {!!popular.error && (
                <Text className="text-red-500">{popular.error}</Text>
              )}
              {popular.loading ? (
                <View className="py-4 items-center">
                  <ActivityIndicator />
                </View>
              ) : popular.data.length > 0 ? (
                popular.data.map((recipe: any) => (
                  <RecipeCard key={recipe.id} recipe={recipe} showHeart={true} />
                ))
              ) : (
                <EmptyState title="Popular Recipes" />
              )}
            </View>

            {/* Featured Recipes */}
            <View className="mt-6 px-4">
              <View className="mb-4 flex-row items-center justify-between">
                <Text className="text-2xl font-bold text-gray-800">Featured Recipes</Text>
                <TouchableOpacity onPress={() => router.push('/(tabs)/all-recipes')}>
                  <Text className="font-medium text-orange-500">See all</Text>
                </TouchableOpacity>
              </View>
              {!!featured.error && (
                <Text className="text-red-500">{featured.error}</Text>
              )}
              {featured.loading ? (
                <View className="py-4 items-center">
                  <ActivityIndicator />
                </View>
              ) : featured.data.length > 0 ? (
                featured.data.map((recipe: any) => (
                  <RecipeCard key={recipe.id} recipe={recipe} showHeart={true} />
                ))
              ) : (
                <EmptyState title="Featured Recipes" />
              )}
            </View>
          </ScrollView>
        </Container>
      </GestureHandlerRootView>
      <StatusBar style="auto" />
    </>
  );
}
