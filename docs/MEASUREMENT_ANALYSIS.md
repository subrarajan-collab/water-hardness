# InPhoton-Aqua — Measurement & Calibration Analysis

Reference for optimising the rig and designing a standards series. Every
number here is read from the current code, not from memory.

Sources: `firmware/aqua-box-esp32cam/aqua_{camera,measure,endpoints}.cpp`,
`src/utils/{colorAnalysis,deviceCalibration,readiness,channelPref}.js`,
`src/api/boxClient.js`.

---

## 1. Signal chain, end to end

```
white LED ──▶ diffuser ──▶ sample ──▶ OV3660 ──▶ ROI mean ──▶ A ──▶ ppm
             (3mm opal)   (bottle)   QVGA RGB565           log10   piecewise
                                     locked pipeline               linear curve
```

### Camera pipeline (locked for linearity) — `aqua_camera.cpp`
| Stage | State | Why |
|---|---|---|
| Resolution | QVGA 320×240, **RGB565** | mean over ROI; resolution irrelevant, speed matters |
| AEC (auto exposure) | **off**, fixed `aec_value` | auto-exposure would cancel the very signal being measured |
| AGC (auto gain) | **off**, fixed `agc_gain` | same |
| AWB (auto white balance) | **off** | same |
| Raw gamma | **off** | **critical**: gamma breaks pixel ∝ intensity, which Beer–Lambert needs |
| Lens shading, BPC, WPC, DCW | off | all are non-linear spatial corrections |
| brightness/contrast/saturation | 0 | neutral |
| White balance | **manual digital gain**: `r' = clamp(r·r_gain)`, `b' = clamp(b·b_gain)`; **green is never scaled** | green is the reference channel |

**RGB565 quantisation matters here:** red and blue are **5-bit (32 levels)**,
green is **6-bit (64 levels)**. Green therefore has **2× the quantisation
resolution** of red/blue before any other consideration — a second, independent
reason green is the right measurement channel. Per-pixel green step ≈ 4 counts
(8-bit scale), but averaging over the thousands of pixels in the ROI dithers
this down substantially, so effective resolution is far finer than 1 LSB.

### `/measure` sequence — `aqua_measure.cpp::runSequenceJson`
1. LED **on** → discard `discard_frames` (3) → settle `settle_ms` (2000 ms)
2. LED **off** → discard 3 → **capture dark frame** (ROI + patch means)
3. LED **on** → discard 3
4. **13 frames** (`frame_count`) at `interval_ms` (1000 ms):
   `net_ch = max(1, lit_ch − dark_ch)` per region/channel; track max saturation %
5. LED **off**
6. **Gate**: `maxSat > 1%` → hard error, no result
7. Per frame, per channel: `A_ch = log10(blank_net_ch / frame_net_ch)`
8. **MAD outlier rejection**: `tol = max(0.02, 3·MAD)`; keep frames within tol of
   the median; if fewer than 3 survive, keep all
9. Average kept frames → `A_red`, `A_green`, `A_blue`; report σ
10. Warnings: dark mean > 15 → light leak; blank age < 0 or > 24 h → stale

**`/blank`** runs the same capture and stores the **median** per-channel net
means as the reference (plus a timestamp). Note the asymmetry: blank uses
*median* across frames, measure uses *mean of kept* frames.

> ⚠ **Known defect (see §6)**: step 8's rejection metric and step 9's reported
> σ are both computed on **A_blue**, regardless of the app's chosen channel.

---

## 2. Absorbance → ppm math (app side)

**Channel selection** (`channelPref.js`): active channel default **green**,
stored *with* the calibration and applied identically at build and measure
time. `measureToAnalysis(m, channel)` sets `absorbance = m.A_green`.

**Curve** (`colorAnalysis.js::computeHardness`): **piecewise-linear** ppm vs
absorbance.
- Points sorted by absorbance; linear interpolation between bracketing points.
- **Extrapolates** beyond both ends using the end segment's slope.
- Clamps `ppm ≥ 0`, **rounds to integer ppm**.
- Returns `null` unless **every** calibration point has an absorbance — one
  bad point ⇒ no ppm at all.

**Per-box factor** (`deviceCalibration.js`): `A_device = m·A_master + c`.
At measure time it inverts: `A_master = (A_device − c)/m`, then looks up ppm.
Fit from blank + one standard:
```
m = (standardA − blankA) / (A_master(standardPpm) − A_master(0))
c = blankA − m · A_master(0)
```

---

## 3. Every gate and threshold

| Check | Threshold | Effect | Where |
|---|---|---|---|
| ROI saturation | > **1 %** of pixels ≥250 | **hard error**, measurement rejected | firmware |
| Light leak | dark mean > **15**/255 | warning | firmware |
| Blank staleness | > **24 h** or unknown | warning + readiness fail | firmware + app |
| Auto-tune target | ROI **max-channel p99** in **200–230** | tunes `aec_value` | firmware |
| Probe verdict | p99max <180 dark / >245 bright / sat>1% clipping | advisory | firmware |
| Blank absorbance (link) | must be **−0.1 … +0.05** | fit rejected | app |
| Reagent response (link) | \|standardA − blankA\| ≥ **0.05** | fit rejected ("no reagent response") | app |
| Device slope m | **0.5 … 2.0** | fit rejected / factor ignored | app |
| Link validation | within **±10 %** of nominal | pass/fail | app |
| Full-cal validation | within **±15 %** of nominal | pass/fail | app |
| Full-cal per-standard σ | > **0.02** | offers re-run | app (green ✓) |
| Curve consistency | any segment reverses | **blocks save** | app |
| Exposure consistency | all standards must share the reference's exposure signature | blocks measuring | app |

## 4. Adjustable parameters

| Parameter | Range | Default | Notes |
|---|---|---|---|
| `aec_value` (exposure) | 1–1200 | 300 | set by Auto-tune |
| `agc_gain` | 0–30 | 2 | gain adds noise; prefer exposure |
| `r_gain`, `b_gain` (WB) | 0.1–8 | 1.0 | digital, applied before stats |
| `frame_count` | 1–32 | 13 | √N averaging |
| `settle_ms` | — | 2000 | LED warm-up after switch-on |
| `interval_ms` | — | 1000 | between frames |
| `discard_frames` | — | 3 | after any sensor/LED change |

---

## 5. What actually limits accuracy (ranked, for optimisation)

1. **Green dynamic range on the blank.** Auto-tune targets the **max channel's**
   p99 at 200–230. With a warm/red-heavy white LED, **red** will be the max
   channel, so green settles well below full scale — wasting green's range.
   **Fix: tune `r_gain`/`b_gain` so the blank reads near-neutral (R≈G≈B).**
   Then auto-tune maximises green too. This is the single highest-leverage
   optimisation available and it costs nothing.
2. **Blank drift** — every A is relative to the stored blank. LED thermal drift,
   any mechanical movement, or bottle re-seating invalidates it. Re-blank often;
   the 24 h limit is an upper bound, not a recommendation.
3. **Reagent/chemistry linearity.** EBT complex response is **not** guaranteed
   linear in ppm over a wide range — this is exactly why the curve is
   piecewise-linear rather than a single slope. Concentrate standards where the
   curve bends.
4. **Path length / bottle repeatability.** A ±1 mm seating change changes the
   optical path. The seat/collar matters more than the electronics.
5. **Dark-frame assumption.** One dark frame is subtracted from all 13 lit
   frames; it assumes dark is stable for the ~15 s that follows.
6. **RGB565 green quantisation** (6-bit) — mitigated by ROI averaging.
7. **Gain noise** — `agc_gain` amplifies read noise. Prefer raising exposure.

---

## 6. Defects / inconsistencies found in review

### 6.1 σ and outlier rejection used blue, not the active channel — **FIXED (fw 1.3.0 / api v3)**
Previously `aqua_measure.cpp` computed `aBlue[i] = log10(blank.b/frame.b)`, did
MAD rejection on it, and returned `absorbance_sigma = σ(A_blue)` — so the
"Repeatability (σ)" shown next to a **green** absorbance was blue's σ, and frame
rejection was decided by the weakest channel (blue's inflated MAD widened `tol`,
letting bad frames survive).

Fix:
- New **`channel`** setting (own NVS key — deliberately *not* inside `Settings`,
  because `configLoad()` wipes everything to defaults when `sizeof(Settings)`
  changes, which would have reset the user's ROI/exposure on update).
  Settable via `/config {"channel":"green"}`, reported in `/status`.
- Outlier rejection now keys on the **active channel**.
- `/measure` returns **`sigma_red`/`sigma_green`/`sigma_blue`** plus the active
  `channel`; `absorbance_sigma` is the active channel's σ.
- App prefers the per-channel σ and falls back to `absorbance_sigma` only for
  pre-v3 firmware. The app pushes the channel to the box when it's chosen and
  before capturing a calibration reference.

Measured impact (unit test): box reported σ_blue = 0.041 where true σ_green =
0.004 — a **10× overstatement** of the instrument's repeatability.

**Requires a reflash** to fw 1.3.0. Existing ROI/exposure survive it.

### 6.2 Auto-tune optimises the max channel, not the measurement channel
See §5.1. Defensible (prevents any channel clipping) but means green is not
explicitly maximised. Mitigated by neutral WB gains.

### 6.3 Blank uses median, measure uses mean-of-kept
Minor estimator asymmetry between the reference and the sample.

---

## 7. Data recorded (what you can analyse)

**Per calibration point** (Full Calibration): `hardness` (ppm),
`absorbance` (active channel), `absR/absG/absB`, `rawR/rawG/rawB`, `sigma`,
`exposureSig`, `measuredAt`.

**Per history entry**: ppm, absorbance + all channels, σ, frames kept/rejected,
raw R/G/B, saturation, dark level, blank age + capture time, box_id, fw version,
device factor {m,c}, master-curve hash, app version, QC flag/nominal/pass.
Exportable as CSV from Results.

**Probe ring buffer** (Setup → Advanced): last 60 probes with timestamp, ROI
R/G/B, saturation %, and the exposure/gain/WB in force. CSV-exportable — this
is the fastest path for characterising a dilution series without the full
calibration flow.

---

## 8. Recommended sequence before calibrating standards

1. **Neutralise WB on the blank**: put the 0 ppm blank in, Setup → Refresh probe,
   adjust `r_gain`/`b_gain` until R ≈ G ≈ B. *(Do this before auto-tune.)*
2. **Auto-tune exposure** on that blank → verdict "ok", saturation < 1 %.
3. **Noise floor**: Set-as-reference on the blank, then re-probe it 3–5×.
   The spread in A_green is your instrument's noise floor — nothing you measure
   can be more precise than this.
4. **Characterise the reagent quickly** with the probe + quick-compare mode
   (no LED transistor or blank needed): run a coarse dilution series, export the
   probe CSV, and plot A_green vs ppm. This tells you the useful range and where
   the response saturates **before** you commit to a 6-standard calibration.
5. **Pick standards from that plot**: cluster them where the curve bends; avoid
   the flat/saturated tail. Then run Full Calibration with your custom list.
