import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  TouchableOpacity,
  Pressable,
  StatusBar,
  Modal,
  Alert,
  PanResponder,
  FlatList,
  ActivityIndicator,
  Linking,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShopping } from '../../../../lib/ShoppingContext';
import { useFavorites } from '../../../../lib/FavoritesContext';
import { reportRecipeEvent } from '../../../../lib/recipeEvents';
import { useSettings } from '../../../../lib/SettingsContext';
import { Note, useRecipe, type Ingredient } from '../../../../hooks/useRecipe';
import { getImageUrl } from '../../../../utils/index';
import { scaleIngredientAmount } from '../../../../utils/ingredientScaling';
import { LinearGradient } from 'expo-linear-gradient';
import Reanimated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { WEB_MOBILE_MAX_WIDTH } from '../../../_layout';
import { useTranslation } from '../../../../lib/i18n';
import { formatDuration } from '../../../../lib/duration';
import { TAB_BAR_OVERLAP } from '../../../../lib/navigationRoutes';

/**
 * NativeWind only registers a fixed list of react-native components for web
 * (react-native-css-interop/runtime/components.js) and animated views are not
 * on it, so className is dropped there while working fine on native. Animated
 * wrappers in this file therefore carry `style` only, with the layout classes
 * on a plain View inside.
 */

export default function RecipeDetailPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  // Must be reactive, not a module-scope Dimensions snapshot: on web that
  // snapshot is taken once and a resized window then leaves the hero wider
  // than its container, which pushes every row's right edge out of view.
  const { width: windowWidth } = useWindowDimensions();
  // On web, useWindowDimensions() reports the full browser window, not the
  // phone-width column the root layout clamps the app to (see
  // WEB_MOBILE_MAX_WIDTH in _layout.tsx). Without this the hero image's
  // height scaled off the raw window width and filled the whole screen on
  // a wide desktop browser.
  const width = Platform.OS === 'web' ? Math.min(windowWidth, WEB_MOBILE_MAX_WIDTH) : windowWidth;
  // Tall enough that the scrimmed title block at the bottom has room to
  // breathe without pushing the first real content off-screen on a small phone.
  const heroHeight = Math.max(300, Math.round(width * 0.78));
  const { addRecipeItems, isLoaded: shoppingLoaded } = useShopping();
  const { settings, isLoaded: settingsLoaded } = useSettings();

  // Use the new useRecipe hook
  const { data: recipeData, loading, error } = useRecipe({ id: id as string });
  const { isFavorite: isFavoriteFor, toggle: toggleFavoriteFor } = useFavorites();

  const [activeTab, setActiveTab] = useState<'ingredients' | 'directions'>('ingredients');
  const [servings, setServings] = useState(recipeData?.servings || 4);
  // The recipe's original servings/ingredient amounts, kept aside as the fixed
  // basis for scaling. Scaling from the current (possibly already-scaled)
  // `ingredients`/`servings` state instead would compound rounding on repeated changes.
  const [baseServings, setBaseServings] = useState(recipeData?.servings || 4);

  // Animation setup. Reanimated throughout: an animated `style` fed by RN's
  // legacy Animated.Value does not reach the view on iOS here (same css-interop
  // seam as the note at the top of this file). The tab content transition keeps
  // no animated value at all - see the note on it below.
  const tabScale = useSharedValue(1);
  const tabScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: tabScale.get() }],
  }));
  const [ingredients, setIngredients] = useState<Ingredient[]>(recipeData?.ingredients || []);
  const [baseIngredients, setBaseIngredients] = useState<Ingredient[]>(
    recipeData?.ingredients || []
  );
  const [notes, setNotes] = useState<Note[]>(recipeData?.notes || []);
  // The heart is shared state now (lib/FavoritesContext.tsx): the same recipe
  // shows the same heart here, in a rail and in the list, and tapping it writes
  // a row rather than flipping a local boolean that dies with the screen.
  const isFavorite = isFavoriteFor(id as string, recipeData?.isFavorite === true);
  const [showScaleModal, setShowScaleModal] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // The gallery is the thumbnail plus every published image, deduped: the
  // crawler stores the hero photo in both places, so keying on the URL is what
  // stops the first thumbnail being a duplicate of the hero.
  const recipeImages = React.useMemo(() => {
    const urls = [
      recipeData?.thumbnail,
      ...(recipeData?.images ?? []).map((image) => image.image_path),
    ].filter((url): url is string => Boolean(url));

    return [...new Set(urls)];
  }, [recipeData?.thumbnail, recipeData?.images]);

  const heroImage = recipeImages[selectedImageIndex] ?? recipeImages[0];

  // One 'viewed' per recipe opened. Keyed on the id rather than on recipeData
  // so a refetch does not count as a second view.
  React.useEffect(() => {
    if (id) reportRecipeEvent(id as string, 'viewed');
  }, [id]);

  // Update ingredients when recipe data changes
  React.useEffect(() => {
    if (recipeData?.ingredients) {
      setIngredients(recipeData.ingredients);
      setBaseIngredients(recipeData.ingredients);
      setNotes(recipeData.notes);
    }
  }, [recipeData]);

  // Update servings when recipe data changes
  React.useEffect(() => {
    if (recipeData?.servings) {
      setServings(recipeData.servings);
      setBaseServings(recipeData.servings);
    }
  }, [recipeData]);

  // Pan responder for swipe-to-go-back gesture. Native only: on web react-
  // native-web registers non-passive touchmove listeners for the responder
  // system, which fights the ScrollView, and the browser's own back button
  // plus the stack navigator's gesture already cover going back there.
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        // Only respond to horizontal swipes starting from the left edge
        const { dx, dy } = gestureState;
        const { locationX } = evt.nativeEvent;
        return (
          locationX < 50 && // Started from left edge
          Math.abs(dx) > Math.abs(dy) && // More horizontal than vertical
          dx > 30 // Minimum swipe distance
        );
      },
      onPanResponderMove: (evt, gestureState) => {
        // Optional: Add visual feedback during swipe
        if (gestureState.dx > 0) {
          // Swiping right, could add animation here
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        // If swipe is far enough, go back
        if (gestureState.dx > 100 && gestureState.vx > 0.3) {
          try {
            router.back();
          } catch (error) {
            console.warn('Navigation back error:', error);
          }
        }
      },
    })
  ).current;

  const toggleIngredientCheck = (ingredientId: string) => {
    setIngredients((prev) =>
      prev.map((ingredient) =>
        ingredient.id === ingredientId
          ? { ...ingredient, checked: !ingredient.checked }
          : ingredient
      )
    );
  };

  const scaleServings = (newServings: number) => {
    const ratio = newServings / (baseServings || 1);
    setIngredients((prevIngredients) =>
      baseIngredients.map((baseIngredient) => {
        const current = prevIngredients.find((ingredient) => ingredient.id === baseIngredient.id);
        return {
          ...baseIngredient,
          amount: scaleIngredientAmount(baseIngredient.amount, ratio),
          checked: current?.checked ?? baseIngredient.checked,
        };
      })
    );
    setServings(newServings);
  };

  // Open the recipe at the household size from Settings. It runs once per
  // recipe - keyed on the id, not on a boolean - so that a user who scales a
  // recipe by hand does not have their choice undone by the next re-render,
  // while opening a second recipe still starts from their default.
  const scaledToDefaultFor = useRef<string | null>(null);
  React.useEffect(() => {
    const defaultServings = settings.defaultServings;
    const recipeKey = recipeData?.id != null ? String(recipeData.id) : null;

    if (!settingsLoaded || !recipeKey || !defaultServings) return;
    // baseIngredients is set by its own effect; without it there is nothing to
    // scale from and scaleServings would write an empty ingredient list.
    if (baseIngredients.length === 0) return;
    if (scaledToDefaultFor.current === recipeKey) return;

    scaledToDefaultFor.current = recipeKey;
    if (defaultServings !== baseServings) scaleServings(defaultServings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, settings.defaultServings, recipeData?.id, baseIngredients, baseServings]);

  const toggleFavorite = () => {
    void toggleFavoriteFor(id as string, !isFavorite);
  };

  const handleAddToShoppingList = () => {
    const uncheckedIngredients = ingredients.filter((ingredient) => !ingredient.checked);

    if (uncheckedIngredients.length === 0) {
      Alert.alert(t('recipe.allCheckedTitle'), t('recipe.allCheckedMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('recipe.addAll'),
          onPress: () => {
            const shoppingItems = ingredients.map((ingredient) => ({
              name: ingredient.ingredient_text,
              quantity: ingredient.amount,
              checked: false,
              category: 'recipe' as const,
            }));
            addRecipeItems(shoppingItems, recipeData!.title);
            Alert.alert(
              t('recipe.addedAllTitle'),
              t('recipe.addedAllMessage', { count: ingredients.length })
            );
          },
        },
      ]);
      return;
    }

    const shoppingItems = uncheckedIngredients.map((ingredient) => ({
      name: ingredient.ingredient_text,
      quantity: ingredient.amount,
      checked: false,
      category: 'recipe' as const,
    }));

    addRecipeItems(shoppingItems, recipeData!.title);

    Alert.alert(
      t('recipe.addedTitle'),
      t('recipe.addedMessage', { count: uncheckedIngredients.length }),
      [{ text: t('common.ok') }]
    );
  };

  const switchTab = (newTab: 'ingredients' | 'directions') => {
    if (newTab === activeTab) return;

    // Tab button press animation
    tabScale.set(
      withSequence(withTiming(0.95, { duration: 100 }), withTiming(1, { duration: 100 }))
    );

    setActiveTab(newTab);
  };

  const renderStars = (rating: number) => (
    <View className="flex-row">
      {[1, 2, 3, 4, 5].map((star) => (
        <Ionicons
          key={star}
          name={
            star <= Math.floor(rating)
              ? 'star'
              : star === Math.ceil(rating)
                ? 'star-half'
                : 'star-outline'
          }
          size={14}
          color="#FFD700"
        />
      ))}
    </View>
  );

  const renderImageItem = ({ item, index }: { item: string; index: number }) => (
    <Pressable
      onPress={() => setSelectedImageIndex(index)}
      accessibilityRole="button"
      accessibilityState={{ selected: selectedImageIndex === index }}
      className="mr-3 overflow-hidden rounded-2xl"
      style={{
        width: 72,
        height: 72,
        borderWidth: 2,
        borderColor: selectedImageIndex === index ? '#ff6b6b' : 'transparent',
      }}>
      <Image source={{ uri: getImageUrl(item) }} className="h-full w-full" resizeMode="cover" />
    </Pressable>
  );

  // Circular control that stays legible over any photo.
  const heroButton = (
    icon: React.ComponentProps<typeof Ionicons>['name'],
    onPress: () => void,
    color = 'white'
  ) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      className="h-11 w-11 items-center justify-center rounded-full bg-black/40">
      <Ionicons name={icon} size={22} color={color} />
    </TouchableOpacity>
  );

  // Show loading state
  if (loading || !shoppingLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <StatusBar barStyle="dark-content" />
        <ActivityIndicator size="large" color="#ff6b6b" />
        <Text className="mt-4 text-base text-gray-500">
          {loading ? t('recipe.loading') : t('recipe.loadingShoppingList')}
        </Text>
      </View>
    );
  }

  // Show error state
  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-6">
        <StatusBar barStyle="dark-content" />
        <Ionicons name="alert-circle-outline" size={64} color="#EF4444" />
        <Text className="mb-2 mt-4 text-xl font-semibold text-gray-800">
          {t('recipe.loadError')}
        </Text>
        <Text className="mb-6 text-center text-gray-600">{error}</Text>
        <TouchableOpacity className="rounded-lg bg-primary px-6 py-3" onPress={() => router.back()}>
          <Text className="font-semibold text-white">{t('common.goBack')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Show loading state if no recipe data
  if (!recipeData) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <StatusBar barStyle="dark-content" />
        <Text className="mb-4 text-lg text-gray-600">{t('recipe.notFound')}</Text>
        <TouchableOpacity className="rounded-lg bg-primary px-6 py-3" onPress={() => router.back()}>
          <Text className="font-semibold text-white">{t('common.goBack')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const description = typeof recipeData.description === 'string' ? recipeData.description : '';
  const difficulty = typeof recipeData.difficulty === 'string' ? recipeData.difficulty : '';
  const aiScore = typeof recipeData.aiScore === 'number' ? recipeData.aiScore : undefined;
  const cuisine = typeof recipeData.cuisine === 'string' ? recipeData.cuisine : '';
  const category = typeof recipeData.category === 'string' ? recipeData.category : '';
  const sourceName = typeof recipeData.source_name === 'string' ? recipeData.source_name : '';
  const sourceUrl = typeof recipeData.source_url === 'string' ? recipeData.source_url : '';
  const badge = cuisine || category;

  return (
    <View
      className="flex-1 overflow-hidden bg-white"
      {...(Platform.OS === 'web' ? {} : panResponder.panHandlers)}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Floating controls: outside the ScrollView so they stay reachable. */}
      <View
        className="absolute left-0 right-0 z-20 flex-row items-center justify-between px-5"
        style={{ top: insets.top + 8 }}>
        {heroButton('chevron-back', () => router.back())}
        {heroButton(
          isFavorite ? 'heart' : 'heart-outline',
          toggleFavorite,
          isFavorite ? '#ff6b6b' : 'white'
        )}
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: TAB_BAR_OVERLAP + 32 }}>
        {/* Hero */}
        <View style={{ height: heroHeight }}>
          {heroImage ? (
            <Image
              source={{ uri: getImageUrl(heroImage) }}
              style={{ width: '100%', height: heroHeight }}
              resizeMode="cover"
            />
          ) : (
            <View
              className="w-full items-center justify-center bg-gray-200"
              style={{ height: heroHeight }}>
              <Ionicons name="restaurant-outline" size={56} color="#9CA3AF" />
            </View>
          )}

          {/* Scrims. Without these the white title sat on raw photo and was
              unreadable on any light dish. */}
          <LinearGradient
            colors={['rgba(0,0,0,0.55)', 'transparent']}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + 80 }}
            pointerEvents="none"
          />
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.85)']}
            locations={[0, 0.45, 1]}
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: heroHeight * 0.7 }}
            pointerEvents="none"
          />

          <View className="absolute bottom-0 left-0 right-0 px-5 pb-8">
            {badge ? (
              <View className="mb-3 self-start rounded-full bg-white/20 px-3 py-1">
                <Text className="text-xs font-semibold uppercase tracking-wide text-white">
                  {badge}
                </Text>
              </View>
            ) : null}

            <Text className="text-3xl font-bold leading-9 text-white">{recipeData.title}</Text>

            {recipeData.rating > 0 && (
              <View className="mt-3 flex-row items-center">
                {renderStars(recipeData.rating)}
                <Text className="ml-2 text-sm font-medium text-white">
                  {recipeData.rating.toFixed(1)}
                </Text>
                {recipeData.reviewCount > 0 && (
                  <Text className="ml-1 text-sm text-white/70">
                    {t('recipe.reviewCount', { count: recipeData.reviewCount })}
                  </Text>
                )}
              </View>
            )}
          </View>
        </View>

        {/* Stats card, pulled up over the hero so the two read as one block. */}
        <View
          className="mx-5 flex-row rounded-2xl bg-white px-2 py-4"
          style={{
            marginTop: -24,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.12,
            shadowRadius: 12,
            elevation: 5,
          }}>
          <View className="flex-1 items-center">
            <Ionicons name="time-outline" size={22} color="#ff6b6b" />
            <Text className="mt-1 text-sm font-semibold text-gray-800">
              {formatDuration(recipeData.totalMinutes, t) ?? recipeData.cookingTime}
            </Text>
            <Text className="text-xs text-gray-400">{t('recipe.totalTime')}</Text>
          </View>

          <View className="w-px bg-gray-100" />

          <TouchableOpacity
            className="flex-1 items-center"
            activeOpacity={0.7}
            onPress={() => setShowScaleModal(true)}>
            <Ionicons name="people-outline" size={22} color="#ff6b6b" />
            <Text className="mt-1 text-sm font-semibold text-gray-800">{servings}</Text>
            <Text className="text-xs text-gray-400">{t('recipe.servings')}</Text>
          </TouchableOpacity>

          <View className="w-px bg-gray-100" />

          <View className="flex-1 items-center">
            <Ionicons name="flame-outline" size={22} color="#ff6b6b" />
            <Text className="mt-1 text-sm font-semibold capitalize text-gray-800">
              {difficulty || '—'}
            </Text>
            <Text className="text-xs text-gray-400">{t('recipe.difficulty')}</Text>
          </View>

          {aiScore !== undefined && (
            <>
              <View className="w-px bg-gray-100" />

              <View className="flex-1 items-center">
                <Ionicons name="sparkles-outline" size={22} color="#ff6b6b" />
                <Text className="mt-1 text-sm font-semibold text-gray-800">
                  {aiScore.toFixed(1)}
                </Text>
                <Text className="text-xs text-gray-400">{t('recipe.aiScore')}</Text>
              </View>
            </>
          )}
        </View>

        {description ? (
          <Text className="px-5 pt-5 text-base leading-6 text-gray-600">{description}</Text>
        ) : null}

        {/* Image Gallery */}
        {recipeImages.length > 1 && (
          <View className="pt-5">
            <Text className="mb-3 px-5 text-base font-semibold text-gray-800">
              {t('recipe.photos', { count: recipeImages.length })}
            </Text>
            <FlatList
              data={recipeImages}
              renderItem={renderImageItem}
              keyExtractor={(item, index) => `image-${index}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20 }}
            />
          </View>
        )}

        {/* Start Cooking Button */}
        <TouchableOpacity
          className="mx-5 mt-6 overflow-hidden rounded-2xl"
          activeOpacity={0.9}
          onPress={() => router.push(`/cooking/${id}`)}>
          <LinearGradient
            colors={['#ff6b6b', '#ff8e53']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 16,
            }}>
            <Ionicons name="play-circle" size={22} color="white" />
            <Text className="ml-2 text-lg font-semibold text-white">
              {t('recipe.startCooking')}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        {/* Tabs */}
        <Reanimated.View style={tabScaleStyle}>
          <View className="mx-5 mt-6 flex-row rounded-2xl bg-gray-100 p-1">
            {(['ingredients', 'directions'] as const).map((tab) => (
              /* Pressable rather than TouchableOpacity: switchTab re-renders this
                 button with a new style, which strands TouchableOpacity's
                 fade-back animation and leaves the active tab washed out. Keep
                 the style a plain object/array -- NativeWind's jsx runtime
                 (jsxImportSource in babel.config.js) ignores the
                 ({ pressed }) => [] form. */
              <Pressable
                key={tab}
                onPress={() => switchTab(tab)}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeTab === tab }}
                className="flex-1 rounded-xl py-3"
                style={
                  activeTab === tab
                    ? {
                        backgroundColor: '#ff6b6b',
                        shadowColor: '#ff6b6b',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.3,
                        shadowRadius: 4,
                        elevation: 2,
                      }
                    : { backgroundColor: 'transparent' }
                }>
                <Text
                  className="text-center text-sm font-semibold"
                  style={{ color: activeTab === tab ? 'white' : '#6B7280' }}>
                  {tab === 'ingredients' ? t('recipe.tabIngredients') : t('recipe.tabDirections')}
                </Text>
              </Pressable>
            ))}
          </View>
        </Reanimated.View>

        {/* Tab Content */}
        {/* Reanimated, not RN's Animated: driving `opacity` from an
            Animated.Value on a legacy Animated.View left the content stuck at
            opacity 0 on iOS while working on web (same css-interop seam as the
            note at the top of this file). A declarative entering animation owns
            no opacity value that a re-render can strand, and `key` remounts the
            subtree per tab so it always runs. */}
        <Reanimated.View key={activeTab} entering={FadeIn.duration(180)}>
          <View className="px-5 pb-4 pt-5">
            {activeTab === 'ingredients' && (
              <View>
                <View className="mb-1 flex-row items-baseline justify-between">
                  <Text className="text-xl font-semibold text-gray-800">
                    {t('recipe.tabIngredients')}
                  </Text>
                  <Text className="text-sm text-gray-400">
                    {t('recipe.ingredientsSummary', { items: ingredients.length, servings })}
                  </Text>
                </View>

                <View>
                  {ingredients.map((ingredient) => (
                    <TouchableOpacity
                      key={ingredient.id}
                      onPress={() => toggleIngredientCheck(ingredient.id)}
                      activeOpacity={0.7}
                      className="flex-row items-center border-b border-gray-100 py-3.5">
                      <View
                        className={`mr-4 h-6 w-6 items-center justify-center rounded-md border-2 ${
                          ingredient.checked ? 'border-primary bg-primary' : 'border-gray-300'
                        }`}>
                        {ingredient.checked && (
                          <Ionicons name="checkmark" size={15} color="white" />
                        )}
                      </View>
                      <Text
                        className={`flex-1 text-base ${
                          ingredient.checked ? 'text-gray-400 line-through' : 'text-gray-800'
                        }`}>
                        {ingredient.ingredient_text}
                      </Text>
                      {ingredient.amount ? (
                        <Text
                          className={`ml-3 text-sm font-medium ${
                            ingredient.checked ? 'text-gray-300' : 'text-gray-500'
                          }`}>
                          {ingredient.amount}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  className="mt-6 flex-row items-center justify-center rounded-2xl border border-gray-300 py-4"
                  activeOpacity={0.8}
                  onPress={handleAddToShoppingList}>
                  <Ionicons name="bag-outline" size={22} color="#374151" />
                  <Text className="ml-3 text-base font-medium text-gray-700">
                    {t('recipe.addToShoppingList')}
                  </Text>
                </TouchableOpacity>

                {notes.length > 0 && (
                  <View className="mt-8">
                    <Text className="mb-3 text-xl font-semibold text-gray-800">
                      {t('recipe.notes')}
                    </Text>
                    {notes.map((note, index) => (
                      <View
                        key={note.id ?? index}
                        className="mb-3 flex-row rounded-2xl bg-orange-50 p-4">
                        <Ionicons name="bulb-outline" size={20} color="#ff8e53" />
                        <Text className="ml-3 flex-1 text-sm leading-6 text-gray-700">
                          {note.note_text}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {activeTab === 'directions' && (
              <View>
                <View className="mb-1 flex-row items-baseline justify-between">
                  <Text className="text-xl font-semibold text-gray-800">
                    {t('recipe.tabDirections')}
                  </Text>
                  <Text className="text-sm text-gray-400">
                    {t('recipe.stepCount', { count: recipeData.instructions.length })}
                  </Text>
                </View>

                {recipeData.instructions.map((instruction, index: number) => (
                  <View
                    key={instruction.id ?? index}
                    className="flex-row border-b border-gray-100 py-4">
                    <View className="mr-4 h-8 w-8 items-center justify-center rounded-full bg-primary">
                      <Text className="text-sm font-semibold text-white">{index + 1}</Text>
                    </View>
                    <View className="flex-1">
                      <Text className="text-base leading-6 text-gray-700">
                        {instruction.instruction_text}
                      </Text>
                      {instruction.duration ? (
                        <View className="mt-2 flex-row items-center self-start rounded-full bg-gray-100 px-3 py-1">
                          <Ionicons name="timer-outline" size={14} color="#6B7280" />
                          <Text className="ml-1 text-xs font-medium text-gray-600">
                            {t('duration.minutes', {
                              count: Math.round(instruction.duration / 60),
                            })}
                            {instruction.timerName ? ` · ${instruction.timerName}` : ''}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            )}

            {sourceName ? (
              <TouchableOpacity
                className="mt-8 flex-row items-center justify-center"
                activeOpacity={sourceUrl ? 0.6 : 1}
                disabled={!sourceUrl}
                onPress={() => sourceUrl && Linking.openURL(sourceUrl)}>
                <Text className="text-xs text-gray-400">
                  {t('recipe.source', { source: sourceName })}
                </Text>
                {sourceUrl ? (
                  <Ionicons
                    name="open-outline"
                    size={12}
                    color="#9CA3AF"
                    style={{ marginLeft: 4 }}
                  />
                ) : null}
              </TouchableOpacity>
            ) : null}
          </View>
        </Reanimated.View>
      </ScrollView>

      {/* Scale Recipe Modal */}
      <Modal
        visible={showScaleModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowScaleModal(false)}>
        <View className="flex-1 justify-end bg-black/50">
          <View
            className="rounded-t-3xl bg-white p-6"
            style={{ paddingBottom: insets.bottom + 24 }}>
            <View className="mb-6 flex-row items-center justify-between">
              <Text className="text-xl font-semibold text-gray-800">{t('recipe.scaleTitle')}</Text>
              <TouchableOpacity onPress={() => setShowScaleModal(false)}>
                <Ionicons name="close" size={24} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <Text className="mb-4 text-center text-gray-600">{t('recipe.scalePrompt')}</Text>

            <View className="mb-6 flex-row items-center justify-around">
              {[2, 4, 6, 8].map((count) => (
                <Pressable
                  key={count}
                  onPress={() => scaleServings(count)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: servings === count }}
                  className={`h-12 w-12 items-center justify-center rounded-full ${
                    servings === count ? 'bg-primary' : 'bg-gray-100'
                  }`}>
                  <Text
                    className={`text-lg font-semibold ${
                      servings === count ? 'text-white' : 'text-gray-700'
                    }`}>
                    {count}
                  </Text>
                </Pressable>
              ))}
            </View>

            <TouchableOpacity
              onPress={() => setShowScaleModal(false)}
              className="rounded-2xl bg-primary py-4">
              <Text className="text-center text-lg font-semibold text-white">
                {t('recipe.scaleConfirm')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
