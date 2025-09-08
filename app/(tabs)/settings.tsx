import { Container } from 'components/Container';
import { Text, TouchableOpacity, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useAuth } from '../../lib/AuthContext';

export default function Settings() {
  const { signOut, user } = useAuth();

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <>
      <Container className="">
        <View className="flex items-center justify-center m-5">
        <Text className="text-2xl font-bold">Settings</Text>
        {user && (
          <>
            <Text className="text-gray-600 mt-4">
              Signed in as: {user.email}
            </Text>
            <TouchableOpacity 
              className="bg-primary text-white px-4 py-2 rounded-md flex items-center justify-center mt-4 m-7"
              onPress={handleSignOut}
            >
              <Text className="text-white">Sign Out</Text>
            </TouchableOpacity>
          </>
        )}
        </View>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}
