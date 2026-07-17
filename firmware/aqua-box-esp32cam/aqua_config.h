#pragma once
#include <Arduino.h>

// ─── Firmware identity ───────────────────────────────────────────────────────
#define FW_VERSION "1.3.0"
#define DEVICE_TYPE "esp32cam"
#define AP_SSID     "AQUA-BOX"

// Bump whenever the HTTP API's request/response SHAPE changes (new required
// field, changed meaning of a value, endpoint added/removed). The app checks
// this against its own expected value on /ping and warns on mismatch — this
// is what actually catches "box is running stale firmware" instead of the
// symptom (a 404) with no explanation.
// v2: added r_gain/b_gain (manual WB), roi_p99 in /probe, POST /autotune,
//     GET /ledtest, /config now validates and rejects out-of-range values.
// v3: measurement channel is configurable (default green) and drives BOTH the
//     outlier-rejection metric and the reported sigma; /measure now returns
//     per-channel sigma_red/green/blue plus the active "channel".
#define API_VERSION 3

// ─── AI-Thinker ESP32-CAM pin map ────────────────────────────────────────────
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22

// Illumination LED: external white LED via NPN transistor. Digital only (no
// PWM — PWM causes rolling-shutter banding). GPIO13 is free when no SD card.
#define LED_GPIO_NUM    13

// If the /probe endpoint shows red/blue swapped, flip this to 1.
#define RGB565_BYTESWAP 0

// ─── Config structures (persisted to NVS as raw bytes) ───────────────────────
struct RectN { float x, y, w, h; };          // normalized 0..1 (top-left + size)
struct ChannelMeans { float r, g, b; };

struct Settings {
  RectN roi;
  RectN patchA;
  RectN patchB;
  int   aec_value;      // fixed exposure
  int   agc_gain;       // fixed gain
  float r_gain;         // manual white balance: red channel digital gain
  float b_gain;         // manual white balance: blue channel digital gain
  int   frame_count;    // measurement frames (default 13)
  int   settle_ms;      // settle after first LED-on (default 2000)
  int   interval_ms;    // between measurement frames (default 1000)
  int   discard_frames; // discard after any sensor/LED change (default 3)
  bool  sta_mode;       // false = SoftAP, true = join home WiFi
  char  sta_ssid[33];
  char  sta_pass[65];
};

struct BlankData {
  bool  valid;
  ChannelMeans roiNet;     // dark-subtracted ROI means
  ChannelMeans patchANet;
  ChannelMeans patchBNet;
  long  timestamp;         // time(nullptr) at capture (seconds)
};

// Globals (defined in the .ino)
// Which channel carries the signal. Drives the MAD outlier-rejection metric
// and the primary reported sigma. Green by default: the EBT wine-red complex
// absorbs strongest in green, and green is 6-bit in RGB565 vs 5-bit for R/B.
//
// Deliberately stored under its OWN NVS key rather than inside Settings —
// configLoad() resets everything to defaults whenever sizeof(Settings)
// changes, so adding a field here would silently wipe the user's ROI and
// exposure on the first boot after an update.
enum MeasChannel { CH_RED = 0, CH_GREEN = 1, CH_BLUE = 2 };
extern int g_channel;
void channelLoad();
void channelSave();
const char* channelName(int ch);
int channelFromName(const char* name, int fallback);

extern Settings  g_settings;
extern BlankData g_blank;

// NVS
void configLoad();
void configSave();
void blankLoad();
void blankSave();
void configSetDefaults(Settings& s);
