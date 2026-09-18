import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useAuth } from '../../lib/AuthContext';
import { useShopping } from '../../lib/ShoppingContext';
import {
  useSettings,
  PRE_ALERT_CHOICES,
  SERVINGS_RANGE,
  SPEECH_RATE_RANGE,
} from '../../lib/SettingsContext';
import { supabase } from '../../lib/supabase';
import { confirmAction, notify } from '../../utils/confirm';
import { errorMessage } from '../../lib/log';
import {
  SettingsSection,
  ToggleRow,
  SegmentedRow,
  StepperRow,
  ActionRow,
} from '../../components/Settings/SettingsControls';
import { LANGUAGES, useTranslation, type Language, type Translator } from '../../lib/i18n';

const PRIMARY = '#ff6b6b';

/** "Off", "30s", "1 min", "5 min" - the pre-alert choices, as the user reads them. */
function formatPreAlert(seconds: number, t: Translator): string {
  if (seconds === 0) return t('duration.off');
  if (seconds < 60) return t('duration.secondsShort', { count: seconds });
  return t('duration.minutes', { count: seconds / 60 });
}

export default function Settings() {
  const { t } = useTranslation();
  const { signOut, user } = useAuth();
  const { items: shoppingItems, clearStorage } = useShopping();
  const { settings, isLoaded, updateSetting, resetSettings } = useSettings();

  const storedName = (user?.user_metadata?.display_name as string | undefined) ?? '';
  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(storedName);
  const [savingName, setSavingName] = useState(false);

  const appVersion = useMemo(() => {
    const version = Constants.expoConfig?.version;
    return version ? `v${version}` : undefined;
  }, []);

  const handleSignOut = async () => {
    const confirmed = await confirmAction({
      title: t('settings.signOutTitle'),
      message: t('settings.signOutMessage'),
      confirmLabel: t('settings.signOut'),
      destructive: true,
    });
    if (confirmed) await signOut();
  };

  const handleSaveName = async () => {
    const next = nameDraft.trim();
    setSavingName(true);
    try {
      // The auth listener in AuthContext picks the updated user up from the
      // USER_UPDATED event, so nothing here has to write it back into state.
      const { error } = await supabase.auth.updateUser({ data: { display_name: next } });
      if (error) throw error;
      setNameModalOpen(false);
    } catch (error) {
      notify(t('settings.nameSaveError'), errorMessage(error, t('common.tryAgain')));
    } finally {
      setSavingName(false);
    }
  };

  const handleClearShoppingList = async () => {
    const confirmed = await confirmAction({
      title: t('settings.clearShoppingListTitle'),
      message: t('settings.clearShoppingListMessage', { count: shoppingItems.length }),
      confirmLabel: t('common.clear'),
      destructive: true,
    });
    if (confirmed) await clearStorage();
  };

  const handleReset = async () => {
    const confirmed = await confirmAction({
      title: t('settings.resetTitle'),
      message: t('settings.resetMessage'),
      confirmLabel: t('settings.reset'),
      destructive: true,
    });
    if (confirmed) resetSettings();
  };

  // Household scaling is one setting stored as `number | null`, but two
  // controls: a switch for "do it at all" and a stepper for the size. The
  // stepper needs something to show while the switch is off, so it falls back
  // to a sensible household rather than collapsing to zero.
  const servingsOn = settings.defaultServings !== null;
  const servingsValue = settings.defaultServings ?? 4;

  if (!isLoaded) {
    return (
      <Container>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
        <StatusBar style="auto" />
      </Container>
    );
  }

  return (
    <Container>
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 }}>
        <Text className="mb-5 text-3xl font-bold text-gray-800">{t('settings.title')}</Text>

        <SettingsSection title={t('settings.accountSection')}>
          <ActionRow
            icon="person-outline"
            label={t('settings.name')}
            description={storedName || t('settings.nameDescription')}
            value={storedName || t('common.notSet')}
            onPress={() => {
              setNameDraft(storedName);
              setNameModalOpen(true);
            }}
          />
          <ActionRow
            icon="mail-outline"
            label={t('settings.email')}
            value={user?.email ?? t('common.unknown')}
          />
          <ActionRow
            icon="logout"
            label={t('settings.signOut')}
            onPress={handleSignOut}
            destructive
            divider={false}
          />
        </SettingsSection>

        <SettingsSection
          title={t('settings.languageSection')}
          footer={t('settings.languageFooter')}>
          <SegmentedRow<Language>
            icon="translate"
            label={t('settings.language')}
            description={t('settings.languageDescription')}
            value={settings.language}
            options={LANGUAGES.map((option) => ({ label: option.label, value: option.code }))}
            onChange={(value) => updateSetting('language', value)}
            divider={false}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.cookingSection')} footer={t('settings.cookingFooter')}>
          <ToggleRow
            icon="groups"
            label={t('settings.scaleRecipes')}
            description={t('settings.scaleRecipesDescription')}
            value={servingsOn}
            onChange={(on) => updateSetting('defaultServings', on ? servingsValue : null)}
          />
          <StepperRow
            icon="restaurant"
            label={t('settings.householdSize')}
            value={servingsValue}
            min={SERVINGS_RANGE.min}
            max={SERVINGS_RANGE.max}
            disabled={!servingsOn}
            format={(value) => t('settings.servingsValue', { count: value })}
            onChange={(value) => updateSetting('defaultServings', value)}
          />
          <ToggleRow
            icon="visibility"
            label={t('settings.keepScreenOn')}
            description={t('settings.keepScreenOnDescription')}
            value={settings.keepScreenAwake}
            onChange={(value) => updateSetting('keepScreenAwake', value)}
          />
          <ToggleRow
            icon="brightness-high"
            label={t('settings.brightness')}
            description={t('settings.brightnessDescription')}
            value={settings.boostBrightness}
            onChange={(value) => updateSetting('boostBrightness', value)}
            divider={false}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.voiceSection')} footer={t('settings.voiceFooter')}>
          <ToggleRow
            icon="mic-none"
            label={t('settings.voiceAssistant')}
            description={t('settings.voiceAssistantDescription')}
            value={settings.voiceEnabled}
            onChange={(value) => updateSetting('voiceEnabled', value)}
          />
          <ToggleRow
            icon="play-circle-outline"
            label={t('settings.voiceAutoStart')}
            description={t('settings.voiceAutoStartDescription')}
            value={settings.voiceAutoStart}
            disabled={!settings.voiceEnabled}
            onChange={(value) => updateSetting('voiceAutoStart', value)}
          />
          <ToggleRow
            icon="record-voice-over"
            label={t('settings.spokenSteps')}
            description={t('settings.spokenStepsDescription')}
            value={settings.spokenSteps}
            onChange={(value) => updateSetting('spokenSteps', value)}
          />
          <StepperRow
            icon="speed"
            label={t('settings.speechRate')}
            value={settings.speechRate}
            min={SPEECH_RATE_RANGE.min}
            max={SPEECH_RATE_RANGE.max}
            step={0.1}
            disabled={!settings.spokenSteps}
            format={(value) => `${value.toFixed(1)}×`}
            onChange={(value) => updateSetting('speechRate', value)}
            divider={false}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.timersSection')} footer={t('settings.timersFooter')}>
          {Platform.OS !== 'web' && (
            <ToggleRow
              icon="vibration"
              label={t('settings.vibrate')}
              description={t('settings.vibrateDescription')}
              value={settings.timerVibrate}
              onChange={(value) => updateSetting('timerVibrate', value)}
            />
          )}
          <ToggleRow
            icon="notifications-none"
            label={t('settings.alertDialog')}
            description={t('settings.alertDialogDescription')}
            value={settings.timerAlertDialog}
            onChange={(value) => updateSetting('timerAlertDialog', value)}
          />
          <SegmentedRow
            icon="timelapse"
            label={t('settings.earlyWarning')}
            description={t('settings.earlyWarningDescription')}
            value={settings.timerPreAlertSeconds}
            options={PRE_ALERT_CHOICES.map((seconds) => ({
              label: formatPreAlert(seconds, t),
              value: seconds as number,
            }))}
            onChange={(value) => updateSetting('timerPreAlertSeconds', value)}
            divider={false}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.dataSection')}>
          <ActionRow
            icon="remove-shopping-cart"
            label={t('settings.clearShoppingList')}
            value={t('settings.shoppingItemCount', { count: shoppingItems.length })}
            onPress={handleClearShoppingList}
            destructive
          />
          <ActionRow
            icon="settings-backup-restore"
            label={t('settings.resetAll')}
            onPress={handleReset}
            destructive
            divider={false}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.aboutSection')}>
          <ActionRow
            icon="info-outline"
            label={t('settings.version')}
            value={appVersion}
            divider={false}
          />
        </SettingsSection>
      </ScrollView>

      <Modal
        visible={nameModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setNameModalOpen(false)}>
        <View className="flex-1 items-center justify-center bg-black/40 px-8">
          <View className="w-full rounded-2xl bg-white p-5">
            <View className="mb-4 flex-row items-center justify-between">
              <Text className="text-lg font-bold text-gray-800">
                {t('settings.nameModalTitle')}
              </Text>
              <TouchableOpacity onPress={() => setNameModalOpen(false)} accessibilityRole="button">
                <MaterialIcons name="close" size={22} color="#9CA3AF" />
              </TouchableOpacity>
            </View>

            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder={t('settings.namePlaceholder')}
              placeholderTextColor="#9CA3AF"
              autoFocus
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={handleSaveName}
              className="rounded-xl border border-gray-200 px-4 py-3 text-base text-gray-800"
            />

            <TouchableOpacity
              onPress={handleSaveName}
              disabled={savingName}
              activeOpacity={0.85}
              accessibilityRole="button"
              className="mt-4 items-center rounded-xl bg-primary py-3"
              style={savingName ? { opacity: 0.6 } : undefined}>
              {savingName ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="text-base font-semibold text-white">{t('common.save')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <StatusBar style="auto" />
    </Container>
  );
}
