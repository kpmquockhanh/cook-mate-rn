import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  TouchableOpacity,
  StatusBar,
  Modal,
  Animated,
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
import { useShopping } from '../../lib/ShoppingContext';
import { Note, useRecipe, type Ingredient } from '../../hooks/useRecipe';
import { getImageUrl } from '../../utils/index';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * NativeWind only registers a fixed list of react-native components for web
 * (react-native-css-interop/runtime/components.js) and `Animated.View` is not
 * on it, so className is dropped there while working fine on native. Animated
 * wrappers in this file therefore carry `style` only, with the layout classes
 * on a plain View inside.
 */

export default function RecipeDetailPage() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  // Must be reactive, not a module-scope Dimensions snapshot: on web that
  // snapshot is taken once and a resized window then leaves the hero wider
  // than its container, which pushes every row's right edge out of view.
  const { width } = useWindowDimensions();
  // Tall enough that the scrimmed title block at the bottom has room to
  // breathe without pushing the first real content off-screen on a small phone.
  const heroHeight = Math.max(300, Math.round(width * 0.78));
  const { addRecipeItems, isLoaded: shoppingLoaded } = useShopping();

  // Use the new useRecipe hook
  const { data: recipeData, loading, error } = useRecipe({ id: id as string });

  const [activeTab, setActiveTab] = useState<'ingredients' | 'directions'>('ingredients');
  const [servings, setServings] = useState(recipeData?.servings || 4);

  // Animation setup
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const tabScaleAnim = useRef(new Animated.Value(1)).current;
  const [ingredients, setIngredients] = useState<Ingredient[]>(recipeData?.ingredients || []);
  const [notes, setNotes] = useState<Note[]>(recipeData?.notes || []);
  const [isFavorite, setIsFavorite] = useState(recipeData?.isFavorite || false);
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

  // Update ingredients when recipe data changes
  React.useEffect(() => {
    if (recipeData?.ingredients) {
      setIngredients(recipeData.ingredients);
      setNotes(recipeData.notes);
    }
  }, [recipeData]);

  // Update servings when recipe data changes
  React.useEffect(() => {
    if (recipeData?.servings) {
      setServings(recipeData.servings);
    }
  }, [recipeData]);

  // Update favorite status when recipe data changes
  React.useEffect(() => {
    if (recipeData?.isFavorite !== undefined) {
      setIsFavorite(recipeData.isFavorite);
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
    setServings(newServings);
    // In a real app, you'd scale the ingredient amounts here using the ratio
    // const ratio = newServings / mockRecipeData.servings;
  };

  const toggleFavorite = () => {
    setIsFavorite(!isFavorite);
  };

  const handleAddToShoppingList = () => {
    const uncheckedIngredients = ingredients.filter((ingredient) => !ingredient.checked);

    if (uncheckedIngredients.length === 0) {
      Alert.alert(
        'All ingredients checked',
        'All ingredients are already checked off. Would you like to add all ingredients to your shopping list?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Add All',
            onPress: () => {
              const shoppingItems = ingredients.map((ingredient) => ({
                name: ingredient.ingredient_text,
                quantity: ingredient.amount,
                checked: false,
                category: 'recipe' as const,
              }));
              addRecipeItems(shoppingItems, recipeData!.title);
              Alert.alert(
                'Success',
                `Added ${ingredients.length} ingredients to your shopping list!`
              );
            },
          },
        ]
      );
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
      'Added to Shopping List!',
      `${uncheckedIngredients.length} ingredient${uncheckedIngredients.length > 1 ? 's' : ''} added to your shopping list.`,
      [{ text: 'OK' }]
    );
  };

  const switchTab = (newTab: 'ingredients' | 'directions') => {
    if (newTab === activeTab) return;

    // Tab button press animation
    Animated.sequence([
      Animated.timing(tabScaleAnim, {
        toValue: 0.95,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(tabScaleAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();

    // Get the direction of animation based on tab order
    const tabOrder = ['ingredients', 'directions'];
    const currentIndex = tabOrder.indexOf(activeTab);
    const newIndex = tabOrder.indexOf(newTab);
    const direction = newIndex > currentIndex ? 1 : -1;

    // Start with fade out and slide
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: direction * 50,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start(() => {
      // Change the tab content
      setActiveTab(newTab);

      // Reset position and fade in
      slideAnim.setValue(direction * -50);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    });
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
    <TouchableOpacity
      onPress={() => setSelectedImageIndex(index)}
      activeOpacity={0.85}
      className="mr-3 overflow-hidden rounded-2xl"
      style={{
        width: 72,
        height: 72,
        borderWidth: 2,
        borderColor: selectedImageIndex === index ? '#ff6b6b' : 'transparent',
      }}>
      <Image source={{ uri: getImageUrl(item) }} className="h-full w-full" resizeMode="cover" />
    </TouchableOpacity>
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
          {loading ? 'Loading recipe…' : 'Loading shopping list…'}
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
        <Text className="mb-2 mt-4 text-xl font-semibold text-gray-800">Error Loading Recipe</Text>
        <Text className="mb-6 text-center text-gray-600">{error}</Text>
        <TouchableOpacity className="rounded-lg bg-primary px-6 py-3" onPress={() => router.back()}>
          <Text className="font-semibold text-white">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Show loading state if no recipe data
  if (!recipeData) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <StatusBar barStyle="dark-content" />
        <Text className="mb-4 text-lg text-gray-600">Recipe not found</Text>
        <TouchableOpacity className="rounded-lg bg-primary px-6 py-3" onPress={() => router.back()}>
          <Text className="font-semibold text-white">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const description = typeof recipeData.description === 'string' ? recipeData.description : '';
  const difficulty = typeof recipeData.difficulty === 'string' ? recipeData.difficulty : '';
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
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
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
                    ({recipeData.reviewCount} reviews)
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
              {recipeData.cookingTime}
            </Text>
            <Text className="text-xs text-gray-400">Total time</Text>
          </View>

          <View className="w-px bg-gray-100" />

          <TouchableOpacity
            className="flex-1 items-center"
            activeOpacity={0.7}
            onPress={() => setShowScaleModal(true)}>
            <Ionicons name="people-outline" size={22} color="#ff6b6b" />
            <Text className="mt-1 text-sm font-semibold text-gray-800">{servings}</Text>
            <Text className="text-xs text-gray-400">Servings</Text>
          </TouchableOpacity>

          <View className="w-px bg-gray-100" />

          <View className="flex-1 items-center">
            <Ionicons name="flame-outline" size={22} color="#ff6b6b" />
            <Text className="mt-1 text-sm font-semibold capitalize text-gray-800">
              {difficulty || '—'}
            </Text>
            <Text className="text-xs text-gray-400">Difficulty</Text>
          </View>
        </View>

        {description ? (
          <Text className="px-5 pt-5 text-base leading-6 text-gray-600">{description}</Text>
        ) : null}

        {/* Image Gallery */}
        {recipeImages.length > 1 && (
          <View className="pt-5">
            <Text className="mb-3 px-5 text-base font-semibold text-gray-800">
              Photos ({recipeImages.length})
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
            <Text className="ml-2 text-lg font-semibold text-white">Start Cooking</Text>
          </LinearGradient>
        </TouchableOpacity>

        {/* Tabs */}
        <Animated.View style={{ transform: [{ scale: tabScaleAnim }] }}>
          <View className="mx-5 mt-6 flex-row rounded-2xl bg-gray-100 p-1">
            {(['ingredients', 'directions'] as const).map((tab) => (
              <TouchableOpacity
                key={tab}
                onPress={() => switchTab(tab)}
                className="flex-1 rounded-xl py-3"
                style={
                  activeTab === tab
                    ? {
                        backgroundColor: 'white',
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 1 },
                        shadowOpacity: 0.1,
                        shadowRadius: 2,
                        elevation: 2,
                      }
                    : { backgroundColor: 'transparent' }
                }>
                <Text
                  className="text-center text-sm font-semibold capitalize"
                  style={{ color: activeTab === tab ? '#ff6b6b' : '#6B7280' }}>
                  {tab}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>

        {/* Tab Content */}
        <Animated.View style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}>
          <View className="px-5 pb-4 pt-5">
            {activeTab === 'ingredients' && (
              <View>
                <View className="mb-1 flex-row items-baseline justify-between">
                  <Text className="text-xl font-semibold text-gray-800">Ingredients</Text>
                  <Text className="text-sm text-gray-400">
                    {ingredients.length} items · {servings} servings
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
                    Add to Shopping List
                  </Text>
                </TouchableOpacity>

                {notes.length > 0 && (
                  <View className="mt-8">
                    <Text className="mb-3 text-xl font-semibold text-gray-800">Notes</Text>
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
                  <Text className="text-xl font-semibold text-gray-800">Directions</Text>
                  <Text className="text-sm text-gray-400">
                    {recipeData.instructions.length} steps
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
                            {Math.round(instruction.duration / 60)} min
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
                <Text className="text-xs text-gray-400">Recipe from {sourceName}</Text>
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
        </Animated.View>
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
              <Text className="text-xl font-semibold text-gray-800">Scale Recipe</Text>
              <TouchableOpacity onPress={() => setShowScaleModal(false)}>
                <Ionicons name="close" size={24} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <Text className="mb-4 text-center text-gray-600">Select number of servings</Text>

            <View className="mb-6 flex-row items-center justify-around">
              {[2, 4, 6, 8].map((count) => (
                <TouchableOpacity
                  key={count}
                  onPress={() => scaleServings(count)}
                  className={`h-12 w-12 items-center justify-center rounded-full ${
                    servings === count ? 'bg-primary' : 'bg-gray-100'
                  }`}>
                  <Text
                    className={`text-lg font-semibold ${
                      servings === count ? 'text-white' : 'text-gray-700'
                    }`}>
                    {count}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              onPress={() => setShowScaleModal(false)}
              className="rounded-2xl bg-primary py-4">
              <Text className="text-center text-lg font-semibold text-white">Update Recipe</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
