#include "aqua_endpoints.h"
#include "aqua_config.h"
#include "aqua_camera.h"
#include "aqua_measure.h"
#include "esp_http_server.h"
#include "esp_timer.h"

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

static String rectJson(const RectN& r) {
  return "{\"x\":" + String(r.x,4) + ",\"y\":" + String(r.y,4) +
         ",\"w\":" + String(r.w,4) + ",\"h\":" + String(r.h,4) + "}";
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
static esp_err_t hProbe(httpd_req_t* req) {
  ledOn();  cameraDiscard(g_settings.discard_frames);
  RegionResult lit; cameraRegions(lit);
  ledOff(); cameraDiscard(g_settings.discard_frames);
  RegionResult dark; cameraRegions(dark);
  String j = "{\"ok\":true,";
  j += "\"roi\":{\"r\":" + String(lit.roi.r,2) + ",\"g\":" + String(lit.roi.g,2) + ",\"b\":" + String(lit.roi.b,2) + "},";
  j += "\"patchA\":{\"r\":" + String(lit.patchA.r,2) + ",\"g\":" + String(lit.patchA.g,2) + ",\"b\":" + String(lit.patchA.b,2) + "},";
  j += "\"patchB\":{\"r\":" + String(lit.patchB.r,2) + ",\"g\":" + String(lit.patchB.g,2) + ",\"b\":" + String(lit.patchB.b,2) + "},";
  j += "\"roi_saturation_pct\":" + String(lit.roiSatPct,2) + ",";
  j += "\"dark_level\":{\"r\":" + String(dark.roi.r,2) + ",\"g\":" + String(dark.roi.g,2) + ",\"b\":" + String(dark.roi.b,2) + "}}";
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
static esp_err_t hConfig(httpd_req_t* req) {
  String body;
  if (!readBody(req, body)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad body");
  jRect(body, "roi", g_settings.roi);
  jRect(body, "patchA", g_settings.patchA);
  jRect(body, "patchB", g_settings.patchB);
  g_settings.aec_value = (int)jNum(body, "aec_value", g_settings.aec_value);
  g_settings.agc_gain  = (int)jNum(body, "agc_gain",  g_settings.agc_gain);
  g_settings.frame_count = (int)jNum(body, "frame_count", g_settings.frame_count);
  g_settings.settle_ms   = (int)jNum(body, "settle_ms",   g_settings.settle_ms);
  g_settings.interval_ms = (int)jNum(body, "interval_ms", g_settings.interval_ms);
  g_settings.discard_frames = (int)jNum(body, "discard_frames", g_settings.discard_frames);
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
  // Comfortable headroom above the 11 routes below (ESP-IDF's own default is
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
  reg("/thumb.jpg", HTTP_GET,  hThumb);
  reg("/config",    HTTP_POST, hConfig);
  reg("/blank",     HTTP_POST, hBlank);
  reg("/measure",   HTTP_POST, hMeasure);
  reg("/status",    HTTP_OPTIONS, hOptions);
  reg("/config",    HTTP_OPTIONS, hOptions);
  reg("/blank",     HTTP_OPTIONS, hOptions);
  reg("/measure",   HTTP_OPTIONS, hOptions);
  Serial.printf("Routes: %d registered, %d failed\n", registered, failed);
}
