import { Container } from 'components/Container';
import { Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';

export default function Record() {
  return (
    <>
      <Container>
        <Text className="text-2xl font-bold">This is from record page</Text>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}
