#include "aqua_camera.h"
#include "esp_camera.h"
#include "img_converters.h"

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
void cameraApplyLock() {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return;
  s->set_exposure_ctrl(s, 0);            // AEC off
  s->set_aec2(s, 0);
  s->set_aec_value(s, g_settings.aec_value);
  s->set_gain_ctrl(s, 0);                // AGC off
  s->set_agc_gain(s, g_settings.agc_gain);
  s->set_gainceiling(s, (gainceiling_t)0);
  s->set_whitebal(s, 0);                 // AWB off
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

// Mean of one normalized rect over an RGB565 frame; optionally count saturation.
static void rectMean(const camera_fb_t* fb, const RectN& rc,
                     ChannelMeans& m, uint32_t* satCount, uint32_t* total) {
  int W = fb->width, H = fb->height;
  int x0 = (int)(rc.x * W), y0 = (int)(rc.y * H);
  int x1 = (int)((rc.x + rc.w) * W), y1 = (int)((rc.y + rc.h) * H);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > W) x1 = W; if (y1 > H) y1 = H;
  uint64_t sr = 0, sg = 0, sb = 0; uint32_t n = 0, sat = 0;
  for (int y = y0; y < y1; y++) {
    const uint8_t* row = fb->buf + (size_t)(y * W + x0) * 2;
    for (int x = x0; x < x1; x++) {
      int r, g, b; unpack565(row, r, g, b); row += 2;
      sr += r; sg += g; sb += b; n++;
      if (r >= 250 || g >= 250 || b >= 250) sat++;
    }
  }
  if (n == 0) n = 1;
  m.r = (float)sr / n; m.g = (float)sg / n; m.b = (float)sb / n;
  if (satCount) *satCount = sat;
  if (total)    *total = n;
}

bool cameraRegions(RegionResult& out) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { out.ok = false; return false; }
  uint32_t sat = 0, tot = 0;
  rectMean(fb, g_settings.roi,    out.roi,    &sat, &tot);
  rectMean(fb, g_settings.patchA, out.patchA, nullptr, nullptr);
  rectMean(fb, g_settings.patchB, out.patchB, nullptr, nullptr);
  esp_camera_fb_return(fb);
  out.roiSatPct = tot ? (100.0f * sat / tot) : 0.0f;
  out.ok = true;
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
