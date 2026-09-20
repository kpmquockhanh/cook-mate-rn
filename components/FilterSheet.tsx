import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from '../lib/i18n';
import type { TranslationKey } from '../lib/i18n/en';
import {
  DIET_LABEL,
  DIFFICULTY_LABEL,
  INGREDIENT_LABEL,
  MAX_MINUTES_LABEL,
  MEAL_LABEL,
} from '../lib/facetLabels';
import { DIETS, DIFFICULTIES, INGREDIENTS, MAX_MINUTES, MEALS } from '../lib/facetRoute';
import type { FacetFilter } from '../lib/recipeFacets';
import { isEmptyFilter } from '../lib/recipeFacets';

/**
 * The sheet behind the filter button on the search bar.
 *
 * Home's chips already cover the one-tap cases; this is for the cook who wants
 * two facets at once ("vegetarian, under 30 minutes"), which a row of
 * single-facet chips cannot express. It edits a draft and hands the whole
 * filter back on apply, so the list refetches once rather than on every tap.
 *
 * Each group is single-select and every option toggles, because the API ANDs
 * one value per facet - two meals would simply return nothing.
 */

type FilterSheetProps = {
  /** The filter currently applied; it seeds the draft. */
  value: FacetFilter;
  onClose: () => void;
  onApply: (filter: FacetFilter) => void;
};

/** A facet whose value is one of a fixed list. */
type Group<K extends keyof FacetFilter> = {
  title: TranslationKey;
  field: K;
  options: { value: NonNullable<FacetFilter[K]>; label: TranslationKey }[];
};

const TIME_GROUP: Group<'maxMinutes'> = {
  title: 'filter.time',
  field: 'maxMinutes',
  options: MAX_MINUTES.map((value) => ({ value, label: MAX_MINUTES_LABEL[value]! })),
};

const MEAL_GROUP: Group<'meal'> = {
  title: 'filter.meal',
  field: 'meal',
  options: MEALS.map((value) => ({ value, label: MEAL_LABEL[value] })),
};

const INGREDIENT_GROUP: Group<'mainIngredient'> = {
  title: 'filter.ingredient',
  field: 'mainIngredient',
  options: INGREDIENTS.map((value) => ({ value, label: INGREDIENT_LABEL[value] })),
};

const DIET_GROUP: Group<'diet'> = {
  title: 'filter.diet',
  field: 'diet',
  options: DIETS.map((value) => ({ value, label: DIET_LABEL[value] })),
};

const DIFFICULTY_GROUP: Group<'difficulty'> = {
  title: 'filter.difficulty',
  field: 'difficulty',
  options: DIFFICULTIES.map((value) => ({ value, label: DIFFICULTY_LABEL[value] })),
};

/** The flags, which stand on their own rather than in a value group. */
const TOGGLES: { field: 'handsOff' | 'favorites' | 'popular'; label: TranslationKey }[] = [
  { field: 'handsOff', label: 'facet.handsOff' },
  { field: 'favorites', label: 'facet.saved' },
  { field: 'popular', label: 'facet.popular' },
];

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`mb-2 mr-2 rounded-full border px-4 py-2.5 ${
        selected ? 'border-[#ff6b6b] bg-[#ff6b6b]' : 'border-gray-200 bg-white'
      }`}>
      <Text className={`text-sm font-medium ${selected ? 'text-white' : 'text-gray-700'}`}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Mounted only while open - the caller renders it behind its own flag - so the
 * draft is seeded once, on the way in, with no effect re-syncing it afterwards.
 */
export default function FilterSheet({ value, onClose, onApply }: FilterSheetProps) {
  const { t } = useTranslation();
  // A draft, so closing without applying leaves the list exactly as it was.
  const [draft, setDraft] = useState<FacetFilter>(value);

  /** Selecting the value already selected clears it - tap to undo. */
  function toggleValue<K extends keyof FacetFilter>(field: K, option: FacetFilter[K]) {
    setDraft((prev) => ({ ...prev, [field]: prev[field] === option ? undefined : option }));
  }

  function toggleFlag(field: 'handsOff' | 'favorites' | 'popular') {
    setDraft((prev) => ({ ...prev, [field]: prev[field] ? undefined : true }));
  }

  function renderGroup<K extends keyof FacetFilter>(group: Group<K>) {
    return (
      <View className="mt-5" key={group.field}>
        <Text className="mb-3 text-base font-semibold text-gray-900">{t(group.title)}</Text>
        <View className="flex-row flex-wrap">
          {group.options.map((option) => (
            <Chip
              key={String(option.value)}
              label={t(option.label)}
              selected={draft[group.field] === option.value}
              onPress={() => toggleValue(group.field, option.value as FacetFilter[K])}
            />
          ))}
        </View>
      </View>
    );
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {/* The backdrop is the second way out, next to the header's close button
          and Android's back gesture. */}
      <Pressable className="flex-1 bg-black/40" onPress={onClose} />
      <View className="max-h-[85%] rounded-t-3xl bg-white pb-8">
        <View className="items-center pt-3">
          <View className="h-1 w-10 rounded-full bg-gray-300" />
        </View>

        <View className="flex-row items-center justify-between px-5 pb-1 pt-3">
          <Text className="text-xl font-bold text-gray-900">{t('filter.title')}</Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('filter.close')}>
            <Ionicons name="close" size={22} color="#9CA3AF" />
          </TouchableOpacity>
        </View>

        <ScrollView className="px-5" showsVerticalScrollIndicator={false}>
          {renderGroup(TIME_GROUP)}
          {renderGroup(MEAL_GROUP)}
          {renderGroup(INGREDIENT_GROUP)}
          {renderGroup(DIET_GROUP)}
          {renderGroup(DIFFICULTY_GROUP)}

          <View className="mt-5 pb-2">
            <Text className="mb-3 text-base font-semibold text-gray-900">{t('filter.more')}</Text>
            <View className="flex-row flex-wrap">
              {TOGGLES.map((toggle) => (
                <Chip
                  key={toggle.field}
                  label={t(toggle.label)}
                  selected={draft[toggle.field] === true}
                  onPress={() => toggleFlag(toggle.field)}
                />
              ))}
            </View>
          </View>
        </ScrollView>

        <View className="flex-row items-center gap-x-3 border-t border-gray-100 px-5 pt-4">
          <TouchableOpacity
            className="rounded-2xl bg-gray-100 px-5 py-3.5"
            activeOpacity={0.7}
            disabled={isEmptyFilter(draft)}
            onPress={() => setDraft({})}>
            <Text
              className={`text-base font-medium ${
                isEmptyFilter(draft) ? 'text-gray-300' : 'text-gray-600'
              }`}>
              {t('filter.clearAll')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className="flex-1 items-center rounded-2xl bg-[#ff6b6b] py-3.5"
            activeOpacity={0.8}
            onPress={() => onApply(draft)}>
            <Text className="text-base font-semibold text-white">{t('filter.apply')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
