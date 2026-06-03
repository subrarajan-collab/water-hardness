module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // These plugins force private class fields (#field) to be transformed
    // by Babel BEFORE hermesc compiles the bundle.
    // NOTE: plugins run before presets in Babel. This is fine for EAS/production
    // builds because node_modules ship compiled JS (not TypeScript source).
    // The TypeScript ordering conflict only occurs in Expo Go dev mode.
    plugins: [
      ['@babel/plugin-transform-class-properties', { loose: true }],
      ['@babel/plugin-transform-private-methods', { loose: true }],
    ],
  };
};
