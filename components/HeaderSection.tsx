import { LinearGradient } from 'expo-linear-gradient';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useState, useEffect } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from 'lib/supabase';

export default function HeaderSection() {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
    })
    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
  }, [])

  return (<LinearGradient
    colors={['#FF6B6B', '#FF8E53']}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 0 }}
    style={{
      paddingHorizontal: 24,
      paddingVertical: 24,
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
    }}>
    <View className="flex flex-row items-center justify-between gap-2">
      <View className="flex flex-row items-center gap-2">
        <Image source={{ uri: "https://picsum.photos/200/300" }} className="h-12 w-12 rounded-full" />
        <View className="">
          <Text className="text-xl font-bold text-white">Good morning, {session?.user?.email?.split('@')[0] ?? 'User'}</Text>
          <Text className="mt-1 text-sm text-white/90">
            Ready to cook something delicious?
          </Text>
        </View>
      </View>
      <View>
        <TouchableOpacity style={{
          borderRadius: 100,
          backgroundColor: 'rgba(255, 255, 255, 0.2)',
          padding: 10,
        }}>
          <Ionicons name="notifications" size={20} color="white" />
        </TouchableOpacity>
      </View>
    </View>
  </LinearGradient>);
}