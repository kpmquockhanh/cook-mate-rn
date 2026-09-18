import { LinearGradient } from 'expo-linear-gradient';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/AuthContext';
import { useTranslation } from '../lib/i18n';
import { currentDaypart, GREETING_KEY_FOR_DAYPART } from '../lib/daypart';

export default function HeaderSection() {
  const { t } = useTranslation();
  const { user } = useAuth();

  // The name set in Settings wins; the email prefix is only a stand-in for
  // accounts that never set one.
  const displayName = (user?.user_metadata?.display_name as string | undefined)?.trim();
  const greetingName =
    displayName || user?.email?.split('@')[0] || t('home.greetingFallbackName');

  return (
    <LinearGradient
      colors={['#FF6B6B', '#FF8E53']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={{
        paddingHorizontal: 24,
        paddingVertical: 24,
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
      }}>
      <View className="flex flex-row items-center justify-between gap-2">
        <View className="flex flex-row items-center gap-2">
          <Image
            source={{ uri: 'https://picsum.photos/200/300' }}
            className="h-12 w-12 rounded-full"
          />
          <View className="">
            <Text className="text-xl font-bold text-white">
              {t(GREETING_KEY_FOR_DAYPART[currentDaypart()], { name: greetingName })}
            </Text>
            <Text className="mt-1 text-sm text-white/90">{t('home.subtitle')}</Text>
          </View>
        </View>
        <View>
          <TouchableOpacity
            style={{
              borderRadius: 100,
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
              padding: 10,
            }}>
            <Ionicons name="notifications" size={20} color="white" />
          </TouchableOpacity>
        </View>
      </View>
    </LinearGradient>
  );
}
