# AQUA-BOX — Design Brief for Enclosure & Optics

Everything the physical box must satisfy, derived from what the firmware and
app actually measure. Use this to dimension the enclosure and place the LED,
diffuser, sample, and ESP32-CAM.

## 1. What the system measures (drives every optical decision)

Transmission colorimetry: white LED → diffuser → through the water sample →
ESP32-CAM. Firmware computes per-channel absorbance
`A = log10(blank_net / sample_net)` over ONE rectangular region (the "Sample"
ROI) after subtracting a dark frame (LED off). The app maps A_blue → ppm.

Implications:
- **Only the ROI matters optically.** The lit field must be bright and
  uniform *behind the sample as seen through the ROI*. (Patches A/B are
  diagnostics only — no longer sized for.)
- **Absolute focus does not matter.** The reading is the mean over the ROI;
  a defocused image is fine (even beneficial — it averages texture).
  Uniformity and stability matter instead.
- **The LED must be switchable by the box** (GPIO13 → transistor). The dark
  frame is captured with LED off; an always-on LED breaks the math.
- **Repeatability beats everything**: sample, LED, camera must not move
  relative to each other between blank and measurement.

## 2. Camera facts (AI-Thinker ESP32-CAM, OV2640, stock lens)

| Property | Value | Design consequence |
|---|---|---|
| Resolution used | QVGA 320×240, 4:3 | ROI defaults assume 4:3 framing |
| Horizontal FOV | ~66° | frame width ≈ 1.30 × distance |
| Vertical FOV | ~50° | frame height ≈ 0.93 × distance |
| Focus | fixed, sharp ≥ ~30 cm | at 8–12 cm image is soft — acceptable (mean-based) |
| Exposure | locked, autotuned 1–1200 | wide brightness tolerance, but hotspots must be avoided |
| Gate | >1% ROI pixels ≥250 → measurement rejected | diffuser is mandatory, no direct LED view |
| Dark warn | dark-frame mean > 15/255 → light-leak warning | enclosure must be light-tight |

Default ROI (normalized): x 0.42, y 0.30, w 0.16, h 0.40 → a tall rectangle
in the centre of the frame. The app lets the user drag it, so exact bottle
position is forgiving, but design so the liquid column lands centre-frame.

## 3. Optical axis & distances (recommended)

Single straight axis, all elements centred:

```
[white LED] --20-40mm--> [3mm opal acrylic diffuser] --40-80mm--> [sample bottle] --80-120mm--> [ESP32-CAM lens]
```

| Gap | Recommended | Why |
|---|---|---|
| LED → diffuser | 20–40 mm | lets the beam spread so the diffuser glows evenly; closer = hotspot, farther = dimmer (autotune compensates brightness, not non-uniformity) |
| Diffuser → sample | 40–80 mm | keeps the bottle from shadow-printing on the diffuser and lets the glowing panel act as a large uniform backlight |
| Sample → camera | **80–120 mm** (100 mm proven on the bench) | at 100 mm the frame is ~130 mm wide × ~93 mm tall — a Ø60 mm bottle spans ~45% of width, leaving margin for the ROI inside the liquid and tolerance for placement |

Sizing checks at 100 mm camera distance:
- Frame width ≈ 130 mm → **diffuser lit area should be ≥ bottle width + 20 mm**
  (≥ 80 mm for a Ø60 bottle); it only needs to cover the ROI's background,
  not the whole frame.
- Liquid column visible height must exceed ROI height: ROI 0.40 × 93 mm ≈
  37 mm of liquid minimum in view — fill lines / bottle seat should
  guarantee ≥ 50 mm of liquid behind the ROI.

Verticals: put the optical axis at the mid-height of the liquid column, not
of the bottle, so the ROI never clips the meniscus or the bottle bottom.

## 4. Mechanical requirements

1. **Light-tight enclosure** — target dark-frame mean ≤ 15/255 with room
   lights on. Labyrinth or gasket the lid; no straight light path in.
2. **Matte black interior** — 3D-print gloss reflects; flock/paint interior,
   especially surfaces the camera can see around the bottle.
3. **Bottle registration** — a seat/collar so the bottle always sits at the
   same position and rotation (±1 mm). The blank/sample comparison assumes
   identical geometry.
4. **Rigid camera & LED mounts** — any flex between blank and measurement
   shows up directly as false absorbance.
5. **Cable exits** — ESP32-CAM USB/5V and LED supply through baffled ports.
6. **LED drive** — 5V supply is fine, but the LED must switch via NPN
   transistor from GPIO13 (base 1 kΩ), and **supply ground must be common
   with ESP32 ground**. Constant current preferred; never PWM (rolling
   shutter banding).
7. **Serviceability** — diffuser and LED reachable without disturbing the
   camera mount (the ROI is calibrated to the camera's view).

## 5. Firmware/app parameters the design must respect

| Parameter | Value | Source |
|---|---|---|
| Measurement sequence | LED on → settle 2 s → LED off dark frame → LED on → 13 frames @ 1 s (~25 s total) | aqua_measure.cpp |
| Auto-tune target | ROI max-channel p99 in 200–230 (of 255) | /autotune |
| Saturation gate | >1% ROI pixels ≥250 → reject | hard gate |
| Light-leak warn | dark mean > 15 | warning |
| Reference water validity | 24 h | readiness model |
| Exposure range | aec 1–1200, gain 0–30 | /config limits |
| White balance | fixed digital r/b gains (default 1.0) | tune once per box |

## 6. Suggested validation sequence for a new box build

1. Assemble, no bottle → Setup → **LED test** → must show "responding".
2. Lid closed, LED off ambient → dark level ≤ 15 (check /probe dark_level).
3. Bottle of plain water + reagent blank seated → **Auto-tune exposure** →
   verdict "ok", saturation < 1%.
4. Capture reference water → 3 × Measure on the same blank → absorbance
   should read ≈ 0.000 with σ < 0.01. That's the box's noise floor.
5. Full calibration flow (6 standards) → validation pass ⇒ box is
   production-ready.
