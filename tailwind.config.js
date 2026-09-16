/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,tsx}', './components/**/*.{js,ts,tsx}'],

  // Must be 'class', not the Tailwind default 'media'. On web, NativeWind's
  // runtime watches for the stylesheet being injected (Expo adds it late in
  // dev) and then unconditionally calls colorScheme.set() - which throws
  // "Cannot manually set color scheme, as dark mode is type 'media'".
  darkMode: 'class',

  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        primary: '#ff6b6b',
        secondary: '#ff8e53',
        accent: '#4ecdc4',
      },
    },
  },
  plugins: [],
};
