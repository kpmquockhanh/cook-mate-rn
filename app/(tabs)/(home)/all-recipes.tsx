import React, { useState, useCallback, useMemo } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import RecipeCard from 'components/RecipeCard';
import Search from 'components/Search';
import FilterSheet from 'components/FilterSheet';
import { useRecipes, RecipeListItem } from 'hooks/useRecipes';
import { goBack } from 'lib/navigationRoutes';
import { useTranslation } from '../../../lib/i18n';
import { isEmptyFilter, type FacetFilter } from '../../../lib/recipeFacets';
import { facetFilterFromParams, facetFilterToParamPatch } from '../../../lib/facetRoute';
import { describeFilter } from '../../../lib/facetLabels';

const ITEMS_PER_PAGE = 10;

export default function AllRecipes() {
  const { t } = useTranslation();
  const router = useRouter();
  // `focus` is set by the home search bar, which lands here ready to type; the
  // rest are the facet chips and rail links (lib/facetRoute.ts).
  // Destructured rather than held as an object: useLocalSearchParams hands
  // back a fresh object every render, so memoizing on it would re-filter the
  // whole list on every keystroke.
  const {
    focus,
    filter: filterParam,
    meal,
    ingredient,
    diet,
    difficulty,
    maxMinutes,
    handsOff,
    favorites,
    popular,
  } = useLocalSearchParams<{
    focus?: string;
    filter?: string;
    meal?: string;
    ingredient?: string;
    diet?: string;
    difficulty?: string;
    maxMinutes?: string;
    handsOff?: string;
    favorites?: string;
    popular?: string;
  }>();
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // `filter=1` opens the sheet straight away, which is how the home bar's
  // filter button gets here - the route carries the intent, like `focus`.
  const [filterOpen, setFilterOpen] = useState(filterParam === '1');

  const filter = useMemo(
    () =>
      facetFilterFromParams({
        meal,
        ingredient,
        diet,
        difficulty,
        maxMinutes,
        handsOff,
        favorites,
        popular,
      }),
    [meal, ingredient, diet, difficulty, maxMinutes, handsOff, favorites, popular]
  );
  const filtered = !isEmptyFilter(filter);
  // Drives the badge on the filter button: how many facets are narrowing the
  // list, which is what the pill below spells out in words.
  const activeFacetCount = describeFilter(filter).length;

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
    // The API applies these, so paging still works while filtered: every page
    // comes back already narrowed, and `hasMore` means what it says.
    ...filter,
  });

  /**
   * Replaces the whole filter. The route is the single source of truth for it,
   * so what the sheet applies is also what a deep link or a back gesture
   * restores; the typed query is untouched, because narrowing is not a reset.
   */
  const applyFilter = useCallback(
    (next: FacetFilter) => {
      router.setParams(facetFilterToParamPatch(next) as never);
    },
    [router]
  );

  /** Drops the facets but keeps whatever the user has typed. */
  const clearFilter = useCallback(() => applyFilter({}), [applyFilter]);

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
        <Text style={styles.footerText}>{t('search.loadingMore')}</Text>
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
        {searchQuery || filtered ? t('search.noResults') : t('allRecipes.emptyTitle')}
      </Text>
      <Text style={styles.emptyStateSubtitle}>
        {filtered
          ? t('allRecipes.noFilterResultsHint')
          : searchQuery
            ? t('allRecipes.noResultsHint')
            : t('allRecipes.emptyHint')}
      </Text>
      {filtered && (
        <TouchableOpacity style={styles.retryButton} onPress={clearFilter}>
          <Text style={styles.retryButtonText}>{t('allRecipes.clearFilter')}</Text>
        </TouchableOpacity>
      )}
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
          <Text style={styles.headerTitle}>{t('allRecipes.title')}</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* px-5 lines the bar up with the cards below it; the wrapper used to
            add its own padding on top of the bar's. */}
        <Search
          onSearch={handleSearch}
          autoFocus={focus === '1'}
          containerClassName="px-5"
          onFilterPress={() => setFilterOpen(true)}
          filterCount={activeFacetCount}
        />

        {filtered && (
          <View style={styles.filterRow}>
            <View style={styles.filterPill}>
              <MaterialIcons name="filter-list" size={15} color="#ff6b6b" />
              <Text style={styles.filterPillText}>
                {describeFilter(filter).map((key) => t(key)).join(' · ')}
              </Text>
              <TouchableOpacity onPress={clearFilter} hitSlop={8}>
                <MaterialIcons name="close" size={15} color="#ff6b6b" />
              </TouchableOpacity>
            </View>
            {/* Counts what is loaded, not what exists: the server pages, so a
                total would need a second query for a number nobody acts on. */}
            <Text style={styles.filterCount}>
              {t('allRecipes.resultCount', { count: recipes.length })}
            </Text>
          </View>
        )}

        {!!error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
              <Text style={styles.retryButtonText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={recipes}
          renderItem={renderRecipe}
          keyExtractor={(item) => item.id.toString()}
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
        {filterOpen && (
          <FilterSheet
            value={filter}
            onClose={() => setFilterOpen(false)}
            onApply={(next) => {
              applyFilter(next);
              setFilterOpen(false);
            }}
          />
        )}
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
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 107, 107, 0.08)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  filterPillText: {
    color: '#ff6b6b',
    fontSize: 13,
    fontWeight: '600',
  },
  filterCount: {
    color: '#999',
    fontSize: 13,
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
