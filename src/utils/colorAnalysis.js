import * as FileSystem from 'expo-file-system';
import jpeg from 'jpeg-js';

// Decodes a JPEG from a file URI and returns average RGB + derived metrics.
// opts.circular: analyse only the inscribed ellipse (for the vertical device,
// where the sample is a glowing disc — excludes the dark square corners).
export async function analyzeImageColors(uri, opts = {}) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // base64 → Uint8Array (atob is available in Hermes / RN 0.70+)
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const { data, width, height } = jpeg.decode(bytes, { useTArray: true });

  let r = 0, g = 0, b = 0;
  let count = 0;
  let saturated = 0; // pixels with any channel at/above clipping (≥250)

  if (opts.circular) {
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const rx = width / 2;
    const ry = height / 2;
    for (let y = 0; y < height; y++) {
      const dy = (y - cy) / ry;
      for (let x = 0; x < width; x++) {
        const dx = (x - cx) / rx;
        if (dx * dx + dy * dy > 1) continue;
        const i = (y * width + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        if (data[i] >= 250 || data[i + 1] >= 250 || data[i + 2] >= 250) saturated++;
        count++;
      }
    }
  } else {
    count = width * height;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      if (data[i] >= 250 || data[i + 1] >= 250 || data[i + 2] >= 250) saturated++;
      // data[i+3] is alpha — always 255 for JPEG, skip
    }
  }
  if (count === 0) count = 1;
  const satFraction = saturated / count;

  const avgR = Math.round(r / count);
  const avgG = Math.round(g / count);
  const avgB = Math.round(b / count);
  const total = avgR + avgG + avgB;

  return {
    r: avgR,
    g: avgG,
    b: avgB,
    blueScore: avgB,
    blueDominance: total > 0 ? parseFloat(((avgB / total) * 100).toFixed(1)) : 0,
    pixelCount: count,
    satFraction: parseFloat(satFraction.toFixed(4)),
  };
}

// Decodes a JPEG strip and returns the per-column mean blue value.
// Used by the panel-setup auto-placement to find where the lit panel is
// bright and flat across the frame width.
export async function analyzeColumnProfile(uri) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const { data, width, height } = jpeg.decode(bytes, { useTArray: true });

  const cols = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cols[x] += data[(y * width + x) * 4 + 2]; // blue channel
    }
  }
  for (let x = 0; x < width; x++) cols[x] = cols[x] / height;
  return { columns: cols, width, height };
}

// Combines a water-region analysis with one or two background (bare diffuser)
// reference analyses into a single per-frame result carrying exposure-immune
// per-channel absorbance.
//
// Why: with phone auto-exposure the raw blue of the water shifts frame-to-frame
// and day-to-day. But the BACKGROUND shifts by the same factor, so the ratio
// I_water / I_reference is immune to it. Absorbance A = log10(I_ref / I_water)
// is the linear-in-concentration quantity (Beer–Lambert) we calibrate against.
//
// Two references (left + right of the bottle, same height) are averaged to
// cancel the horizontal brightness gradient of the diffuser panel.
export function computeFrameMetrics(water, bgLeft, bgRight = null) {
  const ref = bgRight
    ? {
        r: (bgLeft.r + bgRight.r) / 2,
        g: (bgLeft.g + bgRight.g) / 2,
        b: (bgLeft.b + bgRight.b) / 2,
      }
    : { r: bgLeft.r, g: bgLeft.g, b: bgLeft.b };

  const absCh = (refV, wV) =>
    refV > 0 && wV > 0 ? parseFloat(Math.log10(refV / wV).toFixed(4)) : null;

  // Left/right patch mismatch (blue channel) — alignment quality indicator.
  let refMismatch = null;
  if (bgRight) {
    const mean = (bgLeft.b + bgRight.b) / 2;
    refMismatch = mean > 0 ? parseFloat((Math.abs(bgLeft.b - bgRight.b) / mean).toFixed(4)) : null;
  }

  return {
    // water region (kept for display / legacy calibration / label)
    r: water.r, g: water.g, b: water.b,
    blueScore: water.blueScore,
    blueDominance: water.blueDominance,
    pixelCount: water.pixelCount,
    // raw reference values (kept for result metadata)
    bgL: { r: bgLeft.r, g: bgLeft.g, b: bgLeft.b },
    bgRt: bgRight ? { r: bgRight.r, g: bgRight.g, b: bgRight.b } : null,
    bgBlue: Math.round(ref.b),
    refMismatch,
    // exposure-immune metrics — absorbance per channel; A_blue is primary
    absorbance: absCh(ref.b, water.b),
    absorbanceR: absCh(ref.r, water.r),
    absorbanceG: absCh(ref.g, water.g),
    transmittance:
      ref.b > 0 && water.b > 0 ? parseFloat((water.b / ref.b).toFixed(4)) : null,
  };
}

// Flat-field frame metrics. `background` is the stored no-bottle capture:
// { roi: {r,g,b}, patchL: {r,g,b}, patchR: {r,g,b} }.
//
// Per channel:  A_ch = log10[ (ROI_bg / Patch_bg) ÷ (ROI_meas / Patch_meas) ]
// where Patch = average of L+R in each shot. The patches bridge auto-exposure
// between the background shot and the measurement shot, so the panel's
// non-uniformity BEHIND the bottle cancels exactly — the ROI is compared to
// its own pixels in the background capture, not to the side patches.
export function computeFrameMetricsFlatField(water, bgLeft, bgRight, background) {
  const patchMeas = {
    r: (bgLeft.r + bgRight.r) / 2,
    g: (bgLeft.g + bgRight.g) / 2,
    b: (bgLeft.b + bgRight.b) / 2,
  };
  const patchBg = {
    r: (background.patchL.r + background.patchR.r) / 2,
    g: (background.patchL.g + background.patchR.g) / 2,
    b: (background.patchL.b + background.patchR.b) / 2,
  };

  const absCh = (ch) => {
    const roiBg = background.roi[ch], pBg = patchBg[ch];
    const roiM = water[ch], pM = patchMeas[ch];
    if (roiBg > 0 && pBg > 0 && roiM > 0 && pM > 0) {
      return parseFloat(Math.log10((roiBg / pBg) / (roiM / pM)).toFixed(4));
    }
    return null;
  };

  // Exposure-bridge consistency: L and R must agree about how the exposure
  // changed between the two shots. Disagreement = the phone moved.
  let bridgeMismatch = null;
  if (background.patchL.b > 0 && background.patchR.b > 0 && bgLeft.b > 0 && bgRight.b > 0) {
    const ratioL = bgLeft.b / background.patchL.b;
    const ratioR = bgRight.b / background.patchR.b;
    const mean = (ratioL + ratioR) / 2;
    bridgeMismatch = mean > 0 ? parseFloat((Math.abs(ratioL - ratioR) / mean).toFixed(4)) : null;
  }

  const tBlue =
    background.roi.b > 0 && patchBg.b > 0 && water.b > 0 && patchMeas.b > 0
      ? (water.b / patchMeas.b) / (background.roi.b / patchBg.b)
      : null;

  return {
    r: water.r, g: water.g, b: water.b,
    blueScore: water.blueScore,
    blueDominance: water.blueDominance,
    pixelCount: water.pixelCount,
    bgL: { r: bgLeft.r, g: bgLeft.g, b: bgLeft.b },
    bgRt: { r: bgRight.r, g: bgRight.g, b: bgRight.b },
    bgBlue: Math.round(patchMeas.b),
    // bridge consistency replaces the raw L≈R requirement in flat-field mode
    refMismatch: bridgeMismatch,
    absorbance: absCh('b'),
    absorbanceR: absCh('r'),
    absorbanceG: absCh('g'),
    transmittance: tBlue !== null ? parseFloat(tBlue.toFixed(4)) : null,
  };
}

// Averages multiple frame results into one. Outlier rejection is keyed on
// absorbance when the frames carry it (the exposure-immune metric), otherwise
// on raw blueScore (legacy path). Frames deviating from the median by more than
// max(floor, 3×MAD) are dropped so a single bad frame cannot skew the result.
export function averageAnalysisResults(allResults) {
  if (!allResults || allResults.length === 0) return null;

  const hasAbs = allResults.every((r) => typeof r.absorbance === 'number');
  const key = hasAbs ? 'absorbance' : 'blueScore';
  const floor = hasAbs ? 0.03 : 8;

  let results = allResults;
  let rejectedCount = 0;

  if (allResults.length >= 5) {
    const vals = allResults.map((r) => r[key]).sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    const absDev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = absDev[Math.floor(absDev.length / 2)];
    const tolerance = Math.max(floor, 3 * mad);
    results = allResults.filter((r) => Math.abs(r[key] - median) <= tolerance);
    rejectedCount = allResults.length - results.length;
    if (results.length < 3) {
      // rejection too aggressive (highly unstable capture) — keep everything
      results = allResults;
      rejectedCount = 0;
    }
  }

  const n = results.length;
  const mean = (f) => results.reduce((s, r) => s + f(r), 0) / n;

  const avgR = Math.round(mean((r) => r.r));
  const avgG = Math.round(mean((r) => r.g));
  const avgB = Math.round(mean((r) => r.b));
  const total = avgR + avgG + avgB;

  const out = {
    r: avgR,
    g: avgG,
    b: avgB,
    blueScore: avgB,
    blueDominance: total > 0 ? parseFloat(((avgB / total) * 100).toFixed(1)) : 0,
    pixelCount: Math.round(mean((r) => r.pixelCount)),
    frameCount: n,
    rejectedFrames: rejectedCount,
    // Standard deviation of blueScore across frames — quality indicator
    blueScoreStdDev: parseFloat(
      Math.sqrt(mean((r) => Math.pow(r.blueScore - avgB, 2))).toFixed(1)
    ),
  };

  if (hasAbs) {
    const avgAbs = mean((r) => r.absorbance);
    out.absorbance = parseFloat(avgAbs.toFixed(4));
    out.absorbanceStdDev = parseFloat(
      Math.sqrt(mean((r) => Math.pow(r.absorbance - avgAbs, 2))).toFixed(4)
    );
    out.transmittance = parseFloat(mean((r) => r.transmittance).toFixed(4));
    out.bgBlue = Math.round(mean((r) => r.bgBlue));
    if (results.every((r) => typeof r.absorbanceR === 'number')) {
      out.absorbanceR = parseFloat(mean((r) => r.absorbanceR).toFixed(4));
    }
    if (results.every((r) => typeof r.absorbanceG === 'number')) {
      out.absorbanceG = parseFloat(mean((r) => r.absorbanceG).toFixed(4));
    }
    const mm = results.filter((r) => typeof r.refMismatch === 'number');
    if (mm.length > 0) {
      out.refMismatch = parseFloat(
        (mm.reduce((s, r) => s + r.refMismatch, 0) / mm.length).toFixed(4)
      );
    }
    // Raw per-frame patch + ROI values (result metadata, kept frames only)
    out.frames = results.map((r) => ({
      w: [r.r, r.g, r.b],
      l: r.bgL ? [r.bgL.r, r.bgL.g, r.bgL.b] : null,
      rt: r.bgRt ? [r.bgRt.r, r.bgRt.g, r.bgRt.b] : null,
      A: r.absorbance,
    }));
  }

  return out;
}

// Generic piecewise-linear interpolation/extrapolation of ppm against `key`.
function interpolatePPM(x, points, key) {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a[key] - b[key]);

  const seg = (p1, p2, at) => {
    if (p2[key] === p1[key]) return Math.max(0, Math.round(p1.hardness));
    const slope = (p2.hardness - p1.hardness) / (p2[key] - p1[key]);
    return Math.max(0, Math.round(p1.hardness + slope * (at - p1[key])));
  };

  if (x <= sorted[0][key]) return seg(sorted[0], sorted[1], x);
  if (x >= sorted[sorted.length - 1][key]) {
    return seg(sorted[sorted.length - 2], sorted[sorted.length - 1], x);
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    if (x >= sorted[i][key] && x <= sorted[i + 1][key]) {
      return seg(sorted[i], sorted[i + 1], x);
    }
  }
  return null;
}

// Maps an analysis result to a ppm value using calibration points.
// Prefers absorbance (exposure-immune) when both the result and ALL calibration
// points carry it; otherwise falls back to legacy raw blueScore calibration.
export function computeHardness(analysisResult, calibrationPoints = []) {
  if (calibrationPoints.length < 2) return null;

  const canAbs =
    typeof analysisResult.absorbance === 'number' &&
    calibrationPoints.every((p) => typeof p.absorbance === 'number');
  if (canAbs) {
    return interpolatePPM(analysisResult.absorbance, calibrationPoints, 'absorbance');
  }

  const canBlue =
    typeof analysisResult.blueScore === 'number' &&
    calibrationPoints.every((p) => typeof p.blueScore === 'number');
  if (canBlue) {
    return interpolatePPM(analysisResult.blueScore, calibrationPoints, 'blueScore');
  }

  return null;
}

// Qualitative label based on blue dominance %
export function getHardnessLabel(blueDominance) {
  if (blueDominance >= 45) return { label: 'Soft',           color: '#29B6F6', range: '< 100 ppm' };
  if (blueDominance >= 35) return { label: 'Moderately Hard', color: '#7E57C2', range: '100–200 ppm' };
  if (blueDominance >= 25) return { label: 'Hard',            color: '#AB47BC', range: '200–300 ppm' };
  return                          { label: 'Very Hard',       color: '#C62828', range: '> 300 ppm' };
}
