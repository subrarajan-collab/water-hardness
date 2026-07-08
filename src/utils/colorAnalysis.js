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
        count++;
      }
    }
  } else {
    count = width * height;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      // data[i+3] is alpha — always 255 for JPEG, skip
    }
  }
  if (count === 0) count = 1;

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
  };
}

// Combines a water-region analysis with a background (bare diffuser) analysis
// into a single per-frame result carrying the exposure-immune metrics.
//
// Why: with phone auto-exposure the raw blue of the water shifts frame-to-frame
// and day-to-day. But the BACKGROUND shifts by the same factor, so the ratio
// I_water / I_background is immune to it. Absorbance A = log10(I_bg / I_water)
// is the linear-in-concentration quantity (Beer–Lambert) we calibrate against.
export function computeFrameMetrics(water, background) {
  const wB = water.b;
  const bgB = background.b;
  let transmittance = null;
  let absorbance = null;
  if (bgB > 0 && wB > 0) {
    transmittance = wB / bgB;               // 0..~1, blue transmitted fraction
    absorbance = Math.log10(bgB / wB);      // 0 = clear, higher = more colour
  }
  return {
    // water region (kept for display / legacy calibration / label)
    r: water.r, g: water.g, b: water.b,
    blueScore: water.blueScore,
    blueDominance: water.blueDominance,
    pixelCount: water.pixelCount,
    // background reference
    bgR: background.r, bgG: background.g, bgB: background.b,
    bgBlue: background.b,
    // exposure-immune metrics
    transmittance: transmittance !== null ? parseFloat(transmittance.toFixed(4)) : null,
    absorbance: absorbance !== null ? parseFloat(absorbance.toFixed(4)) : null,
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
