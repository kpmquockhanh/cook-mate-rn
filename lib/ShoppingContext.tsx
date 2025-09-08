import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string;
  checked: boolean;
  category: 'recipe' | 'manual';
  recipeSource?: string;
}

interface ShoppingContextType {
  items: ShoppingItem[];
  isLoaded: boolean;
  addItem: (item: Omit<ShoppingItem, 'id'>) => void;
  addRecipeItems: (recipeItems: Omit<ShoppingItem, 'id'>[], recipeTitle: string) => void;
  toggleItemCheck: (id: string) => void;
  removeItem: (id: string) => void;
  removeRecipeItems: (recipeSource: string) => void;
  clearAllItems: () => void;
  updateItems: (items: ShoppingItem[]) => void;
  clearStorage: () => Promise<void>;
}

const ShoppingContext = createContext<ShoppingContextType | undefined>(undefined);


export function ShoppingProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load items from AsyncStorage on mount
  useEffect(() => {
    const loadItems = async () => {
      try {
        const storedItems = await AsyncStorage.getItem('shoppingList');
        console.log('storedItems', storedItems);
        if (storedItems) {
          setItems(JSON.parse(storedItems));
        } else {
          // Load initial items if no stored data
          setItems([]);
        }
      } catch (error) {
        console.error('Error loading shopping list from storage:', error);
        setItems([]);
      } finally {
        setIsLoaded(true);
      }
    };

    loadItems();
  }, []);

  // Save items to AsyncStorage whenever items change
  useEffect(() => {
    if (isLoaded) {
      const saveItems = async () => {
        try {
          await AsyncStorage.setItem('shoppingList', JSON.stringify(items));
        } catch (error) {
          console.error('Error saving shopping list to storage:', error);
        }
      };

      saveItems();
    }
  }, [items, isLoaded]);

  const addItem = (item: Omit<ShoppingItem, 'id'>) => {
    const newItem: ShoppingItem = {
      ...item,
      id: Date.now().toString(),
    };
    setItems(prev => [...prev, newItem]);
  };

  const addRecipeItems = (recipeItems: Omit<ShoppingItem, 'id'>[], recipeTitle: string) => {
    const newItems: ShoppingItem[] = recipeItems.map((item, index) => ({
      ...item,
      id: `${Date.now()}-${index}`,
      category: 'recipe' as const,
      recipeSource: recipeTitle,
    }));
    
    // Filter out items that already exist from the same recipe
    setItems(prev => {
      const filtered = prev.filter(existingItem => 
        existingItem.recipeSource !== recipeTitle
      );
      return [...filtered, ...newItems];
    });
  };

  const toggleItemCheck = (id: string) => {
    setItems(prev => prev.map(item => 
      item.id === id ? { ...item, checked: !item.checked } : item
    ));
  };

  const removeItem = (id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const removeRecipeItems = (recipeSource: string) => {
    setItems(prev => prev.filter(item => item.recipeSource !== recipeSource));
  };

  const clearAllItems = () => {
    setItems([]);
  };

  const updateItems = (newItems: ShoppingItem[]) => {
    setItems(newItems);
  };

  const clearStorage = async () => {
    try {
      await AsyncStorage.removeItem('shoppingList');
      setItems([]);
    } catch (error) {
      console.error('Error clearing shopping list storage:', error);
    }
  };

  return (
    <ShoppingContext.Provider value={{
      items,
      isLoaded,
      addItem,
      addRecipeItems,
      toggleItemCheck,
      removeItem,
      removeRecipeItems,
      clearAllItems,
      updateItems,
      clearStorage,
    }}>
      {children}
    </ShoppingContext.Provider>
  );
}

export function useShopping() {
  const context = useContext(ShoppingContext);
  if (context === undefined) {
    throw new Error('useShopping must be used within a ShoppingProvider');
  }
  return context;
}
