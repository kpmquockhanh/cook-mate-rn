import { Container } from 'components/Container';
import { Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from '../../lib/i18n';

export default function Record() {
  const { t } = useTranslation();

  return (
    <>
      <Container>
        <Text className="text-2xl font-bold">{t('record.placeholder')}</Text>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}
