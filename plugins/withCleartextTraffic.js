/**
 * Expo config plugin to allow cleartext (plain HTTP) traffic on Android.
 *
 * Needed for the WiFi Measurement Box feature: the app talks to the
 * ESP32-CAM box over plain http://192.168.4.1 on its local SoftAP network.
 * Since Android 9 (API 28), the OS blocks all cleartext HTTP by default —
 * fetch() to the box fails silently (network request failed) even though
 * the phone is correctly joined to the AQUA-BOX WiFi. There is no first-
 * class Expo config key for this, so we patch AndroidManifest.xml directly.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:usesCleartextTraffic'] = 'true';
    }
    return mod;
  });
};
