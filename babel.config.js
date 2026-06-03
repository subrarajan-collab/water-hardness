module.exports = function (api) {
  api.cache(true);
  return {
    // PLUGIN ORDER MATTERS: plugins run before presets in Babel.
    // expo-file-system ships only TypeScript source (main: "src/index.ts"),
    // so TypeScript MUST be stripped first, then class-properties can run.
    plugins: [
      // 1. Strip TypeScript FIRST (before any class feature plugins)
      ['@babel/plugin-transform-typescript', { allowDeclareFields: true, allExtensions: true }],
      // 2. Then transform private class fields (#field) so hermesc can compile them
      ['@babel/plugin-transform-class-properties', { loose: true }],
      ['@babel/plugin-transform-private-methods', { loose: true }],
    ],
    // babel-preset-expo runs after all plugins (presets run last)
    presets: ['babel-preset-expo'],
  };
};
