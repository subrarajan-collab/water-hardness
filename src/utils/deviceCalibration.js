import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { computeHardness } from './colorAnalysis';

const DEVICE_CAL_KEY = 'device_calibration_v1';

// ─── Sanity-guard limits ─────────────────────────────────────────────────────
export const BLANK_A_MIN = -0.1;   // blank absorbance must sit near zero
export const BLANK_A_MAX = 0.05;
export const MIN_REAGENT_DELTA = 0.05; // standard must differ from blank by this much
export const M_MIN = 0.5;          // device slope outside this range = setup problem
export const M_MAX = 2.0;
export const VALIDATION_TOLERANCE = 0.10; // ±10% of nominal standard ppm

export function getDeviceModel() {
  const c = Platform.constants || {};
  const brand = c.Brand || c.Manufacturer || '';
  const model = c.Model || '';
  const name = `${brand} ${model}`.trim();
  return name || `${Platform.OS} device`;
}

// A device key identifies which calibration factor applies. The phone camera
// is one device; each WiFi box (by box_id) is another. This lets the same
// per-device calibration model cover phones and boxes uniformly.
export function phoneDeviceKey() {
  return `phone:${getDeviceModel()}`;
}
export function boxDeviceKey(boxId) {
  return `box:${boxId}`;
}

// ─── Master curve ────────────────────────────────────────────────────────────
// The master curve is the existing calibration-point list, built once on the
// reference phone. Only points carrying absorbance participate.

// Stable content hash (djb2 over the normalised point list) so results can
// record WHICH curve produced them.
export function masterCurveHash(points) {
  const norm = (points || [])
    .filter((p) => typeof p.absorbance === 'number')
    .map((p) => `${p.absorbance.toFixed(4)}:${p.hardness}`)
    .sort()
    .join('|');
  let h = 5381;
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function exportMasterCurve(points) {
  const absPoints = (points || []).filter((p) => typeof p.absorbance === 'number');
  return JSON.stringify(
    {
      type: 'water-hardness-master-curve',
      version: 1,
      createdAt: new Date().toISOString(),
      hash: masterCurveHash(absPoints),
      points: absPoints.map((p) => ({
        absorbance: p.absorbance,
        hardness: p.hardness,
        label: p.label || '',
      })),
    },
    null,
    2
  );
}

// Parses + validates an exported curve. Returns { points } or throws.
export function parseMasterCurve(json) {
  const data = JSON.parse(json);
  if (data.type !== 'water-hardness-master-curve') {
    throw new Error('Not a master-curve file (wrong type field).');
  }
  if (!Array.isArray(data.points) || data.points.length < 2) {
    throw new Error('Curve must contain at least 2 points.');
  }
  const points = data.points.map((p, i) => {
    const a = Number(p.absorbance);
    const ppm = Number(p.hardness);
    if (!Number.isFinite(a) || !Number.isFinite(ppm) || ppm < 0) {
      throw new Error(`Point ${i + 1} is invalid.`);
    }
    return {
      id: `${Date.now()}_${i}`,
      absorbance: a,
      hardness: ppm,
      blueScore: null,
      label: p.label || 'imported',
      createdAt: new Date().toISOString(),
    };
  });
  return { points, hash: masterCurveHash(points) };
}

// Inverse lookup on the master curve: expected absorbance at a given ppm
// (piecewise-linear in ppm, extrapolated at the ends — mirror of computeHardness).
export function masterAbsorbanceAtPpm(ppm, points) {
  const pts = (points || [])
    .filter((p) => typeof p.absorbance === 'number')
    .sort((a, b) => a.hardness - b.hardness);
  if (pts.length < 2) return null;

  let p1, p2;
  if (ppm <= pts[0].hardness) {
    [p1, p2] = [pts[0], pts[1]];
  } else if (ppm >= pts[pts.length - 1].hardness) {
    [p1, p2] = [pts[pts.length - 2], pts[pts.length - 1]];
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      if (ppm >= pts[i].hardness && ppm <= pts[i + 1].hardness) {
        [p1, p2] = [pts[i], pts[i + 1]];
        break;
      }
    }
  }
  if (p2.hardness === p1.hardness) return null;
  const t = (ppm - p1.hardness) / (p2.hardness - p1.hardness);
  return p1.absorbance + t * (p2.absorbance - p1.absorbance);
}

// ─── Device factor ───────────────────────────────────────────────────────────
// Linear map between this phone's absorbance scale and the reference phone's:
//   A_device = m · A_master + c
// Fitted from two measurements: the reagent blank (0 ppm) and one standard.

export function fitDeviceFactor({ blankA, standardA, standardPpm, masterPoints }) {
  if (blankA < BLANK_A_MIN || blankA > BLANK_A_MAX) {
    return {
      error:
        `Blank absorbance ${blankA.toFixed(3)} is outside the expected range ` +
        `(${BLANK_A_MIN} to ${BLANK_A_MAX}). Check the blank sample and panel setup.`,
    };
  }
  if (Math.abs(standardA - blankA) < MIN_REAGENT_DELTA) {
    return {
      error:
        'No reagent response detected — the standard reads almost the same as the ' +
        'blank. Check chemistry (reagent added? correct standard?).',
    };
  }
  const aM0 = masterAbsorbanceAtPpm(0, masterPoints);
  const aM1 = masterAbsorbanceAtPpm(standardPpm, masterPoints);
  if (aM0 === null || aM1 === null || Math.abs(aM1 - aM0) < 1e-6) {
    return { error: 'No calibration to link to — run a full calibration or import one first.' };
  }
  const m = (standardA - blankA) / (aM1 - aM0);
  const c = blankA - m * aM0;
  if (m < M_MIN || m > M_MAX) {
    return {
      error:
        `Fitted slope m=${m.toFixed(2)} is outside ${M_MIN}–${M_MAX}. This indicates a ` +
        'setup problem (lighting, geometry, chemistry), not a device difference. ' +
        'Fix the rig and repeat.',
    };
  }
  return { m: parseFloat(m.toFixed(4)), c: parseFloat(c.toFixed(4)) };
}

// Device-aware ppm: invert the device map, then look up on the master curve.
// Falls back to the master curve directly when no device factor exists.
// Returns { ppm, deviceCalibrated } or null.
export function computeHardnessDeviceAware(analysis, masterPoints, deviceCal) {
  if (typeof analysis?.absorbance !== 'number') {
    const ppm = computeHardness(analysis, masterPoints);
    return ppm !== null ? { ppm, deviceCalibrated: false } : null;
  }
  const factorValid =
    deviceCal &&
    typeof deviceCal.m === 'number' &&
    typeof deviceCal.c === 'number' &&
    deviceCal.m >= M_MIN &&
    deviceCal.m <= M_MAX;

  const aMaster = factorValid
    ? (analysis.absorbance - deviceCal.c) / deviceCal.m
    : analysis.absorbance;

  const ppm = computeHardness({ ...analysis, absorbance: aMaster }, masterPoints);
  return ppm !== null ? { ppm, deviceCalibrated: !!factorValid } : null;
}

// ─── Device-factor persistence (keyed by device) ─────────────────────────────
// Stored as a map { [deviceKey]: record }. A legacy single record (pre-map,
// no deviceKey) is migrated to the phone key on first load.
async function loadCalMap() {
  try {
    const raw = await AsyncStorage.getItem(DEVICE_CAL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && (parsed.m !== undefined || parsed.c !== undefined)) {
      // legacy single record → migrate under the phone key
      const migrated = { [phoneDeviceKey()]: parsed };
      await AsyncStorage.setItem(DEVICE_CAL_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return parsed || {};
  } catch {
    return {};
  }
}

export async function loadDeviceCal(deviceKey) {
  const key = deviceKey || phoneDeviceKey();
  const map = await loadCalMap();
  return map[key] || null;
}

export async function saveDeviceCal(cal, deviceKey) {
  const key = deviceKey || phoneDeviceKey();
  const map = await loadCalMap();
  const record = {
    ...cal,
    deviceKey: key,
    deviceModel: cal.deviceModel || getDeviceModel(),
    fittedAt: cal.fittedAt || new Date().toISOString(),
  };
  map[key] = record;
  await AsyncStorage.setItem(DEVICE_CAL_KEY, JSON.stringify(map));
  return record;
}

export async function clearDeviceCal(deviceKey) {
  const key = deviceKey || phoneDeviceKey();
  const map = await loadCalMap();
  delete map[key];
  await AsyncStorage.setItem(DEVICE_CAL_KEY, JSON.stringify(map));
}

export async function listDeviceCals() {
  const map = await loadCalMap();
  return Object.values(map);
}
