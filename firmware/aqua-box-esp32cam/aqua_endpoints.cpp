#include "aqua_endpoints.h"
#include "aqua_config.h"
#include "aqua_camera.h"
#include "aqua_measure.h"
#include "esp_http_server.h"
#include "esp_timer.h"
#include <math.h>

static httpd_handle_t s_server = nullptr;

static void cors(httpd_req_t* req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
}
static esp_err_t sendJson(httpd_req_t* req, const String& body) {
  cors(req);
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_send(req, body.c_str(), body.length());
}
// Same as sendJson but with a non-200 HTTP status — used by /config to
// reject out-of-range values (Bug 2) with a real 400, not a silent clamp.
static esp_err_t sendJsonStatus(httpd_req_t* req, int status, const char* statusText, const String& body) {
  cors(req);
  httpd_resp_set_type(req, "application/json");
  char statusStr[24];
  snprintf(statusStr, sizeof(statusStr), "%d %s", status, statusText);
  httpd_resp_set_status(req, statusStr);
  return httpd_resp_send(req, body.c_str(), body.length());
}

static String rectJson(const RectN& r) {
  return "{\"x\":" + String(r.x,4) + ",\"y\":" + String(r.y,4) +
         ",\"w\":" + String(r.w,4) + ",\"h\":" + String(r.h,4) + "}";
}
static String chanJson(const ChannelMeans& c, int decimals = 1) {
  return "{\"r\":" + String(c.r, decimals) + ",\"g\":" + String(c.g, decimals) + ",\"b\":" + String(c.b, decimals) + "}";
}

// ─── GET /ping ────────────────────────────────────────────────────────────────
// Cheap, dependency-free reachability + API-shape check. The app calls this
// on Connect, before /status, specifically so a stale-firmware mismatch shows
// as "firmware API v0 vs app expects v1" instead of an unexplained 404 on
// some other route.
static esp_err_t hPing(httpd_req_t* req) {
  return sendJson(req, "{\"ok\":true,\"api_version\":" + String(API_VERSION) + "}");
}

// ─── GET /status ─────────────────────────────────────────────────────────────
static esp_err_t hStatus(httpd_req_t* req) {
  String j = "{\"device_type\":\"" DEVICE_TYPE "\",\"fw_version\":\"" FW_VERSION "\",";
  j += "\"api_version\":" + String(API_VERSION) + ",";
  j += "\"box_id\":\"" + g_boxId + "\",";
  j += "\"capabilities\":{\"preview\":true},";
  j += "\"settings\":{";
  j +=   "\"roi\":" + rectJson(g_settings.roi) + ",";
  j +=   "\"patchA\":" + rectJson(g_settings.patchA) + ",";
  j +=   "\"patchB\":" + rectJson(g_settings.patchB) + ",";
  j +=   "\"aec_value\":" + String(g_settings.aec_value) + ",";
  j +=   "\"agc_gain\":" + String(g_settings.agc_gain) + ",";
  j +=   "\"r_gain\":" + String(g_settings.r_gain, 3) + ",";
  j +=   "\"b_gain\":" + String(g_settings.b_gain, 3) + ",";
  j +=   "\"frame_count\":" + String(g_settings.frame_count) + ",";
  j +=   "\"settle_ms\":" + String(g_settings.settle_ms) + ",";
  j +=   "\"interval_ms\":" + String(g_settings.interval_ms) + ",";
  j +=   "\"discard_frames\":" + String(g_settings.discard_frames) + ",";
  j +=   "\"sta_mode\":" + String(g_settings.sta_mode ? "true" : "false") + "},";
  j += "\"blank_age_s\":" + String(blankAgeSeconds()) + ",";
  j += "\"uptime\":" + String((long)(esp_timer_get_time() / 1000000)) + "}";
  return sendJson(req, j);
}

// ─── GET /probe ──────────────────────────────────────────────────────────────
// Brightness guidance is driven by the ROI's MAX-CHANNEL p99, not the mean
// (Bug 1b). A small hot/clipped patch barely moves the mean but pushes p99
// to 255 well before the picture "looks" bright on average — that mismatch
// is exactly what produced the old screen's contradictory "too dark" +
// "78% saturated" readout at the same time.
static esp_err_t hProbe(httpd_req_t* req) {
  ledOn();  cameraDiscard(g_settings.discard_frames);
  RegionResult lit; cameraRegions(lit);
  ledOff(); cameraDiscard(g_settings.discard_frames);
  RegionResult dark; cameraRegions(dark);

  float maxP99 = lit.roiP99.r;
  if (lit.roiP99.g > maxP99) maxP99 = lit.roiP99.g;
  if (lit.roiP99.b > maxP99) maxP99 = lit.roiP99.b;

  const char* verdict;
  if (lit.roiSatPct > 1.0f) verdict = "clipping";
  else if (maxP99 < 180.0f) verdict = "dark";
  else if (maxP99 > 245.0f) verdict = "bright";
  else verdict = "ok";

  String j = "{\"ok\":true,";
  j += "\"roi\":" + chanJson(lit.roi, 2) + ",";
  j += "\"roi_p99\":" + chanJson(lit.roiP99, 1) + ",";
  j += "\"roi_p99_max\":" + String(maxP99, 1) + ",";
  j += "\"verdict\":\"" + String(verdict) + "\",";
  j += "\"patchA\":" + chanJson(lit.patchA, 2) + ",";
  j += "\"patchB\":" + chanJson(lit.patchB, 2) + ",";
  j += "\"roi_saturation_pct\":" + String(lit.roiSatPct,2) + ",";
  j += "\"dark_level\":" + chanJson(dark.roi, 2) + "}";
  return sendJson(req, j);
}

// ─── POST /autotune ──────────────────────────────────────────────────────────
// Binary-searches aec_value (gain held fixed) until ROI max-channel p99 sits
// in [200,230]. Replaces manual +/- guesswork entirely (Bug 1c).
static esp_err_t hAutotune(httpd_req_t* req) {
  ledOn();
  cameraDiscard(g_settings.discard_frames);
  int foundAec = g_settings.aec_value;
  ChannelMeans p99;
  bool ok = cameraAutoTuneExposure(foundAec, p99);
  ledOff();

  if (!ok) {
    return sendJson(req, "{\"ok\":false,\"error\":\"autotune failed — capture error during search\"}");
  }

  g_settings.aec_value = foundAec;
  configSave();
  cameraApplyLock();
  cameraDiscard(g_settings.discard_frames);

  float maxP99 = p99.r;
  if (p99.g > maxP99) maxP99 = p99.g;
  if (p99.b > maxP99) maxP99 = p99.b;
  bool inBand = maxP99 >= 200.0f && maxP99 <= 230.0f;

  String j = "{\"ok\":true,";
  j += "\"aec_value\":" + String(foundAec) + ",";
  j += "\"agc_gain\":" + String(g_settings.agc_gain) + ",";
  j += "\"roi_p99\":" + chanJson(p99, 1) + ",";
  j += "\"roi_p99_max\":" + String(maxP99, 1) + ",";
  j += "\"in_band\":" + String(inBand ? "true" : "false") + "}";
  return sendJson(req, j);
}

// ─── GET /ledtest ─────────────────────────────────────────────────────────────
// Captures ROI mean with LED off, then on. A near-zero delta means the LED
// isn't actually illuminating the sample — distinguishes "LED dead/unplugged"
// from "exposure/gain badly configured" (Bug 3), which otherwise both look
// like "dark image" to the user.
#define LED_TEST_DELTA_THRESHOLD 8.0f
static esp_err_t hLedTest(httpd_req_t* req) {
  ChannelMeans off, on;
  if (!cameraLedTest(off, on)) {
    return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "capture failed");
  }
  float dr = on.r - off.r, dg = on.g - off.g, db = on.b - off.b;
  float maxDelta = dr; if (dg > maxDelta) maxDelta = dg; if (db > maxDelta) maxDelta = db;
  bool responding = maxDelta > LED_TEST_DELTA_THRESHOLD;

  String j = "{\"ok\":true,";
  j += "\"led_off\":" + chanJson(off, 1) + ",";
  j += "\"led_on\":" + chanJson(on, 1) + ",";
  j += "\"delta\":" + String(maxDelta, 1) + ",";
  j += "\"responding\":" + String(responding ? "true" : "false");
  if (!responding) {
    j += ",\"error\":\"LED not responding — check wiring/power\"";
  }
  j += "}";
  return sendJson(req, j);
}

// ─── GET /thumb.jpg ──────────────────────────────────────────────────────────
static esp_err_t hThumb(httpd_req_t* req) {
  uint8_t* buf = nullptr; size_t len = 0;
  if (!cameraJpeg(&buf, &len)) {
    return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "jpeg failed");
  }
  cors(req);
  httpd_resp_set_type(req, "image/jpeg");
  esp_err_t r = httpd_resp_send(req, (const char*)buf, len);
  cameraJpegFree(buf);
  return r;
}

// read the full request body into a String
static bool readBody(httpd_req_t* req, String& out) {
  int total = req->content_len;
  if (total <= 0 || total > 4096) return false;
  out.reserve(total + 1);
  char chunk[257];
  int received = 0;
  while (received < total) {
    int r = httpd_req_recv(req, chunk, min((int)sizeof(chunk) - 1, total - received));
    if (r <= 0) return false;
    chunk[r] = '\0'; out += chunk; received += r;
  }
  return true;
}

// minimal JSON scalar extractor: "key": number  (returns default if absent)
static float jNum(const String& s, const char* key, float def) {
  int k = s.indexOf(String("\"") + key + "\"");
  if (k < 0) return def;
  int c = s.indexOf(':', k);
  if (c < 0) return def;
  return s.substring(c + 1).toFloat();
}
static bool jHasKey(const String& s, const char* key) {
  return s.indexOf(String("\"") + key + "\"") >= 0;
}
static bool jRect(const String& s, const char* key, RectN& out) {
  int k = s.indexOf(String("\"") + key + "\"");
  if (k < 0) return false;
  int o = s.indexOf('{', k); int e = s.indexOf('}', o);
  if (o < 0 || e < 0) return false;
  String sub = s.substring(o, e + 1);
  out.x = jNum(sub, "x", out.x); out.y = jNum(sub, "y", out.y);
  out.w = jNum(sub, "w", out.w); out.h = jNum(sub, "h", out.h);
  return true;
}

// ─── POST /config ────────────────────────────────────────────────────────────
// Bug 2 fix: validate every field on a COPY of the settings first; if
// anything is out of range, reject the whole request with 400 + a message
// naming the field, and change nothing. Only commit + apply if everything
// passes. This is what stops "exposure/gain 0" (or any other typo) from
// ever reaching the sensor and producing a black/broken image.
static esp_err_t hConfig(httpd_req_t* req) {
  String body;
  if (!readBody(req, body)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad body");

  Settings tmp = g_settings;
  jRect(body, "roi", tmp.roi);
  jRect(body, "patchA", tmp.patchA);
  jRect(body, "patchB", tmp.patchB);
  if (jHasKey(body, "aec_value"))     tmp.aec_value = (int)jNum(body, "aec_value", tmp.aec_value);
  if (jHasKey(body, "agc_gain"))      tmp.agc_gain  = (int)jNum(body, "agc_gain",  tmp.agc_gain);
  if (jHasKey(body, "r_gain"))        tmp.r_gain    = jNum(body, "r_gain", tmp.r_gain);
  if (jHasKey(body, "b_gain"))        tmp.b_gain    = jNum(body, "b_gain", tmp.b_gain);
  if (jHasKey(body, "frame_count"))   tmp.frame_count = (int)jNum(body, "frame_count", tmp.frame_count);
  if (jHasKey(body, "settle_ms"))     tmp.settle_ms   = (int)jNum(body, "settle_ms",   tmp.settle_ms);
  if (jHasKey(body, "interval_ms"))   tmp.interval_ms = (int)jNum(body, "interval_ms", tmp.interval_ms);
  if (jHasKey(body, "discard_frames")) tmp.discard_frames = (int)jNum(body, "discard_frames", tmp.discard_frames);

  if (tmp.aec_value < 1 || tmp.aec_value > 1200) {
    return sendJsonStatus(req, 400, "Bad Request",
      "{\"ok\":false,\"error\":\"aec_value must be 1-1200 (got " + String(tmp.aec_value) + ")\"}");
  }
  if (tmp.agc_gain < 0 || tmp.agc_gain > 30) {
    return sendJsonStatus(req, 400, "Bad Request",
      "{\"ok\":false,\"error\":\"agc_gain must be 0-30 (got " + String(tmp.agc_gain) + ")\"}");
  }
  if (tmp.r_gain <= 0 || tmp.r_gain > 8 || tmp.b_gain <= 0 || tmp.b_gain > 8) {
    return sendJsonStatus(req, 400, "Bad Request",
      "{\"ok\":false,\"error\":\"r_gain/b_gain must be > 0 and <= 8\"}");
  }
  if (tmp.frame_count < 1 || tmp.frame_count > 32) {
    return sendJsonStatus(req, 400, "Bad Request",
      "{\"ok\":false,\"error\":\"frame_count must be 1-32\"}");
  }

  g_settings = tmp;
  configSave();
  cameraApplyLock();                 // re-apply exposure/gain
  cameraDiscard(g_settings.discard_frames);   // discard after setting change
  return sendJson(req, "{\"ok\":true}");
}

// ─── POST /blank & POST /measure ─────────────────────────────────────────────
static esp_err_t hBlank(httpd_req_t* req)   { return sendJson(req, runSequenceJson(true)); }
static esp_err_t hMeasure(httpd_req_t* req) { return sendJson(req, runSequenceJson(false)); }

// ─── OPTIONS (CORS preflight) ────────────────────────────────────────────────
static esp_err_t hOptions(httpd_req_t* req) {
  cors(req);
  httpd_resp_set_status(req, "204 No Content");
  return httpd_resp_send(req, NULL, 0);
}

void startWebServer() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  // Comfortable headroom above the routes below (ESP-IDF's own default is
  // only 8 and silently drops anything past it — always set this explicitly).
  cfg.max_uri_handlers = 20;
  cfg.recv_wait_timeout = 30;   // seconds — measure body is short but sequence is long
  cfg.send_wait_timeout = 30;
  cfg.lru_purge_enable = true;

  esp_err_t startErr = httpd_start(&s_server, &cfg);
  Serial.printf("httpd_start: %s (max_uri_handlers=%d)\n",
                startErr == ESP_OK ? "OK" : "FAILED", cfg.max_uri_handlers);
  if (startErr != ESP_OK) return;

  // Log every registration's result — the fastest way to confirm over Serial
  // that a given endpoint (e.g. POST /measure) is actually live on the box.
  int registered = 0, failed = 0;
  auto reg = [&](const char* uri, httpd_method_t m, esp_err_t (*fn)(httpd_req_t*)) {
    httpd_uri_t u = { uri, m, fn, nullptr };
    esp_err_t err = httpd_register_uri_handler(s_server, &u);
    const char* mName = (m == HTTP_GET) ? "GET" : (m == HTTP_POST) ? "POST" : "OPTIONS";
    Serial.printf("  route %-7s %-12s -> %s\n", mName, uri, err == ESP_OK ? "OK" : "FAILED");
    if (err == ESP_OK) registered++; else failed++;
  };
  Serial.println("Registering HTTP routes:");
  reg("/ping",      HTTP_GET,  hPing);
  reg("/status",    HTTP_GET,  hStatus);
  reg("/probe",     HTTP_GET,  hProbe);
  reg("/autotune",  HTTP_POST, hAutotune);
  reg("/ledtest",   HTTP_GET,  hLedTest);
  reg("/thumb.jpg", HTTP_GET,  hThumb);
  reg("/config",    HTTP_POST, hConfig);
  reg("/blank",     HTTP_POST, hBlank);
  reg("/measure",   HTTP_POST, hMeasure);
  reg("/status",    HTTP_OPTIONS, hOptions);
  reg("/config",    HTTP_OPTIONS, hOptions);
  reg("/blank",     HTTP_OPTIONS, hOptions);
  reg("/measure",   HTTP_OPTIONS, hOptions);
  reg("/autotune",  HTTP_OPTIONS, hOptions);
  Serial.printf("Routes: %d registered, %d failed\n", registered, failed);
}
