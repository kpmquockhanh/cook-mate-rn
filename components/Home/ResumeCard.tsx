import { View, Text, Image, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getImageUrl } from '../../utils/index';
import { useTranslation } from '../../lib/i18n';
import type { RecentCooking } from '../../lib/recentCooking';

/**
 * "You were cooking this." The first thing on the home screen, above search,
 * because a half-finished recipe is the most urgent thing the app can know
 * about - the user put the phone down to chop something and came back.
 *
 * It sits above the fold and takes one tap to resume. Dismissing it is
 * permanent for that session: someone who abandoned the dish should not have
 * to scroll past it every time they open the app.
 */
export default function ResumeCard({
  entry,
  onDismiss,
}: {
  entry: RecentCooking;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const { t } = useTranslation();

  const progress = entry.totalSteps > 0 ? entry.step / entry.totalSteps : 0;

  return (
    <View className="mx-5 mt-4 flex-row items-center rounded-2xl bg-white p-3 shadow-sm">
      <Image
        source={{ uri: getImageUrl(entry.thumbnail) }}
        className="h-16 w-16 rounded-xl"
        resizeMode="cover"
      />

      <View className="ml-3 flex-1">
        <View className="flex-row items-center">
          <View className="h-1.5 w-1.5 rounded-full bg-primary" />
          <Text className="ml-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            {t('home.resumeLabel')}
          </Text>
        </View>
        <Text className="mt-0.5 text-base font-semibold text-gray-800" numberOfLines={1}>
          {entry.title}
        </Text>

        <View className="mt-2 flex-row items-center">
          <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
            <View
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, Math.max(6, progress * 100))}%` }}
            />
          </View>
          <Text className="ml-2 text-xs text-gray-400">
            {t('home.resumeStep', { current: entry.step, total: entry.totalSteps })}
          </Text>
        </View>
      </View>

      <TouchableOpacity
        accessibilityLabel={t('home.resumeAction')}
        onPress={() => router.push(`/cooking/${entry.id}`)}
        className="ml-3 h-11 w-11 items-center justify-center rounded-full bg-primary">
        <Ionicons name="play" size={18} color="white" />
      </TouchableOpacity>

      {/* Small and quiet: dismissing is the rarer intent, and a big X next to
          a big Play is a mis-tap waiting to happen. */}
      <TouchableOpacity
        accessibilityLabel={t('home.resumeDismiss')}
        hitSlop={10}
        onPress={onDismiss}
        className="ml-1">
        <Ionicons name="close" size={16} color="#C7C7C7" />
      </TouchableOpacity>
    </View>
  );
}
