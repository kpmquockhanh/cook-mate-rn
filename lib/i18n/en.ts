import type { Phrase } from './phrase';

/**
 * The English catalogue, and the source of truth for every key in the app.
 *
 * `vi.ts` is typed against this object, so a key added here without a
 * Vietnamese string is a type error rather than a screen that quietly falls
 * back to English.
 *
 * Keys are flat and dotted, grouped by the screen that reads them. A value is
 * either a plain string or a `{ one, other }` pair for anything counted; see
 * `translate.ts` for the interpolation and plural rules. Placeholders are named
 * (`{count}`, `{name}`) rather than positional so a translator can reorder them.
 *
 * Nouns are never interpolated into a sentence - "No {section} found" reads
 * fine in English and badly in most other languages - so counted or named
 * variants get a key each.
 */
const en = {
  // --- Shared ---------------------------------------------------------------
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.clear': 'Clear',
  'common.retry': 'Retry',
  'common.goBack': 'Go Back',
  'common.seeAll': 'See all',
  'common.save': 'Save',
  'common.notSet': 'Not set',
  'common.unknown': 'Unknown',
  'common.tryAgain': 'Please try again.',

  // Durations, as the user reads them.
  'duration.off': 'Off',
  'duration.secondsShort': '{count}s',
  'duration.seconds': '{count} sec',
  'duration.minutes': '{count} min',
  'duration.hours': { one: '{count} hour', other: '{count} hours' },

  // --- Tab bar --------------------------------------------------------------
  'tabs.home': 'Home',
  'tabs.homeHeader': 'Recipe Hub',
  'tabs.shopping': 'Shopping',
  'tabs.shoppingHeader': 'Shopping List',
  'tabs.timer': 'Timer',
  'tabs.timerHeader': 'Cooking Timer',
  'tabs.settings': 'Settings',
  'tabs.voiceAssistant': 'Voice assistant',

  // --- Home -----------------------------------------------------------------
  // Greetings follow the clock; see lib/daypart.ts for the boundaries.
  'home.greetingMorning': 'Good morning, {name}',
  'home.greetingAfternoon': 'Good afternoon, {name}',
  'home.greetingEvening': 'Good evening, {name}',
  'home.greetingNight': 'Still up, {name}?',
  'home.greetingFallbackName': 'User',
  'home.subtitle': 'Ready to cook something delicious?',
  'home.emptyHint': 'Try adjusting your search or check back later',

  // Rails. The leading one swaps with the time of day.
  'home.heroBreakfast': 'Breakfast ideas',
  'home.heroLunch': 'Lunch today',
  'home.heroSnack': 'Something small',
  'home.heroDinner': 'Dinner tonight',
  'home.heroDessert': 'Something sweet',
  'home.quickTitle': 'Ready in 30 minutes',
  'home.quickSubtitle': 'Start to plate, hands on',
  'home.handsOffTitle': 'Barely any work',
  'home.handsOffSubtitle': 'The oven does the waiting',
  'home.easyTitle': 'Easy wins',
  'home.popularTitle': 'Most cooked this month',
  'home.popularSubtitle': 'What people here actually finished',
  'home.newTitle': 'Newest recipes',

  // Resume card.
  'home.resumeLabel': 'Still cooking',
  'home.resumeStep': 'Step {current} of {total}',
  'home.resumeAction': 'Resume',
  'home.resumeDismiss': 'Dismiss',

  // Filter chips, and the headings they lead to.
  'facet.all': 'All recipes',
  'facet.under15': 'Under 15 min',
  'facet.under30': 'Under 30 min',
  'facet.under60': 'Under an hour',
  'facet.handsOff': 'Hands-off',
  'facet.easy': 'Easy',
  'facet.medium': 'Medium',
  'facet.hard': 'Hard',
  'facet.breakfast': 'Breakfast',
  'facet.lunch': 'Lunch',
  'facet.dinner': 'Dinner',
  'facet.dessert': 'Dessert',
  'facet.snack': 'Snacks',
  'facet.basics': 'Sauces & basics',
  'facet.chicken': 'Chicken',
  'facet.beef': 'Beef',
  'facet.pork': 'Pork',
  'facet.seafood': 'Fish & seafood',
  'facet.pasta': 'Pasta',
  'facet.egg': 'Eggs',
  'facet.veg': 'Veggie',
  'facet.handsOnMinutes': '{count} min hands-on',
  'facet.saved': 'Saved',
  'facet.popular': 'Most cooked',
  'facet.vegetarian': 'Vegetarian',
  'facet.vegan': 'Vegan',
  'facet.pescatarian': 'Pescatarian',
  'facet.glutenFree': 'Gluten free',

  // --- Filter sheet ---------------------------------------------------------
  'filter.open': 'Filters',
  'filter.title': 'Filters',
  'filter.close': 'Close filters',
  'filter.time': 'Time',
  'filter.meal': 'Meal',
  'filter.ingredient': 'Main ingredient',
  'filter.diet': 'Diet',
  'filter.difficulty': 'Difficulty',
  'filter.more': 'More',
  'filter.clearAll': 'Clear all',
  'filter.apply': 'Show recipes',

  // --- Search ---------------------------------------------------------------
  'search.placeholder': 'Search recipes...',
  'search.loadingMore': 'Loading more recipes...',
  'search.noResults': 'No recipes found',

  // --- All recipes ----------------------------------------------------------
  'allRecipes.title': 'All Recipes',
  'allRecipes.emptyTitle': 'No recipes available',
  'allRecipes.emptyHint': 'Check back later for new recipes',
  'allRecipes.noResultsHint': 'Try adjusting your search terms',
  'allRecipes.noFilterResultsHint': 'Nothing matches this filter yet',
  'allRecipes.clearFilter': 'Clear filter',
  'allRecipes.resultCount': { one: '{count} recipe', other: '{count} recipes' },

  // --- Recipe detail --------------------------------------------------------
  'recipe.loading': 'Loading recipe…',
  'recipe.loadingShoppingList': 'Loading shopping list…',
  'recipe.loadError': 'Error Loading Recipe',
  'recipe.notFound': 'Recipe not found',
  'recipe.totalTime': 'Total time',
  'recipe.servings': 'Servings',
  'recipe.difficulty': 'Difficulty',
  'recipe.aiScore': 'AI Score',
  'recipe.reviewCount': { one: '({count} review)', other: '({count} reviews)' },
  'recipe.photos': 'Photos ({count})',
  'recipe.startCooking': 'Start Cooking',
  'recipe.tabIngredients': 'Ingredients',
  'recipe.tabDirections': 'Directions',
  'recipe.ingredientsSummary': '{items} items · {servings} servings',
  'recipe.addToShoppingList': 'Add to Shopping List',
  'recipe.notes': 'Notes',
  'recipe.stepCount': { one: '{count} step', other: '{count} steps' },
  'recipe.source': 'Recipe from {source}',
  'recipe.scaleTitle': 'Scale Recipe',
  'recipe.scalePrompt': 'Select number of servings',
  'recipe.scaleConfirm': 'Update Recipe',
  'recipe.allCheckedTitle': 'All ingredients checked',
  'recipe.allCheckedMessage':
    'All ingredients are already checked off. Would you like to add all ingredients to your shopping list?',
  'recipe.addAll': 'Add All',
  'recipe.addedTitle': 'Added to Shopping List!',
  'recipe.addedAllTitle': 'Success',
  'recipe.addedAllMessage': {
    one: 'Added {count} ingredient to your shopping list!',
    other: 'Added {count} ingredients to your shopping list!',
  },
  'recipe.addedMessage': {
    one: '{count} ingredient added to your shopping list.',
    other: '{count} ingredients added to your shopping list.',
  },

  // --- Cooking mode ---------------------------------------------------------
  'cooking.header': 'Cooking',
  'cooking.progress': 'Step {current} of {total}',
  'cooking.percentDone': '{percent}% done',
  'cooking.currentStep': 'Current step',
  'cooking.noInstruction': 'No instruction available',
  'cooking.voiceHint': 'Say “next step”, “go back” or “repeat” to navigate hands-free.',
  'cooking.allSteps': 'All steps ({count})',
  'cooking.youWillNeed': 'You’ll need',
  'cooking.ingredientCount': { one: '{count} item', other: '{count} items' },
  'cooking.timer': 'Timer',
  'cooking.startStepTimer': 'Start timer ({count} min)',
  'cooking.finish': 'Finish cooking',
  'cooking.nextStep': 'Next step',
  'cooking.stepTimerName': 'Step {number}',
  // Spoken aloud, or handed back to the voice assistant to read out.
  'cooking.spokenStep': 'Step {number}. {text}',
  'cooking.describeStep': 'Step {current} of {total}: {text}',
  'cooking.lastStep': 'This is the last step. {step}',
  'cooking.firstStep': 'This is already the first step. {step}',

  // --- Shopping list --------------------------------------------------------
  'shopping.title': 'Weekly Shopping',
  'shopping.itemCount': { one: '{count} Item', other: '{count} Items' },
  'shopping.clearAll': 'Clear All',
  'shopping.filterAll': 'All Items',
  'shopping.filterRecipe': 'Recipe Items',
  'shopping.filterManual': 'Manual Items',
  'shopping.addPlaceholder': 'Add item...',
  'shopping.quantityPlaceholder': 'Quantity (optional)...',
  'shopping.emptyTitle': 'Your shopping list is empty',
  'shopping.emptyHint': 'Add items manually or browse recipes to get started',
  'shopping.emptyRecipeTitle': 'No recipe items found',
  'shopping.emptyManualTitle': 'No manual items found',
  'shopping.emptyFilterHint': 'Try adding some items or switch to a different category',
  'shopping.fromRecipe': 'From: {recipe}',
  'shopping.manualSection': 'Manual Items',
  'shopping.unknownRecipe': 'Unknown Recipe',

  // --- Timers ---------------------------------------------------------------
  'timer.title': 'Timers',
  'timer.running': '{count} running',
  'timer.runningAndDone': '{running} running, {done} done',
  'timer.finishedCount': '{count} finished',
  'timer.idle': 'Nothing on the go',
  'timer.headlineFinished': 'Finished',
  'timer.headlineNext': 'Next up',
  'timer.unnamed': 'Timer',
  'timer.active': 'Active timers',
  'timer.clearFinished': 'Clear finished',
  'timer.noneRunning': 'No timers running',
  'timer.checking': 'Checking for timers…',
  'timer.emptyHint': 'Start one below, or ask the voice assistant for a timer while you cook.',
  'timer.quickStart': 'Quick start',
  'timer.quickStartLabel': 'Start a {count} minute timer for {name}',
  'timer.presetQuick': 'Quick',
  'timer.presetPasta': 'Pasta',
  'timer.presetEggs': 'Eggs',
  'timer.presetVeggies': 'Veggies',
  'timer.presetChicken': 'Chicken',
  'timer.presetBread': 'Bread',
  'timer.custom': 'Custom timer',
  'timer.customNamePlaceholder': 'What is it for? (e.g. Rice)',
  'timer.setDuration': 'Set a duration',
  'timer.oneMinuteLess': 'One minute less',
  'timer.oneMinuteMore': 'One minute more',
  'timer.start': 'Start timer',

  // A timer card: the state badge, the duration under it, and the controls.
  'timer.toneDone': 'Done',
  'timer.toneCritical': 'Any second',
  'timer.toneWarning': 'Nearly there',
  'timer.toneActive': 'Running',
  'timer.tonePaused': 'Paused',
  'timer.ranFor': 'Ran for {duration}',
  'timer.ofTotal': 'of {duration}',
  'timer.restartLabel': 'Restart {name}',
  'timer.addMinuteLabel': 'Add a minute to {name}',
  'timer.removeMinuteLabel': 'Take a minute off {name}',
  'timer.dismissLabel': 'Dismiss {name}',
  'timer.cancelLabel': 'Cancel {name}',
  'timer.pauseLabel': 'Pause {name}',
  'timer.resumeLabel': 'Resume {name}',

  // Alerts raised while a timer runs.
  'timer.finishedAlertTitle': 'Timer Finished!',
  'timer.finishedAlertMessage': '{name} is done!',
  'timer.almostDoneTitle': 'Almost done',
  'timer.almostDoneMessage': '{name} has {duration} left.',
  'timer.yourTimer': 'Your timer',

  // --- Settings -------------------------------------------------------------
  'settings.title': 'Settings',

  'settings.accountSection': 'Account',
  'settings.name': 'Name',
  'settings.nameDescription': 'Add a name the assistant can call you by',
  'settings.nameModalTitle': 'Your name',
  'settings.namePlaceholder': 'e.g. Khanh',
  'settings.nameSaveError': 'Could not save your name',
  'settings.email': 'Email',
  'settings.signOut': 'Sign out',
  'settings.signOutTitle': 'Sign out?',
  'settings.signOutMessage': 'Your shopping list and settings stay on this device.',

  'settings.languageSection': 'Language',
  'settings.language': 'App language',
  'settings.languageDescription': 'Applies everywhere in the app, right away',
  'settings.languageFooter':
    'Recipes keep the language they were written in - this changes the app’s own wording.',

  'settings.cookingSection': 'Cooking',
  'settings.cookingFooter':
    'Scaling adjusts ingredient quantities only - it does not convert between units.',
  'settings.scaleRecipes': 'Scale recipes to my household',
  'settings.scaleRecipesDescription': 'Open every recipe at your usual number of servings',
  'settings.householdSize': 'Household size',
  'settings.servingsValue': { one: '{count} serving', other: '{count} servings' },
  'settings.keepScreenOn': 'Keep the screen on',
  'settings.keepScreenOnDescription':
    'Stops the display sleeping while a recipe is open in cooking mode',
  'settings.brightness': 'Brighten the screen while cooking',
  'settings.brightnessDescription': 'Restores your usual brightness when you leave cooking mode',

  'settings.voiceSection': 'Voice assistant',
  'settings.voiceFooter':
    'Spoken steps use your device’s own voice, so they work even when the assistant cannot be reached.',
  'settings.voiceAssistant': 'Voice assistant',
  'settings.voiceAssistantDescription': 'Talk to CookMate hands-free during a recipe',
  'settings.voiceAutoStart': 'Connect automatically',
  'settings.voiceAutoStartDescription': 'Wait for "Hey CookMate" as soon as cooking mode opens',
  'settings.voiceWakeWindow': 'After "Hey CookMate"',
  'settings.voiceWakeWindowQuickDescription':
    'Listens for your request, then about 8 seconds more for a follow-up',
  'settings.voiceWakeWindowConversationDescription':
    'Keeps listening until 30 seconds of quiet, or until you say thanks',
  'settings.voiceWakeWindowQuick': 'Quick',
  'settings.voiceWakeWindowConversation': 'Conversation',
  'settings.spokenSteps': 'Read steps aloud',
  'settings.spokenStepsDescription': 'Speaks each step as you reach it',
  'settings.speechRate': 'Speaking speed',

  'settings.timersSection': 'Timers',
  'settings.timersFooter':
    'Timers run while the app is open. Alerts for a backgrounded app need push notifications, which are not in this build.',
  'settings.vibrate': 'Vibrate',
  'settings.vibrateDescription': 'Buzz when a timer finishes',
  'settings.alertDialog': 'Show an alert',
  'settings.alertDialogDescription': 'A dialog you have to dismiss when a timer finishes',
  'settings.earlyWarning': 'Early warning',
  'settings.earlyWarningDescription': 'Tell me before a timer runs out',

  'settings.dataSection': 'Data',
  'settings.clearShoppingList': 'Clear shopping list',
  'settings.shoppingItemCount': { one: '{count} item', other: '{count} items' },
  'settings.clearShoppingListTitle': 'Clear shopping list?',
  'settings.clearShoppingListMessage': {
    one: '{count} item will be removed from this device.',
    other: '{count} items will be removed from this device.',
  },
  'settings.resetAll': 'Reset all settings',
  'settings.resetTitle': 'Reset settings?',
  'settings.resetMessage': 'Every preference below goes back to its default.',
  'settings.reset': 'Reset',

  'settings.aboutSection': 'About',
  'settings.version': 'Version',

  // --- Sign in --------------------------------------------------------------
  'auth.tagline': 'Your intelligent cooking companion',
  'auth.welcome': 'Welcome back!',
  'auth.welcomeSubtitle': 'Sign in to continue your culinary journey',
  'auth.emailLabel': 'Email Address',
  'auth.emailPlaceholder': 'Enter your email',
  'auth.passwordLabel': 'Password',
  'auth.passwordPlaceholder': 'Enter your password',
  'auth.rememberMe': 'Remember me',
  'auth.forgotPassword': 'Forgot password?',
  'auth.signIn': 'Sign In',
  'auth.signingIn': 'Signing In...',
  'auth.noAccount': 'Don’t have an account? ',
  'auth.signUp': 'Sign up',
  'auth.checkInbox': 'Please check your inbox for email verification!',
  'auth.createAccount': 'Create an account',
  'auth.createAccountSubtitle': 'Sign up to save recipes and cook along with CookMate',
  'auth.confirmPasswordLabel': 'Confirm Password',
  'auth.confirmPasswordPlaceholder': 'Re-enter your password',
  'auth.signingUp': 'Creating account...',
  'auth.haveAccount': 'Already have an account? ',
  'auth.errorMissingFields': 'Please enter your email and password.',
  'auth.errorInvalidEmail': 'Please enter a valid email address.',
  'auth.errorPasswordTooShort': 'Password must be at least 6 characters.',
  'auth.errorPasswordMismatch': 'Passwords do not match.',
  'auth.errorEmailTaken': 'An account with this email already exists. Try signing in.',

  // --- Voice assistant status ----------------------------------------------
  'voice.preparing': 'Getting the voice assistant ready…',
  'voice.disabled': 'Voice assistant is off',
  'voice.disabledAction': 'turn it on in Settings',
  'voice.unavailable': 'Voice assistant unavailable',
  'voice.unavailableAction': 'tap to try again',
  'voice.ready': 'Voice assistant ready',
  'voice.readyAction': 'tap the mic to cook hands-free',
  'voice.connecting': 'Connecting to the voice assistant…',
  'voice.waiting': 'Say “Hey CookMate”',
  'voice.waitingAction': 'or tap the mic',
  'voice.wakeUnavailable': 'Wake word unavailable',
  'voice.wakeUnavailableAction': 'tap the mic to talk',
  'voice.listening': 'Listening',
  'voice.listeningAction': 'say “next step”, “go back” or “repeat”',
  'voice.noAgent': 'No assistant answered',
  'voice.noAgentAction': 'use the buttons below, or tap the mic to retry',
  'voice.micDenied': 'Microphone is off',
  'voice.micDeniedAction': 'allow it, then tap the mic again',
  'voice.error': 'Voice assistant error',
  'voice.errorAction': 'tap the mic to retry',

  // The reason behind a status, slotted into the banner between the state and
  // the remedy. Only reached when the underlying error carries no message of
  // its own.
  'voice.detailMicUnavailable': 'The microphone is unavailable',
  'voice.detailMicBlocked': 'The browser blocked the microphone',
  'voice.detailMicFailure': 'Microphone unavailable ({reason})',
  'voice.detailUnreachable': 'Could not reach the voice service',
  'voice.detailHttp': 'Voice service returned HTTP {status}',
  'voice.detailTokenFailed': 'Could not start the voice assistant',
  'voice.detailIncompleteToken': 'The voice service sent an incomplete response',

  // Handed back to the assistant, which reads them aloud.
  'voice.rpcNext': 'Moved to the next step',
  'voice.rpcBack': 'Moved to the previous step',
  'voice.rpcRepeat': 'Repeated the current step',
  'voice.rpcFailed': 'Sorry, I could not do that: {reason}',
  'voice.rpcFailedReason': 'something went wrong',

  // --- Errors ---------------------------------------------------------------
  'error.signInAgain': 'Please sign in again',
  'error.requestFailed': 'Request failed: {status}',
  'error.recipeIdRequired': 'Recipe ID is required',
  'error.recipeNotFound': 'Recipe not found',
  'error.recipeInvalid': 'Invalid recipe data received',
  'error.recipeFetch': 'Failed to fetch recipe',
  'error.recipesFetch': 'Failed to fetch recipes',
  'error.anonymousReviewer': 'Anonymous',

  // --- Placeholder screens --------------------------------------------------
  'record.placeholder': 'This is from record page',
} satisfies Record<string, Phrase>;

export type TranslationKey = keyof typeof en;

export default en;
