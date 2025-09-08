import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  TouchableOpacity,
  StatusBar,
  Dimensions,
  Modal,
  Animated,
  Alert,
  PanResponder,
  FlatList,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShopping } from '../../../lib/ShoppingContext';
import { Note, useRecipe, type Ingredient } from '../../../hooks/useRecipe';
import { getImageUrl } from '../../../utils/index';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

export default function RecipeDetailPage() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { addRecipeItems, isLoaded: shoppingLoaded } = useShopping();

  // Use the new useRecipe hook
  const { data: recipeData, loading, error } = useRecipe({ id: id as string });

  const [activeTab, setActiveTab] = useState<'ingredients' | 'directions' | 'reviews'>(
    'ingredients'
  );
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

  // Generate sample images for demonstration (in real app, this would come from recipeData.images)
  const recipeImages = React.useMemo(() => {
    if (!recipeData?.thumbnail) return [];
    
    // Use actual images from API if available
    if (recipeData.images && recipeData.images.length > 0) {
      return recipeData.images.map((image) => image.image_path);
    }
    
    // Create an array of images - first is the main thumbnail, then some variations
    const baseImage = recipeData.thumbnail;
    const images = [baseImage];
    
    return images;
  }, [recipeData?.thumbnail, recipeData?.images]);

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

  // Pan responder for swipe-to-go-back gesture
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

  const switchTab = (newTab: 'ingredients' | 'directions' | 'reviews') => {
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
    const tabOrder = ['ingredients', 'directions', 'reviews'];
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

  const renderStars = (rating: number) => {
    return (
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
            size={16}
            color="#FFD700"
          />
        ))}
      </View>
    );
  };

  const renderImageItem = ({ item, index }: { item: string; index: number }) => (
    <TouchableOpacity
      onPress={() => setSelectedImageIndex(index)}
      className={`mr-3 overflow-hidden rounded-xl ${
        selectedImageIndex === index ? 'border-2 border-orange-500' : 'border border-gray-200'
      }`}
      style={{
        width: 80,
        height: 80,
      }}>
      <Image
        source={{ uri: getImageUrl(item) }}
        className="h-full w-full"
        resizeMode="cover"
      />
    </TouchableOpacity>
  );

  // Show loading state
  if (loading || !shoppingLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <StatusBar barStyle="dark-content" />
        <Text className="mb-4 text-lg text-gray-600">
          {loading ? 'Loading recipe...' : 'Loading shopping list...'}
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
        <TouchableOpacity
          className="rounded-lg bg-primary px-6 py-3"
          onPress={() => router.back()}>
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
        <TouchableOpacity
          className="rounded-lg bg-primary px-6 py-3"
          onPress={() => router.back()}>
          <Text className="font-semibold text-white">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-white" {...panResponder.panHandlers}>
      <StatusBar barStyle="light-content" />

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 10,
          paddingBottom: insets.bottom + 20,
        }}>
        {/* Hero Image */}
        <View>
          {/* Favorite Button Overlay */}
          <View className="absolute right-8 top-4 z-10">
            <TouchableOpacity
              onPress={toggleFavorite}
              className="h-12 w-12 items-center justify-center rounded-full bg-black/40"
              style={{
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.25,
                shadowRadius: 3.84,
                elevation: 5,
              }}>
              <Ionicons
                name={isFavorite ? 'heart' : 'heart-outline'}
                size={24}
                color={isFavorite ? '#FF6B6B' : 'white'}
              />
            </TouchableOpacity>
          </View>

          <View className="relative flex flex-col">
            <Image
              source={{ uri: getImageUrl(recipeImages[selectedImageIndex] || recipeData.thumbnail) }}
              style={{ width, height: width * 0.5, paddingHorizontal: 20, borderRadius: 12 }}
              resizeMode="cover"
            />

            {/* Overlay Content */}
            <View
              className="absolute bottom-0 left-0 right-0 my-4 w-full"
              style={{ paddingHorizontal: 35 }}>
              <Text className="mb-4 text-3xl font-bold text-white">{recipeData.title}</Text>

              <View className="flex-row items-center">
                <View className="mr-6 flex-row items-center">
                  <Ionicons name="time" size={20} color="white" />
                  <Text className="ml-2 font-medium text-white">{recipeData.cookingTime}</Text>
                </View>

                <View className="mr-6 flex-row items-center">
                  <Ionicons name="people" size={20} color="white" />
                  <Text className="ml-2 font-medium text-white">{servings}</Text>
                </View>

                <View className="flex-row items-center">
                  {renderStars(recipeData.rating)}
                  <Text className="ml-2 font-medium text-white">{recipeData.rating}</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Image Gallery */}
        {recipeImages.length > 1 && (
          <View className="px-6 py-4">
            <View className="mb-3 flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-gray-800">Recipe Photos</Text>
              <Text className="text-sm text-gray-500">{recipeImages.length} photos</Text>
            </View>
            <FlatList
              data={recipeImages}
              renderItem={renderImageItem}
              keyExtractor={(item, index) => `image-${index}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingRight: 20 }}
            />
          </View>
        )}

        {/* Start Cooking Button */}
        <View className="px-6 py-4">
          <TouchableOpacity
            className="items-center rounded-2xl py-4"
            onPress={() => router.push(`/cooking/${id}`)}>
              <LinearGradient
    colors={['#FF6B6B', '#FF8E53']}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 0 }}
    className="flex-1 items-center justify-center p-4"
    style={{
      borderRadius: 12,
      padding: 12,
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <Text className="text-lg font-semibold text-white">Start Cooking</Text>
    </LinearGradient>
            
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <Animated.View
          className="mx-6 my-4 flex-row rounded-xl bg-gray-100 p-1"
          style={{
            transform: [{ scale: tabScaleAnim }],
          }}>
          {(['ingredients', 'directions'] as const).map((tab) => (
            <TouchableOpacity
              key={tab}
              onPress={() => switchTab(tab)}
              className={`flex-1 rounded-lg py-3`}
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
                  : {
                      backgroundColor: 'transparent',
                    }
              }>
              <Text
                className="text-center text-sm font-semibold capitalize"
                style={{
                  color: activeTab === tab ? '#F97316' : '#6B7280',
                }}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </Animated.View>

        {/* Tab Content */}
        <Animated.View
          className="px-6 pb-4"
          style={{
            opacity: fadeAnim,
            transform: [{ translateX: slideAnim }],
          }}>
          {activeTab === 'ingredients' && (
            <View>

              {/* Title */}
              <View className="mb-4 flex-row items-center justify-between">
                <Text className="text-xl font-semibold text-gray-800">
                  Ingredients ({servings} servings)
                </Text>
              </View>

              {/* Content */}
              <View>
                {ingredients.map((ingredient) => (
                  <TouchableOpacity
                    key={ingredient.id}
                    onPress={() => toggleIngredientCheck(ingredient.id)}
                    className="flex-row items-center py-3">
                    <View
                      className={`mr-4 h-6 w-6 items-center justify-center rounded border-2 ${
                        ingredient.checked ? 'border-orange-500 bg-primary' : 'border-gray-300'
                      }`}>
                      {ingredient.checked && <Ionicons name="checkmark" size={16} color="white" />}
                    </View>
                    <Text
                      className={`flex-1 text-base ${
                        ingredient.checked ? 'text-gray-500 line-through' : 'text-gray-800'
                      }`}>
                      {ingredient.ingredient_text}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                className="mt-6 flex-row items-center justify-center rounded-2xl border border-gray-300 py-4"
                onPress={handleAddToShoppingList}>
                <Ionicons name="bag-outline" size={24} color="#374151" />
                <Text className="ml-3 text-lg font-medium text-gray-700">Add to Shopping List</Text>
              </TouchableOpacity>

               {/* Title */}
               <View className="mt-6 mb-4 flex-row items-center justify-between">
                <Text className="text-xl font-semibold text-gray-800">Notes</Text>
              </View>
              {/* Content */}
              <View>
                {notes.map((note, index) => (
                  <View key={index} className="mb-6 flex-row">
                  <View className="mr-4 h-8 w-8 items-center justify-center rounded-full bg-primary">
                    <Text className="font-semibold text-white">{index + 1}</Text>
                  </View>
                  <Text className="flex-1 text-base leading-6 text-gray-700">
                      {note.note_text}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {activeTab === 'directions' && (
            <View>
              <Text className="mb-4 text-xl font-semibold text-gray-800">Directions</Text>
              <View>
                {recipeData.instructions.map((instruction, index: number) => (
                  <View key={index} className="mb-6 flex-row">
                    <View className="mr-4 h-8 w-8 items-center justify-center rounded-full bg-primary">
                      <Text className="font-semibold text-white">{index + 1}</Text>
                    </View>
                    <Text className="flex-1 text-base leading-6 text-gray-700">
                      {instruction.instruction_text}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* {activeTab === 'reviews' && (
              <View>
                <Text className="mb-4 text-xl font-semibold text-gray-800">Reviews</Text>
                <View>
                  {recipeData.reviews.map((review: any) => (
                    <View key={review.id} className="mb-4 rounded-lg bg-gray-50 p-4">
                      <View className="mb-2 flex-row items-center justify-between">
                        <Text className="font-semibold text-gray-800">{review.user}</Text>
                        {renderStars(review.rating)}
                      </View>
                      <Text className="text-gray-600">{review.comment}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )} */}
        </Animated.View>
      </ScrollView>

      {/* Scale Recipe Modal */}
      <Modal
        visible={showScaleModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowScaleModal(false)}>
        <View className="flex-1 justify-end bg-black/50">
          <View className="rounded-t-3xl bg-white p-6">
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
