/**
 * Expo config plugin to pin Android Gradle Plugin (AGP) to a version
 * compatible with Expo SDK 51 / expo-modules-core 1.12.x
 *
 * Without this, Gradle resolves the latest AGP (8.5+) which breaks
 * expo-modules-core's `from components.release` publishing block.
 */
const { withProjectBuildGradle } = require('@expo/config-plugins');

const AGP_VERSION = '8.3.1';

module.exports = function withAgpVersion(config) {
  return withProjectBuildGradle(config, (mod) => {
    const contents = mod.modResults.contents;

    // Replace unversioned AGP classpath with pinned version
    mod.modResults.contents = contents.replace(
      /classpath\(['"]com\.android\.tools\.build:gradle['"]\)/,
      `classpath('com.android.tools.build:gradle:${AGP_VERSION}')`
    );

    return mod;
  });
};
