import { Tabs } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import '../../global.css';
import BlurTabBackground from 'components/Tabs/BlurTabBackground';
import SpecialTabBarButton from 'components/Tabs/SpecialTabBarButton';
import TimerTabIcon from 'components/Tabs/TimerTabIcon';

export default function TabLayout() {
  return (    
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#FF6B6B',
        tabBarInactiveTintColor: '#999',
        tabBarStyle: {
          borderTopWidth: 0,
          position: 'absolute',
          bottom: 0,
          elevation: 0, // Remove shadow on Android
          paddingTop: 10,
          height: 80,
          borderTopLeftRadius: 30,
          borderTopRightRadius: 30,
          backgroundColor: 'transparent',
        },
        tabBarBackground: () => <BlurTabBackground />,
        sceneStyle: {
          marginBottom: 40,
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
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          headerTitle: 'Recipe Hub',
          headerShown: false,
          tabBarIcon: ({ size, color }) => (
            <MaterialIcons size={size} name="home" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="shopping"
        options={{
          title: 'Shopping',
          headerTitle: 'Shopping List',
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
          title: 'Timer',
          headerTitle: 'Cooking Timer',
          tabBarIcon: ({ size, color, focused }) => (
            <TimerTabIcon size={size} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerTitle: 'Settings',
          tabBarIcon: ({ size, color }) => (
            <MaterialIcons size={size} name="settings" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="all-recipes"
        options={{
          headerTitle: 'All recipes',
          headerShown: false,
          href: null, // This hides the tab from the tab bar
        }}
      />
      <Tabs.Screen
        name="recipe/[id]"
        options={{
          headerTitle: 'Recipe details',
          headerShown: false,
          href: null, // This hides the tab from the tab bar
        }}
      />
      </Tabs>
  );
}