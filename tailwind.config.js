/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,tsx}', './components/**/*.{js,ts,tsx}'],

  presets: [require('nativewind/preset')],
  theme: {
    extend: {},
    colors: {
      'primary': '#ff6b6b',
      'secondary': '#ff8e53',
      'accent': '#4ecdc4',
    },
  },
  plugins: [],
};
