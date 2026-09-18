import RootStack from '../../../components/RootStack';
import { HOME_SCREENS } from '../../../lib/navigationRoutes';

export default function HomeLayout() {
  return <RootStack screens={HOME_SCREENS} />;
}
