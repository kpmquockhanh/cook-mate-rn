import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import RecipeCard from 'components/RecipeCard';
import Search from 'components/Search';
import { useRecipes, RecipeListItem } from 'hooks/useRecipes';
import { goBack } from 'lib/navigationRoutes';

const ITEMS_PER_PAGE = 10;

export default function AllRecipes() {
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // useRecipes pages by offset and reloads the first page whenever `search`
  // changes, so this screen only tracks the query itself.
  const {
    data: recipes,
    loading,
    loadingMore,
    error,
    refetch,
    loadMore,
  } = useRecipes({
    limit: ITEMS_PER_PAGE,
    search: searchQuery,
    orderBy: 'created_at',
    order: 'desc',
  });

  const handleSearch = useCallback((search: string) => {
    setSearchQuery(search);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const renderRecipe = useCallback(({ item }: { item: RecipeListItem }) => (
    <RecipeCard recipe={item} showHeart={true} />
  ), []);

  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color="#FF6B6B" />
        <Text style={styles.footerText}>Loading more recipes...</Text>
      </View>
    );
  };

  const renderEmpty = () => (
    loading ? (
      <View style={styles.emptyState}>
        <ActivityIndicator size="large" color="#FF6B6B" />
      </View>
    ) : (
    <View style={styles.emptyState}>
      <MaterialIcons name="restaurant" size={64} color="#DDD" />
      <Text style={styles.emptyStateTitle}>
        {searchQuery ? 'No recipes found' : 'No recipes available'}
      </Text>
      <Text style={styles.emptyStateSubtitle}>
        {searchQuery 
          ? 'Try adjusting your search terms'
          : 'Check back later for new recipes'
        }
      </Text>
    </View>
    )
  );

  return (
    <>
      <Container>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => goBack()}>
            <MaterialIcons name="arrow-back" size={24} color="#333" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>All Recipes</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* px-5 lines the bar up with the cards below it; the wrapper used to
            add its own padding on top of the bar's. */}
        <Search onSearch={handleSearch} containerClassName="px-5" />

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={recipes}
          renderItem={renderRecipe}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContainer}
          showsVerticalScrollIndicator={false}
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
      </Container>
      <StatusBar style="auto" />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  backButton: {
    padding: 8,
    marginRight: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    flex: 1,
  },
  headerSpacer: {
    width: 40,
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
