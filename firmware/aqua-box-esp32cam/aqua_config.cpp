#include "aqua_config.h"
#include <Preferences.h>

static Preferences prefs;

void configSetDefaults(Settings& s) {
  // Centre ROI over the bottle; two reference patches to either side.
  s.roi    = { 0.42f, 0.30f, 0.16f, 0.40f };
  s.patchA = { 0.14f, 0.44f, 0.10f, 0.12f };
  s.patchB = { 0.76f, 0.44f, 0.10f, 0.12f };
  s.aec_value = 300;      // fixed exposure (1..1200)
  s.agc_gain  = 2;        // fixed gain (0..30)
  s.r_gain    = 1.0f;     // manual WB: neutral until tuned against the diffuser
  s.b_gain    = 1.0f;
  s.frame_count = 13;
  s.settle_ms = 2000;
  s.interval_ms = 1000;
  s.discard_frames = 3;
  s.sta_mode = false;
  s.sta_ssid[0] = '\0';
  s.sta_pass[0] = '\0';
}

void configLoad() {
  prefs.begin("aqua", true);
  size_t n = prefs.getBytesLength("settings");
  if (n == sizeof(Settings)) {
    prefs.getBytes("settings", &g_settings, sizeof(Settings));
  } else {
    configSetDefaults(g_settings);
  }
  prefs.end();
}

void configSave() {
  prefs.begin("aqua", false);
  prefs.putBytes("settings", &g_settings, sizeof(Settings));
  prefs.end();
}

void blankLoad() {
  prefs.begin("aqua", true);
  size_t n = prefs.getBytesLength("blank");
  if (n == sizeof(BlankData)) {
    prefs.getBytes("blank", &g_blank, sizeof(BlankData));
  } else {
    g_blank.valid = false;
  }
  prefs.end();
}

void blankSave() {
  prefs.begin("aqua", false);
  prefs.putBytes("blank", &g_blank, sizeof(BlankData));
  prefs.end();
}
