import { Tabs } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import '../../global.css';
import BlurTabBackground from 'components/Tabs/BlurTabBackground';
import SpecialTabBarButton from 'components/Tabs/SpecialTabBarButton';
import TimerTabIcon from 'components/Tabs/TimerTabIcon';
import { useTranslation } from '../../lib/i18n';
import { TAB_BAR_HEIGHT, TAB_SCENE_INSET } from '../../lib/navigationRoutes';

export default function TabLayout() {
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // #FF6B6B (used elsewhere for gradients/badges) is lighter in
        // luminance than the #999 inactive tint, so it reads as washed-out
        // against a white bar instead of standing out as the active state.
        tabBarActiveTintColor: '#EA4C4C',
        tabBarInactiveTintColor: '#999',
        tabBarStyle: {
          borderTopWidth: 0,
          position: 'absolute',
          bottom: 0,
          elevation: 0, // Remove shadow on Android
          paddingTop: 10,
          height: TAB_BAR_HEIGHT,
          borderTopLeftRadius: 30,
          borderTopRightRadius: 30,
          backgroundColor: 'transparent',
        },
        tabBarBackground: () => <BlurTabBackground />,
        sceneStyle: {
          marginBottom: TAB_SCENE_INSET,
        },
        headerStyle: {
          // backgroundColor: 'white',
          // elevation: 0,
          // shadowOpacity: 0,
          // borderBottomWidth: 0,
          // height: 60,
        },
        headerTitleStyle: {
          fontSize: 18,
          // fontWeight: '600',
          color: '#333',
          letterSpacing: 0.5,
          // backgroundColor: 'red',
        },
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerTintColor: '#333',
      }}>
      <Tabs.Screen
        name="(home)"
        options={{
          title: t('tabs.home'),
          headerTitle: t('tabs.homeHeader'),
          headerShown: false,
          tabBarIcon: ({ size, color }) => <MaterialIcons size={size} name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="shopping"
        options={{
          title: t('tabs.shopping'),
          headerTitle: t('tabs.shoppingHeader'),
          tabBarIcon: ({ size, color }) => (
            <MaterialIcons size={size} name="shopping-cart" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="record"
        options={{
          tabBarButton: () => <SpecialTabBarButton />,
        }}
        listeners={{
          tabPress: (e) => {
            console.log('tabPress');
            e.preventDefault();
          },
        }}
      />
      <Tabs.Screen
        name="timer"
        options={{
          title: t('tabs.timer'),
          headerTitle: t('tabs.timerHeader'),
          tabBarIcon: ({ size, color, focused }) => (
            <TimerTabIcon size={size} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          headerTitle: t('tabs.settings'),
          tabBarIcon: ({ size, color }) => (
            <MaterialIcons size={size} name="settings" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
