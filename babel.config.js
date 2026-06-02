module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo already includes TypeScript transform, class properties,
    // and private methods — in the correct order. No extra plugins needed.
    presets: ['babel-preset-expo'],
  };
};
