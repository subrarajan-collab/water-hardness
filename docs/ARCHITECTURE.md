# InPhoton-Aqua — Code & Architecture Map

Companion to `MEASUREMENT_ANALYSIS.md` (the physics/calibration deep-dive) and
`BOX_DESIGN_BRIEF.md` (optics/enclosure). This one is the software: what each
file does, how data flows, and where the seams are.

~5,400 lines total: ~4,400 app (React Native/Expo) + ~1,000 firmware (Arduino/C++).

---

## 1. The one-line summary

A phone app talks over local WiFi HTTP to a sealed ESP32-CAM box. **All optics
and pixel maths live in firmware; the app never sees a pixel** — it receives a
final absorbance and turns it into ppm via a calibration curve.

That split is the single most important architectural fact: it means the app is
a UI + calibration-bookkeeping layer, and it's why the app works identically
against a future TCS34725 sensor box that has no camera at all.

```
┌─ ESP32-CAM box (C++) ──────────────┐        ┌─ Phone app (React Native) ─────┐
│ optics, exposure lock, ROI means,  │  HTTP  │ readiness, calibration curve,  │
│ dark subtraction, outlier          │◀──────▶│ ppm lookup, history, UI        │
│ rejection, absorbance A            │  JSON  │                                │
└────────────────────────────────────┘        └────────────────────────────────┘
```

---

## 2. Firmware (`firmware/aqua-box-esp32cam/`, ~1,000 lines)

| File | Lines | Responsibility |
|---|---|---|
| `aqua-box-esp32cam.ino` | 80 | globals, WiFi (SoftAP/STA), boot sequence |
| `aqua_config.h/.cpp` | 179 | `Settings` struct, NVS persistence, channel, pin map, versions |
| `aqua_camera.h/.cpp` | 308 | camera init, **locked linear pipeline**, ROI/patch means + p99 + saturation, auto-tune, LED test |
| `aqua_measure.cpp` | 191 | the measurement sequence, dark subtraction, MAD rejection, absorbance |
| `aqua_endpoints.cpp` | 342 | HTTP server, JSON, validation, CORS |

**Boot order matters** (`.ino::setup`): `ledInit()` runs *first* — the LED pin is
driven LOW before anything else, so a half-initialised box can't sit with the
LED on. Then config → channel → blank → camera → WiFi → HTTP.

**NVS keys** (survive reflash — this is why a sealed box keeps its setup):
- `settings` — raw `Settings` struct bytes. ⚠ `configLoad()` resets **everything
  to defaults** if `sizeof(Settings)` changes. Adding a field silently wipes the
  user's ROI/exposure. *This is why `channel` got its own key.*
- `channel` — measurement channel (int enum)
- `blank` — reference means + timestamp

### HTTP API (all JSON, CORS on, `max_uri_handlers = 20`)
| Method | Path | Notes |
|---|---|---|
| GET | `/ping` | api_version only — called first on connect so stale firmware reports a version, not a mystery 404 |
| GET | `/status` | box_id (MAC), fw, api, sensor, capabilities, settings, channel, blank age, uptime |
| GET | `/probe` | one lit + one dark capture: ROI/patch means, p99, saturation %, verdict |
| POST | `/autotune` | binary-searches `aec_value` → ROI max-channel p99 in 200–230 |
| GET | `/ledtest` | LED off vs on delta → distinguishes dead LED from bad exposure |
| GET | `/thumb.jpg` | preview frame |
| POST | `/config` | ROI/patches, exposure, gain, WB, channel — **validated, 400 + message on bad input** |
| POST | `/blank` | capture reference |
| POST | `/measure` | full ~25 s sequence → absorbances + diagnostics |

Every route registration is logged over serial with OK/FAILED — the fastest way
to confirm an endpoint is actually live.

### Version history
| fw | api | Change |
|---|---|---|
| 1.1.0 | 1 | `/ping`, route logging |
| 1.2.0 | 2 | manual WB gains, p99-driven guidance, `/autotune`, `/ledtest`, `/config` validation ← **the sealed box runs this** |
| 1.3.0 | 3 | configurable channel; rejection + σ follow it; per-channel σ returned |

---

## 3. App (`src/`, ~4,400 lines)

### Layers
```
App.js ─ 4 bottom tabs + Calibration sub-stack
  │
  ├── context/BoxConnectionContext.js ── ip/status/boxId/deviceKey, shared by all tabs
  ├── api/boxClient.js ───────────────── THE ONLY place that knows URLs/paths
  ├── utils/ ─────────────────────────── pure logic (all unit-tested)
  ├── components/ ────────────────────── shared UI
  └── screens/ ───────────────────────── one per task
```

### `api/boxClient.js` (285) — the network seam
No screen calls `fetch` directly. Owns base URL, every endpoint path, the
version policy, a 25-entry request-log ring buffer (feeds the debug panel), and
cancel tokens.

**Error taxonomy** — three kinds, mapped to three distinct user actions:
| kind | Means | User sees |
|---|---|---|
| `network` | never reached the box | "check WiFi is AQUA-BOX, disable mobile data" |
| `http` | box answered non-2xx → version/route mismatch | "update firmware or app" — **never called "unreachable"** |
| `gate` | 200 OK but the box's own logic refused (clipping, no blank…) | the specific gate message |
| `cancelled` | user hit Cancel | — |

This distinction was the fix for a real bug where a 404 was reported as
"box unreachable", sending debugging in exactly the wrong direction.

**Version policy is a *range*, not equality**: `MIN_API_VERSION=2` (works),
`RECOMMENDED_API_VERSION=3` (fully correct). Strict equality would nag forever
about a sealed box that physically cannot be reflashed.

### `utils/` — pure, testable logic
| File | Lines | Contains |
|---|---|---|
| `deviceCalibration.js` | 235 | per-box factor fit + guards, curve export/import + hash, device-key map |
| `readiness.js` | 138 | readiness model, hardness classes, monotonicity check, standards-list validation, dilution maths |
| `probeLog.js` | 96 | probe ring buffer, reference/quick-compare, settings signature, CSV |
| `calibration.js` | 69 | AsyncStorage for curve points + history (100 max) |
| `colorAnalysis.js` | 51 | piecewise-linear ppm ↔ absorbance |
| `channelPref.js` | 49 | active channel (green default), per-channel accessors |

Every one of these is exercised by Node unit tests run before each build
(no test runner — they're driven through babel + a module shim).

### Screens
| Screen | Lines | Role |
|---|---|---|
| `SetupScreen` | 753 | connect, ROI drag, live probe readout, quick-compare, auto-tune, LED test, blank, advanced |
| `FullCalibrationScreen` | 535 | the 6-standard wizard: editable list, per-standard re-measure, monotonicity gate, validation |
| `CalibrationScreen` | 326 | 3 guided flows + Advanced (points, plot, JSON, channel switch, box link) |
| `MeasurementScreen` | 311 | readiness checklist, live preview, measure, inline result |
| `LinkBoxScreen` | 273 | blank + 1 standard → device factor (no m/c jargon shown) |
| `ResultsScreen` | 261 | history, box filter, QC badges, CSV, detail |
| `AccuracyCheckScreen` | 189 | routine QC pass/fail |

### State & persistence (all AsyncStorage)
| Key | Holds |
|---|---|
| `calibration_points` | the curve (each point: ppm, active A, absR/G/B, raw R/G/B, σ, exposureSig, timestamp) |
| `measurement_channel_v1` | active channel |
| `device_calibration_v1` | **map** of deviceKey → {m, c, validated, …} — `phone:<model>` and `box:<id>` coexist |
| `full_cal_run_v1` | in-progress calibration (survives leaving the screen) |
| `probe_log_v1`, `probe_ref_v1` | probe ring buffer + quick-compare reference |
| `test_history` | last 100 results |
| `panel_layout_v1`, `setup_done`, `onboarding_done`, `wifi_last_ip` | UI/setup state |

---

## 4. Data flow of one measurement

```
Measure tap
  → POST /measure                     (box: 25 s, LED on/off, 13 frames, dark-sub, MAD, A per channel)
  → measureToAnalysis(m, channel)     (app: absorbance = A_green; σ = sigma_green if fw ≥1.3)
  → computeHardnessDeviceAware()      (app: A_master = (A−c)/m → piecewise-linear → ppm)
  → classifyHardness(ppm)             (soft/moderate/hard/very hard)
  → ResultPanel                       (ppm big, class chip, gate line; numbers in accordion)
  → saveTestResult()                  (history + full traceability)
```

**Traceability recorded per result**: ppm, all-channel absorbance, σ, frames
kept/rejected, raw RGB, saturation, dark level, blank age + capture time,
box_id, fw version, device factor {m,c}, master-curve hash, app version, QC flag.
So any historical number can be re-explained later.

---

## 5. Deliberate design decisions worth knowing

1. **Firmware owns the physics.** The app can't "fix" a bad measurement; it can
   only refuse it. Gates live where the data is.
2. **Channel travels with the calibration.** Stored alongside the curve and
   pushed to the box, so build-time and measure-time can't silently diverge —
   that would produce plausible, wrong ppm.
3. **Two-tier calibration.** A shared master curve (portable, exportable) plus a
   per-box linear factor. Boxes differ in LED/optics; this avoids recalibrating
   every unit from scratch.
4. **Per-channel data kept everywhere**, so switching channels rebuilds the
   curve without re-measuring.
5. **Prefer null over a wrong number.** σ shows "needs fw 1.3+" rather than
   blue's σ next to a green reading.
6. **PSRAM detected, DRAM fallback.** Assuming PSRAM caused a boot-loop crash on
   real hardware; the driver's frame queue never initialises and the first ISR
   asserts.
7. **Recovery tags**: `v1-phone-camera`, `v2-esp32-only`, `v3-pre-ux-overhaul`.

---

## 6. Known open items

| Item | Status |
|---|---|
| Sealed box stuck on fw 1.2.0 → per-run σ unavailable, rejection blue-keyed | app degrades honestly; fix needs reflash |
| No OTA — a sealed box can never be updated (ROM bootloader is UART-only; OTA needs code already running) | **recommend adding before the next build is sealed** |
| Auto-tune optimises max channel, not the measurement channel | mitigate via neutral WB gains (see analysis §5.1) |
| Blank uses median, measure uses mean-of-kept | minor estimator asymmetry |
| Patches A/B measured + stored but unused by the maths | kept as diagnostics |
