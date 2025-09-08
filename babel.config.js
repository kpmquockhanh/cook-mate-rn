module.exports = function (api) {
  api.cache(true);

  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }], 
      'nativewind/babel'
    ],
    plugins: [
      // Required for expo-router
      // require.resolve('expo-router/babel'),
    ],
  };
};
