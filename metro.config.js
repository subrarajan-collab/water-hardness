const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Force 'default' transform profile so Babel transforms private class fields
// (#registry, #x, #y etc.) before hermesc compiles the bundle.
// Without this, Metro leaves private fields as-is (assuming hermesc supports
// them natively) but the hermesc version in RN 0.81.5 rejects them.
config.transformer.unstable_transformProfile = 'default';

module.exports = config;
