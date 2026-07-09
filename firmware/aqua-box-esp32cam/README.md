# AQUA-BOX Firmware — ESP32-CAM

WiFi water-hardness measurement box. Locked, linear camera pipeline (no
auto-exposure, no gamma) + digital LED + JSON HTTP API. Device-agnostic API so
a future TCS34725 box can serve the same endpoints (minus `preview`).

## Hardware
- **AI-Thinker ESP32-CAM** (OV2640, PSRAM required)
- **Illumination LED on GPIO13** via an NPN transistor (base through ~1 kΩ,
  LED + resistor on the collector). Digital HIGH/LOW only — **no PWM** (PWM
  causes rolling-shutter banding). Pin is driven LOW at boot.
- Do **not** fit an SD card (GPIO13 is the SD data line).

## Build (Arduino IDE)
1. Boards Manager → **esp32 by Espressif** (v2.0.x or v3.x).
2. Board: **AI Thinker ESP32-CAM**.
3. **PSRAM: Enabled**, Partition Scheme: **Huge APP (3MB)**, Flash 4MB.
4. Put all files from this folder together (the `.ino` + the `aqua_*.h/.cpp`).
5. Flash over an FTDI adapter (GPIO0→GND to enter bootloader, then reset).

PlatformIO users: see `platformio.ini`.

## WiFi
- Default **SoftAP `AQUA-BOX`**, device at **192.168.4.1**.
- To join home WiFi instead, set `sta_mode`, `sta_ssid`, `sta_pass` in NVS (a
  future `/wifi` endpoint or a one-off sketch edit) — in STA mode NTP is used
  so `blank_age_s` is wall-clock accurate. mDNS name `aqua-box.local` is
  advertised but never required.

## Camera pipeline (locked for absorbance linearity)
QVGA (320×240) RGB565. Disabled: AEC, AEC2, AGC, AWB, AWB-gain, **raw gamma**,
lens shading, BPC/WPC/DCW, special effects; brightness/contrast/saturation = 0.
`aec_value` and `agc_gain` are fixed from NVS. After any sensor-setting or LED
change, 3 frames are captured and discarded before data is used.

## HTTP API (JSON, CORS enabled)
| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | device_type, fw_version, box_id (MAC), capabilities, settings, blank_age_s, uptime |
| GET | `/probe` | one lit + one dark capture: ROI + both patch means/channel, ROI saturation %, dark level |
| GET | `/thumb.jpg` | current frame as JPEG (setup preview) |
| POST | `/config` | ROI + 2 patch rects (normalized 0–1), aec_value, agc_gain, frame_count, settle_ms, interval_ms, discard_frames → NVS |
| POST | `/blank` | full sequence; stores net per-channel means + timestamp |
| POST | `/measure` | full sequence; returns A_blue/A_red/A_green, sigma, raw means, frames_kept, saturation_pct, dark_level, blank_age_s, warnings |

### Measurement sequence (`/measure`, ~25 s, synchronous)
LED on → discard 3 → settle 2 s → LED off → discard 3 → **dark frame** →
LED on → discard 3 → **13 frames @ 1 s** → per-frame ROI/patch means − dark →
median+MAD outlier rejection on A_blue → per-channel `A = log₁₀(blank_net /
frame_net)` averaged over kept frames. `vTaskDelay` between frames yields to the
idle task (feeds the watchdog).

### Gates
- **Clipping**: >1 % of ROI pixels ≥250 on any channel → `{ok:false,error:"clipping — reduce exposure or brightness"}`.
- **Light leak**: dark-frame mean high → warning in `warnings[]`.
- **Stale blank**: older than 24 h (or unknown after a power cycle in AP mode) → warning.

## Notes
- `blank_age_s` is exact in STA mode (NTP). In SoftAP mode there is no wall
  clock, so age is measured from the box's own uptime and returns **-1
  (unknown)** after a power cycle — the app treats unknown as "recapture".
- If `/probe` shows red/blue swapped, set `RGB565_BYTESWAP 1` in `aqua_config.h`.
