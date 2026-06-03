module.exports = function (api) {
  api.cache(true);
  return {
    plugins: [
      // 1. TypeScript stripping FIRST — must run before class-properties.
      //    allExtensions: true  → applies to ALL files (.js, .ts, .tsx, .jsx)
      //    isTSX: true          → allows JSX syntax inside the TypeScript parser
      //                           so .js/.jsx files with JSX are parsed correctly.
      //    allowDeclareFields   → handles expo-file-system's `declare class` syntax.
      //    NOTE: this plugin only STRIPS TypeScript syntax; JSX is left intact
      //    for babel-preset-expo to convert to React.createElement() later.
      ['@babel/plugin-transform-typescript', {
        allowDeclareFields: true,
        allExtensions: true,
        isTSX: true,
      }],

      // 2. Transform private class fields (#field) so hermesc can compile them.
      ['@babel/plugin-transform-class-properties', { loose: true }],
      ['@babel/plugin-transform-private-methods', { loose: true }],
    ],

    // Runs AFTER all plugins. JSX → React.createElement, flow, etc.
    presets: ['babel-preset-expo'],
  };
};
