module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        // Apply ONLY to .js/.jsx files — NOT .ts/.tsx
        // This forces private class fields (#field) to be transformed
        // by Babel before hermesc compiles the bundle.
        // TypeScript files are excluded to avoid transform ordering conflicts.
        test: /\.(js|jsx)$/,
        plugins: [
          ['@babel/plugin-transform-class-properties', { loose: true }],
          ['@babel/plugin-transform-private-methods', { loose: true }],
        ],
      },
    ],
  };
};
