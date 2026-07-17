// AQUA-BOX — WiFi water-hardness measurement box (AI-Thinker ESP32-CAM)
// Locked linear camera pipeline + digital LED + JSON HTTP API.
// See README.md for board settings and endpoint reference.

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <time.h>
#include "aqua_config.h"
#include "aqua_camera.h"
#include "aqua_endpoints.h"

// Globals declared extern in the headers
Settings  g_settings;
BlankData g_blank;
String    g_boxId;
int       g_channel = CH_GREEN;

static String macToBoxId() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

static void startWifi() {
  if (g_settings.sta_mode && g_settings.sta_ssid[0]) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(g_settings.sta_ssid, g_settings.sta_pass);
    Serial.printf("Joining %s", g_settings.sta_ssid);
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
      delay(250); Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("STA IP: "); Serial.println(WiFi.localIP());
      // NTP so blank_age_s survives across the day in STA mode
      configTime(0, 0, "pool.ntp.org", "time.nist.gov");
      return;
    }
    Serial.println("STA failed — falling back to SoftAP");
  }
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID);
  Serial.print("SoftAP \"" AP_SSID "\"  IP: ");
  Serial.println(WiFi.softAPIP());   // 192.168.4.1
}

void setup() {
  Serial.begin(115200);
  Serial.printf("\nAQUA-BOX fw=%s api_version=%d\n", FW_VERSION, API_VERSION);

  ledInit();          // LED pin LOW at boot, before anything else
  configLoad();
  channelLoad();
  blankLoad();
  Serial.printf("measurement channel: %s\n", channelName(g_channel));

  if (!cameraInit()) {
    Serial.println("FATAL: camera init failed");
  }

  startWifi();
  g_boxId = macToBoxId();
  Serial.print("box_id: "); Serial.println(g_boxId);

  if (MDNS.begin("aqua-box")) {      // optional, never required
    MDNS.addService("http", "tcp", 80);
  }

  startWebServer();
  Serial.println("HTTP server up");
}

void loop() {
  // All work is handled synchronously in the HTTP handlers.
  delay(1000);
}
