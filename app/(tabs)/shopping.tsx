import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useShopping, ShoppingItem } from '../../lib/ShoppingContext';
import { useTranslation } from '../../lib/i18n';

type CategoryId = 'all' | 'recipe' | 'manual';

interface Category {
  id: CategoryId;
  active: boolean;
}

// The filters hold ids only; their labels and their empty states are looked up
// at render time so they follow the language.
const initialCategories: Category[] = [
  { id: 'all', active: true },
  { id: 'recipe', active: false },
  { id: 'manual', active: false },
];

export default function Shopping() {
  const { t } = useTranslation();
  const { items, toggleItemCheck, removeItem, removeRecipeItems, addItem, clearAllItems } =
    useShopping();
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [newItem, setNewItem] = useState('');
  const [newQuantity, setNewQuantity] = useState('');
  const [showQuantityInput, setShowQuantityInput] = useState(false);

  const categoryLabel = (id: CategoryId) =>
    id === 'recipe'
      ? t('shopping.filterRecipe')
      : id === 'manual'
        ? t('shopping.filterManual')
        : t('shopping.filterAll');

  const addNewItem = () => {
    if (newItem.trim()) {
      addItem({
        name: newItem.trim(),
        quantity: newQuantity.trim(),
        checked: false,
        category: 'manual',
      });
      setNewItem('');
      setNewQuantity('');
      setShowQuantityInput(false);
    }
  };

  const handleItemInputSubmit = () => {
    if (newItem.trim()) {
      if (showQuantityInput) {
        addNewItem();
      } else {
        setShowQuantityInput(true);
      }
    }
  };

  const handleQuantityInputSubmit = () => {
    addNewItem();
  };

  const setActiveCategory = (categoryId: CategoryId) => {
    setCategories(
      categories.map((cat) =>
        cat.id === categoryId ? { ...cat, active: true } : { ...cat, active: false }
      )
    );
  };

  const getTotalItems = () => items.length;

  const getRecipeItems = () => items.filter((item) => item.category === 'recipe');
  const getManualItems = () => items.filter((item) => item.category === 'manual');

  const getRecipeItemsBySource = () => {
    const recipeItems = getRecipeItems();
    const groupedBySource: { [key: string]: typeof recipeItems } = {};

    recipeItems.forEach((item) => {
      const source = item.recipeSource || t('shopping.unknownRecipe');
      if (!groupedBySource[source]) {
        groupedBySource[source] = [];
      }
      groupedBySource[source].push(item);
    });

    return groupedBySource;
  };

  const getFilteredItems = () => {
    const activeCategory = categories.find((cat) => cat.active);
    if (!activeCategory) return items;

    switch (activeCategory.id) {
      case 'recipe':
        return getRecipeItems();
      case 'manual':
        return getManualItems();
      default:
        return items;
    }
  };

  const getFilteredRecipeItemsBySource = () => {
    const activeCategory = categories.find((cat) => cat.active);
    if (activeCategory?.id === 'manual') {
      return {};
    }
    return getRecipeItemsBySource();
  };

  const activeCategoryId = categories.find((cat) => cat.active)?.id ?? 'all';

  const renderShoppingItem = (item: ShoppingItem, showDeleteButton = false) => (
    <View key={item.id} style={styles.itemContainer}>
      <TouchableOpacity style={styles.itemContent} onPress={() => toggleItemCheck(item.id)}>
        <View style={[styles.checkbox, item.checked && styles.checkedCheckbox]}>
          {item.checked && <MaterialIcons name="check" size={16} color="white" />}
        </View>
        <View style={styles.itemDetails}>
          <Text style={[styles.itemName, item.checked && styles.checkedItemName]}>{item.name}</Text>
          {item.quantity ? <Text style={styles.itemQuantity}>{item.quantity}</Text> : null}
        </View>
      </TouchableOpacity>
      {showDeleteButton && (
        <TouchableOpacity style={styles.deleteButton} onPress={() => removeItem(item.id)}>
          <MaterialIcons name="close" size={20} color="#999" />
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <>
      <Container>
        <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 100 }}>
          <View className="mt-6 flex flex-col gap-4">
            {/* List Info */}
            <View style={styles.listInfo}>
              <View
                style={{
                  flexGrow: 1,
                }}>
                <Text style={styles.listTitle}>{t('shopping.title')}</Text>
                <Text style={styles.listStats}>
                  {t('shopping.itemCount', { count: getTotalItems() })}
                </Text>
              </View>
              <TouchableOpacity style={styles.clearButton} onPress={clearAllItems}>
                <Text style={styles.clearButtonText}>{t('shopping.clearAll')}</Text>
              </TouchableOpacity>
            </View>

            {/* Category Filters */}
            <View style={styles.categoryContainer}>
              {categories.map((category) => (
                /* Pressable rather than TouchableOpacity: onPress re-renders this
                 button with a new style, which strands TouchableOpacity's
                 fade-back animation and leaves the active chip washed out. Keep
                 the style a plain object/array -- NativeWind's jsx runtime
                 ignores the ({ pressed }) => [] form. */
                <Pressable
                  key={category.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: category.active }}
                  style={[styles.categoryButton, category.active && styles.activeCategoryButton]}
                  onPress={() => setActiveCategory(category.id)}>
                  <Text style={[styles.categoryText, category.active && styles.activeCategoryText]}>
                    {categoryLabel(category.id)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Add Item Input */}
          <View style={styles.addItemContainer}>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput}
                placeholder={t('shopping.addPlaceholder')}
                value={newItem}
                onChangeText={setNewItem}
                onSubmitEditing={handleItemInputSubmit}
              />
            </View>
            <TouchableOpacity style={styles.addButton} onPress={handleItemInputSubmit}>
              <MaterialIcons name="add" size={24} color="white" />
            </TouchableOpacity>
          </View>

          {/* Quantity Input */}
          {showQuantityInput && (
            <View style={styles.quantityInputContainer}>
              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.textInput}
                  placeholder={t('shopping.quantityPlaceholder')}
                  value={newQuantity}
                  onChangeText={setNewQuantity}
                  onSubmitEditing={handleQuantityInputSubmit}
                />
              </View>
              <TouchableOpacity style={styles.addButton} onPress={handleQuantityInputSubmit}>
                <MaterialIcons name="check" size={24} color="white" />
              </TouchableOpacity>
            </View>
          )}

          {/* Empty State */}
          {getFilteredItems().length === 0 && (
            <View style={styles.emptyState}>
              <MaterialIcons name="shopping-cart" size={64} color="#DDD" />
              <Text style={styles.emptyStateTitle}>
                {/* One key per filter rather than a name dropped into a
                    sentence: "No {noun} found" only reads well in English. */}
                {activeCategoryId === 'all'
                  ? t('shopping.emptyTitle')
                  : activeCategoryId === 'recipe'
                    ? t('shopping.emptyRecipeTitle')
                    : t('shopping.emptyManualTitle')}
              </Text>
              <Text style={styles.emptyStateSubtitle}>
                {activeCategoryId === 'all'
                  ? t('shopping.emptyHint')
                  : t('shopping.emptyFilterHint')}
              </Text>
            </View>
          )}

          {/* Recipe Items Sections */}
          {Object.entries(getFilteredRecipeItemsBySource()).map(([recipeSource, recipeItems]) => (
            <View key={recipeSource} style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>
                  {t('shopping.fromRecipe', { recipe: recipeSource })}
                </Text>
                <TouchableOpacity
                  style={styles.removeRecipeButton}
                  onPress={() => removeRecipeItems(recipeSource)}>
                  <MaterialIcons name="delete-outline" size={20} color="#FF6B6B" />
                </TouchableOpacity>
              </View>
              {recipeItems.map((item) => renderShoppingItem(item))}
            </View>
          ))}

          {/* Manual Items Section */}
          {getManualItems().length > 0 && activeCategoryId !== 'recipe' && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{t('shopping.manualSection')}</Text>
              </View>
              {getManualItems().map((item) => renderShoppingItem(item, true))}
            </View>
          )}
        </ScrollView>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 50,
    paddingBottom: 20,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
  },
  listInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 20,
    gap: 12,
  },
  listTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 4,
  },
  listStats: {
    fontSize: 14,
    color: '#666',
  },
  clearButton: {
    alignSelf: 'center',
    margin: 'auto',
    backgroundColor: '#FF6B6B',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  clearButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '500',
  },
  categoryContainer: {
    flexDirection: 'row',
    marginBottom: 20,
    gap: 12,
  },
  categoryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f5f5f5',
  },
  activeCategoryButton: {
    backgroundColor: '#FF6B6B',
  },
  categoryText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '500',
  },
  activeCategoryText: {
    color: 'white',
  },
  addItemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 12,
  },
  quantityInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 30,
    gap: 12,
  },
  inputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    color: '#333',
  },
  addButton: {
    backgroundColor: '#FF6B6B',
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginBottom: 30,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  removeRecipeButton: {
    padding: 4,
  },
  itemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  itemContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#ddd',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  checkedCheckbox: {
    backgroundColor: '#4CAF50',
    borderColor: '#4CAF50',
  },
  itemDetails: {
    flex: 1,
  },
  itemName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
    marginBottom: 2,
  },
  checkedItemName: {
    color: '#999',
    textDecorationLine: 'line-through',
  },
  itemQuantity: {
    fontSize: 14,
    color: '#666',
  },
  deleteButton: {
    padding: 8,
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
});
