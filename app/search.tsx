import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import Animated, { FadeInDown, FadeInLeft } from 'react-native-reanimated';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import RecipeCard from 'components/RecipeCard';
import Search from 'components/Search';
import { useRecipes, RecipeListItem } from 'hooks/useRecipes';
import { goBack } from 'lib/navigationRoutes';

const ITEMS_PER_PAGE = 10;
const ENTER_MS = 240;

export default function SearchResults() {
  const { q } = useLocalSearchParams<{ q?: string }>();
  const initialQuery = typeof q === 'string' ? q : '';

  const [query, setQuery] = useState(initialQuery);
  const [refreshing, setRefreshing] = useState(false);

  // useRecipes reloads the first page whenever `search` changes, so the query
  // state is the only thing this screen has to manage.
  const {
    data: recipes,
    loading,
    loadingMore,
    error,
    refetch,
    loadMore,
  } = useRecipes({
    limit: ITEMS_PER_PAGE,
    search: query,
    orderBy: 'created_at',
    order: 'desc',
  });

  const handleSearch = useCallback((search: string) => {
    setQuery(search);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const renderRecipe = useCallback(
    ({ item }: { item: RecipeListItem }) => <RecipeCard recipe={item} showHeart={true} />,
    []
  );

  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color="#FF6B6B" />
        <Text style={styles.footerText}>Loading more recipes...</Text>
      </View>
    );
  };

  const renderEmpty = () => {
    if (loading) {
      return (
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color="#FF6B6B" />
        </View>
      );
    }
    return (
      <View style={styles.emptyState}>
        <MaterialIcons name="search-off" size={64} color="#DDD" />
        <Text style={styles.emptyStateTitle}>No recipes found</Text>
        <Text style={styles.emptyStateSubtitle}>
          {query
            ? `Nothing matched "${query}". Try a different keyword.`
            : 'Type a keyword to search for recipes'}
        </Text>
      </View>
    );
  };

  return (
    <>
      <Container>
        {/* The bar lands a little above where the home bar sits, and slides up
            into place, so the crossfade between screens reads as one bar
            moving rather than two separate bars. */}
        <View style={styles.searchRow}>
          <Animated.View entering={FadeInLeft.duration(ENTER_MS).delay(60)}>
            <TouchableOpacity style={styles.backButton} onPress={() => goBack()}>
              <MaterialIcons name="arrow-back" size={24} color="#333" />
            </TouchableOpacity>
          </Animated.View>
          <Animated.View style={styles.searchField} entering={FadeInDown.duration(ENTER_MS)}>
            <Search
              onSearch={handleSearch}
              initialValue={initialQuery}
              autoFocus
              containerClassName=""
            />
          </Animated.View>
        </View>

        {!!query && !loading && recipes.length > 0 && (
          <Text style={styles.resultCount}>
            {recipes.length} result{recipes.length === 1 ? '' : 's'} for &ldquo;{query}&rdquo;
          </Text>
        )}

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <Animated.View style={styles.listWrapper} entering={FadeInDown.duration(280).delay(80)}>
          <FlatList
            data={recipes}
            renderItem={renderRecipe}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={styles.listContainer}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={['#FF6B6B']}
                tintColor="#FF6B6B"
              />
            }
            onEndReached={loadMore}
            onEndReachedThreshold={0.1}
            ListFooterComponent={renderFooter}
            ListEmptyComponent={renderEmpty}
            removeClippedSubviews={true}
            maxToRenderPerBatch={5}
            windowSize={10}
          />
        </Animated.View>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}

const styles = StyleSheet.create({
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // The arrow's own padding puts its icon at 20, and the bar ends at 20, so
    // the row lines up with the cards below.
    paddingLeft: 12,
    paddingRight: 20,
    // Roughly where the home screen's bar sits, minus the distance it travels
    // up during the entering animation.
    paddingTop: 72,
    paddingBottom: 4,
  },
  searchField: {
    flex: 1,
    marginLeft: 4,
  },
  backButton: {
    padding: 8,
  },
  resultCount: {
    paddingHorizontal: 20,
    paddingTop: 16,
    color: '#666',
    fontSize: 14,
  },
  listWrapper: {
    flex: 1,
  },
  listContainer: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 100,
  },
  footerLoader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  footerText: {
    marginLeft: 8,
    color: '#666',
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyStateTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#666',
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyStateSubtitle: {
    fontSize: 16,
    color: '#999',
    textAlign: 'center',
    lineHeight: 22,
  },
  errorContainer: {
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#FF6B6B',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '500',
  },
});
