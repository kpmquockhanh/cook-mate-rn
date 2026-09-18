import { View, Image } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { getImageUrl } from '../utils/index';
import { facetsOf, type MainIngredient, type Meal } from '../lib/recipeFacets';

/**
 * A recipe's picture, or a stand-in that does not look like a failure.
 *
 * Most recipes have no photo and never will: the publisher only republishes a
 * source's image when that source's licence allows it (publish/run.ts), and
 * only one of the five sources does - 26 of 45 recipes currently ship with a
 * null thumbnail. A grey rectangle eight times across a rail reads as a broken
 * app, so the empty state is a deliberate one instead: a tinted panel with the
 * dish's own icon, picked from the facets we already derive. Two chicken
 * recipes look related; a chicken and a cake do not.
 */

type Placeholder = {
  tint: string;
  ink: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
};

const BY_INGREDIENT: Record<MainIngredient, Placeholder> = {
  chicken: { tint: '#FEF3E2', ink: '#D98324', icon: 'food-drumstick' },
  beef: { tint: '#FDECEC', ink: '#C1554F', icon: 'food-steak' },
  pork: { tint: '#FDEEF3', ink: '#C4557A', icon: 'food-steak' },
  seafood: { tint: '#E8F4F6', ink: '#3E8C99', icon: 'fish' },
  pasta: { tint: '#FDF5E0', ink: '#C79A21', icon: 'pasta' },
  egg: { tint: '#FEF6E0', ink: '#CFA019', icon: 'egg' },
  veg: { tint: '#EAF5EC', ink: '#4A8C5C', icon: 'carrot' },
};

const BY_MEAL: Record<Meal, Placeholder> = {
  breakfast: { tint: '#FEF6E0', ink: '#CFA019', icon: 'egg' },
  lunch: { tint: '#EEF3EA', ink: '#6B8F5A', icon: 'bowl-mix' },
  dinner: { tint: '#FDEFE8', ink: '#C4703F', icon: 'pot-steam' },
  dessert: { tint: '#F6EEF8', ink: '#9A6BA8', icon: 'cupcake' },
  snack: { tint: '#FBF0E4', ink: '#B5793C', icon: 'bread-slice' },
  basics: { tint: '#F1F2F4', ink: '#7A8190', icon: 'bowl-mix' },
};

const FALLBACK: Placeholder = {
  tint: '#F3F4F6',
  ink: '#9CA3AF',
  icon: 'silverware-fork-knife',
};

/** The ingredient is the more specific fact, so it wins over the meal. */
function placeholderFor(recipe: Record<string, any>): Placeholder {
  const facets = facetsOf(recipe);
  if (facets.mainIngredient) return BY_INGREDIENT[facets.mainIngredient];
  if (facets.meal) return BY_MEAL[facets.meal];
  return FALLBACK;
}

export default function RecipeThumbnail({
  recipe,
  width,
  height,
  radius = 12,
  iconSize,
}: {
  recipe: Record<string, any>;
  width: number;
  height: number;
  radius?: number;
  iconSize?: number;
}) {
  const source = recipe?.thumbnail || recipe?.image || recipe?.image_url;

  if (source) {
    return (
      <Image
        source={{ uri: getImageUrl(source) }}
        style={{ width, height, borderRadius: radius }}
        resizeMode="cover"
      />
    );
  }

  const { tint, ink, icon } = placeholderFor(recipe);
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: tint,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <MaterialCommunityIcons
        name={icon}
        size={iconSize ?? Math.round(Math.min(width, height) * 0.36)}
        color={ink}
      />
    </View>
  );
}
