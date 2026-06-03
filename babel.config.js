module.exports = function (api) {
  api.cache(true);
  return {
    plugins: [
      // 1. Strip TypeScript FIRST — runs only on .ts/.tsx files (default, no allExtensions).
      //    expo-file-system ships "main": "src/index.ts" so this is required before
      //    class-properties plugins run, otherwise 'declare' fields cause a crash.
      ['@babel/plugin-transform-typescript', { allowDeclareFields: true }],

      // 2. Transform private class fields (#field) for .js files so hermesc can compile.
      //    React Native 0.81 core (EventEmitter, geometry) uses #field syntax.
      ['@babel/plugin-transform-class-properties', { loose: true }],
      ['@babel/plugin-transform-private-methods', { loose: true }],
    ],
    // babel-preset-expo runs AFTER all plugins (presets always run last).
    // Its own TypeScript / class-property transforms become no-ops on already-transformed code.
    presets: ['babel-preset-expo'],
  };
};
