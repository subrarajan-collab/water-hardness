// Generic hardness-curve math: ppm <-> absorbance mapping and qualitative
// labels. The pixel-analysis pipeline (frame capture, ROI/patch means,
// dark-subtraction, outlier rejection, absorbance calculation) lives entirely
// in the box firmware now — see firmware/aqua-box-esp32cam/aqua_measure.cpp.
// The app only ever receives a final {A_blue, A_red, A_green, ...} from
// POST /measure and maps it to ppm here.

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

// Maps an analysis result ({absorbance}) to a ppm value using the master
// calibration curve (piecewise-linear, extrapolated at the ends).
export function computeHardness(analysisResult, calibrationPoints = []) {
  if (calibrationPoints.length < 2) return null;

  const canAbs =
    typeof analysisResult?.absorbance === 'number' &&
    calibrationPoints.every((p) => typeof p.absorbance === 'number');
  if (canAbs) {
    return interpolatePPM(analysisResult.absorbance, calibrationPoints, 'absorbance');
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
