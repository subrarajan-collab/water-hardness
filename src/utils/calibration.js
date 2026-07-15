import AsyncStorage from '@react-native-async-storage/async-storage';

const CALIBRATION_KEY = 'calibration_points';
const HISTORY_KEY = 'test_history';

export async function saveCalibrationPoint(blueScore, hardnessPPM, label = '', absorbance = null, channels = null) {
  const existing = await loadCalibrationPoints();
  const point = {
    id: Date.now().toString(),
    blueScore,
    absorbance,          // active-channel value used for ppm interpolation
    // Per-channel absorbances so the curve can be recomputed onto another
    // channel later without re-measuring (channels = {r, g, b}).
    absR: channels?.r ?? null,
    absG: channels?.g ?? null,
    absB: channels?.b ?? (channels ? null : absorbance),
    hardness: hardnessPPM,
    label,
    createdAt: new Date().toISOString(),
  };
  const updated = [...existing, point];
  await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(updated));
  return updated;
}

export async function loadCalibrationPoints() {
  try {
    const raw = await AsyncStorage.getItem(CALIBRATION_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function deleteCalibrationPoint(id) {
  const existing = await loadCalibrationPoints();
  const updated = existing.filter((p) => p.id !== id);
  await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(updated));
  return updated;
}

export async function clearCalibration() {
  await AsyncStorage.removeItem(CALIBRATION_KEY);
}

export async function saveTestResult(result) {
  const existing = await loadHistory();
  const entry = {
    id: Date.now().toString(),
    ...result,
    testedAt: new Date().toISOString(),
  };
  const updated = [entry, ...existing].slice(0, 100); // keep last 100
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  return entry;
}

export async function loadHistory() {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function clearHistory() {
  await AsyncStorage.removeItem(HISTORY_KEY);
}
