import * as FileSystem from 'expo-file-system';
import jpeg from 'jpeg-js';

// Decodes a JPEG from a file URI and returns average RGB + derived metrics
export async function analyzeImageColors(uri) {
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
  const count = width * height;

  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    // data[i+3] is alpha — always 255 for JPEG, skip
  }

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

// Maps blue analysis to a ppm value using calibration points (linear interpolation)
export function computeHardness(analysisResult, calibrationPoints = []) {
  const { blueScore } = analysisResult;
  if (calibrationPoints.length < 2) return null;

  const sorted = [...calibrationPoints].sort((a, b) => a.blueScore - b.blueScore);

  if (blueScore <= sorted[0].blueScore) {
    const [p1, p2] = sorted;
    const slope = (p2.hardness - p1.hardness) / (p2.blueScore - p1.blueScore);
    return Math.max(0, Math.round(p1.hardness + slope * (blueScore - p1.blueScore)));
  }

  if (blueScore >= sorted[sorted.length - 1].blueScore) {
    const p1 = sorted[sorted.length - 2];
    const p2 = sorted[sorted.length - 1];
    const slope = (p2.hardness - p1.hardness) / (p2.blueScore - p1.blueScore);
    return Math.max(0, Math.round(p2.hardness + slope * (blueScore - p2.blueScore)));
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    if (blueScore >= sorted[i].blueScore && blueScore <= sorted[i + 1].blueScore) {
      const p1 = sorted[i];
      const p2 = sorted[i + 1];
      const t = (blueScore - p1.blueScore) / (p2.blueScore - p1.blueScore);
      return Math.max(0, Math.round(p1.hardness + t * (p2.hardness - p1.hardness)));
    }
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
