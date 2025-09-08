import { SafeAreaView } from 'react-native';

export const Container = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return <SafeAreaView className={`${styles.container} ${className}`}>{children}</SafeAreaView>;
};

const styles = {
  container: 'flex flex-1 bg-gray-50 pb-20',
};
