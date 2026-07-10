#include "aqua_camera.h"
#include "esp_camera.h"
#include "img_converters.h"
#include <math.h>
#include <string.h>

// ─── LED (digital only, LOW at boot) ─────────────────────────────────────────
void ledInit() {
  pinMode(LED_GPIO_NUM, OUTPUT);
  digitalWrite(LED_GPIO_NUM, LOW);
}
void ledOn()  { digitalWrite(LED_GPIO_NUM, HIGH); }
void ledOff() { digitalWrite(LED_GPIO_NUM, LOW); }

// ─── Camera init: QVGA RGB565, locked linear pipeline ────────────────────────
// Frame buffers prefer PSRAM (needed for fb_count=2 + CAMERA_GRAB_LATEST).
// If PSRAM isn't actually available, requesting CAMERA_FB_IN_PSRAM anyway
// leads the camera driver to allocate a frame-ready queue that never gets
// wired up correctly, and the first frame ISR asserts into a null queue
// (xQueueGenericSendFromISR) -> crash -> watchdog reboot loop. Detect PSRAM
// explicitly and fall back to a single DRAM buffer instead of crashing.
bool cameraInit() {
  bool psram = psramFound();
  Serial.printf("PSRAM: %s\n", psram ? "found" : "NOT FOUND (falling back to DRAM, 1 frame buffer)");

  camera_config_t c;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;   c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;   c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_RGB565;      // linear pixels for absorbance
  c.frame_size   = FRAMESIZE_QVGA;        // 320x240
  c.grab_mode    = CAMERA_GRAB_LATEST;
  if (psram) {
    c.fb_count    = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    c.fb_count    = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("camera init failed 0x%x\n", err);
    return false;
  }
  cameraApplyLock();
  return true;
}

// Lock every automatic/non-linear stage so pixel value ∝ light intensity.
// White balance is NOT left to the sensor's AWB (which fights the very
// intensity changes we're trying to measure) — it's corrected digitally in
// rectMeanP99() below using g_settings.r_gain/b_gain, applied uniformly to
// every pixel read anywhere in this file (ROI, patches, dark frame, probe,
// autotune, LED test all go through the same function).
void cameraApplyLock() {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return;
  s->set_exposure_ctrl(s, 0);            // AEC off
  s->set_aec2(s, 0);
  s->set_aec_value(s, g_settings.aec_value);
  s->set_gain_ctrl(s, 0);                // AGC off
  s->set_agc_gain(s, g_settings.agc_gain);
  s->set_gainceiling(s, (gainceiling_t)0);
  s->set_whitebal(s, 0);                 // AWB off — manual r_gain/b_gain instead
  s->set_awb_gain(s, 0);
  s->set_raw_gma(s, 0);                  // gamma OFF — linearity
  s->set_lenc(s, 0);                     // lens shading correction off
  s->set_bpc(s, 0);
  s->set_wpc(s, 0);
  s->set_dcw(s, 0);
  s->set_special_effect(s, 0);           // no effects
  s->set_brightness(s, 0);
  s->set_contrast(s, 0);
  s->set_saturation(s, 0);
  s->set_hmirror(s, 0);
  s->set_vflip(s, 0);
  s->set_colorbar(s, 0);
}

void cameraSetExposure(int aecValue) {
  g_settings.aec_value = aecValue;
  sensor_t* s = esp_camera_sensor_get();
  if (s) s->set_aec_value(s, aecValue);
}

void cameraDiscard(int n) {
  for (int i = 0; i < n; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }
}

// RGB565 → 8-bit per channel
static inline void unpack565(const uint8_t* p, int& r, int& g, int& b) {
#if RGB565_BYTESWAP
  uint16_t px = (uint16_t)(p[1] << 8) | p[0];
#else
  uint16_t px = (uint16_t)(p[0] << 8) | p[1];
#endif
  int r5 = (px >> 11) & 0x1F;
  int g6 = (px >> 5)  & 0x3F;
  int b5 =  px        & 0x1F;
  r = (r5 << 3) | (r5 >> 2);
  g = (g6 << 2) | (g6 >> 4);
  b = (b5 << 3) | (b5 >> 2);
}

// Mean + per-channel 99th-percentile + saturation over one normalized rect.
// Applies g_settings.r_gain/b_gain as a digital multiply before histogram/sum
// so every consumer (ROI, patches, dark frame, /probe, /autotune, /ledtest)
// sees the same white-balance-corrected pixels, not just the display preview.
static void rectMeanP99(const camera_fb_t* fb, const RectN& rc,
                        ChannelMeans& mean, ChannelMeans& p99,
                        uint32_t* satCount, uint32_t* total) {
  int W = fb->width, H = fb->height;
  int x0 = (int)(rc.x * W), y0 = (int)(rc.y * H);
  int x1 = (int)((rc.x + rc.w) * W), y1 = (int)((rc.y + rc.h) * H);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > W) x1 = W; if (y1 > H) y1 = H;

  // static: avoids a 1.5KB stack allocation on every call; safe because the
  // HTTP server handles one request at a time (no concurrent callers).
  static uint16_t histR[256], histG[256], histB[256];
  memset(histR, 0, sizeof(histR));
  memset(histG, 0, sizeof(histG));
  memset(histB, 0, sizeof(histB));

  const float rg = g_settings.r_gain;
  const float bg = g_settings.b_gain;
  uint64_t sr = 0, sg = 0, sb = 0; uint32_t n = 0, sat = 0;
  for (int y = y0; y < y1; y++) {
    const uint8_t* row = fb->buf + (size_t)(y * W + x0) * 2;
    for (int x = x0; x < x1; x++) {
      int r, g, b; unpack565(row, r, g, b); row += 2;
      int rr = (int)(r * rg); if (rr > 255) rr = 255; if (rr < 0) rr = 0;
      int bb = (int)(b * bg); if (bb > 255) bb = 255; if (bb < 0) bb = 0;
      sr += rr; sg += g; sb += bb; n++;
      histR[rr]++; histG[g]++; histB[bb]++;
      if (rr >= 250 || g >= 250 || bb >= 250) sat++;
    }
  }
  if (n == 0) n = 1;
  mean.r = (float)sr / n; mean.g = (float)sg / n; mean.b = (float)sb / n;

  auto pctile = [&](uint16_t* hist) -> float {
    uint32_t target = (uint32_t)(0.99f * n);
    uint32_t cum = 0;
    for (int v = 0; v < 256; v++) { cum += hist[v]; if (cum >= target) return (float)v; }
    return 255.0f;
  };
  p99.r = pctile(histR);
  p99.g = pctile(histG);
  p99.b = pctile(histB);

  if (satCount) *satCount = sat;
  if (total)    *total = n;
}

bool cameraRegions(RegionResult& out) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { out.ok = false; return false; }
  uint32_t sat = 0, tot = 0;
  ChannelMeans dummyP99;
  rectMeanP99(fb, g_settings.roi,    out.roi,    out.roiP99, &sat, &tot);
  rectMeanP99(fb, g_settings.patchA, out.patchA, dummyP99,   nullptr, nullptr);
  rectMeanP99(fb, g_settings.patchB, out.patchB, dummyP99,   nullptr, nullptr);
  esp_camera_fb_return(fb);
  out.roiSatPct = tot ? (100.0f * sat / tot) : 0.0f;
  out.ok = true;
  return true;
}

static float maxChannel(const ChannelMeans& m) {
  float mx = m.r;
  if (m.g > mx) mx = m.g;
  if (m.b > mx) mx = m.b;
  return mx;
}

// Binary search on aec_value targeting ROI max-channel p99 in [200,230].
// Assumes the caller has already turned the LED on and it's settled.
bool cameraAutoTuneExposure(int& outAecValue, ChannelMeans& outP99) {
  int lo = 1, hi = 1200;
  int best = g_settings.aec_value;
  ChannelMeans bestP99 = {0, 0, 0};
  bool everMeasured = false;

  for (int iter = 0; iter < 14 && lo <= hi; iter++) {
    int mid = (lo + hi) / 2;
    cameraSetExposure(mid);
    cameraDiscard(g_settings.discard_frames);
    RegionResult r;
    if (!cameraRegions(r)) return false;
    everMeasured = true;
    best = mid;
    bestP99 = r.roiP99;

    float mx = maxChannel(r.roiP99);
    if (mx >= 200.0f && mx <= 230.0f) {
      outAecValue = mid;
      outP99 = r.roiP99;
      return true;
    } else if (mx < 200.0f) {
      lo = mid + 1;   // too dark → more exposure
    } else {
      hi = mid - 1;   // too bright/clipping → less exposure
    }
  }
  // Didn't land exactly in-band within the iteration budget (e.g. LED too
  // weak/strong for any exposure to hit 200-230) — return the closest point
  // found so the app can still show the app a concrete number and verdict.
  outAecValue = best;
  outP99 = bestP99;
  return everMeasured;
}

bool cameraLedTest(ChannelMeans& offMean, ChannelMeans& onMean) {
  ledOff();
  cameraDiscard(g_settings.discard_frames);
  RegionResult off;
  if (!cameraRegions(off)) return false;
  offMean = off.roi;

  ledOn();
  cameraDiscard(g_settings.discard_frames);
  RegionResult on;
  if (!cameraRegions(on)) { ledOff(); return false; }
  onMean = on.roi;

  ledOff(); // restore idle-safe default
  return true;
}

bool cameraJpeg(uint8_t** buf, size_t* len) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return false;
  bool ok = frame2jpg(fb, 80, buf, len);
  esp_camera_fb_return(fb);
  return ok;
}
void cameraJpegFree(uint8_t* buf) { if (buf) free(buf); }
