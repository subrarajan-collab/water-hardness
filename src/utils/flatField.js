import AsyncStorage from '@react-native-async-storage/async-storage';

const BG_KEY = 'flatfield_background_v1';
export const BG_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
export const BRIDGE_WARN_FRACTION = 0.03;    // L/R disagree about exposure bridge

// background = { roi:{r,g,b}, patchL:{r,g,b}, patchR:{r,g,b},
//                capturedAt, layoutKey }
// layoutKey ties the capture to the Panel Setup geometry it was taken with —
// if the layout changes, the stored ROI pixels no longer match the screen ROI.
export function layoutKeyOf(layout) {
  return `${layout.patchOffsetFrac}|${layout.waterHeight}|${layout.waterCenterYFrac}`;
}

export async function saveBackground(bg) {
  const record = { ...bg, capturedAt: new Date().toISOString() };
  await AsyncStorage.setItem(BG_KEY, JSON.stringify(record));
  return record;
}

export async function loadBackground() {
  try {
    const raw = await AsyncStorage.getItem(BG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function clearBackground() {
  await AsyncStorage.removeItem(BG_KEY);
}

// Returns { usable, reason, ageMinutes } for the given layout.
export function backgroundStatus(bg, layout) {
  if (!bg) return { usable: false, reason: 'none' };
  const age = Date.now() - new Date(bg.capturedAt).getTime();
  const ageMinutes = Math.round(age / 60000);
  if (bg.layoutKey !== layoutKeyOf(layout)) {
    return { usable: false, reason: 'layout-changed', ageMinutes };
  }
  if (age > BG_MAX_AGE_MS) {
    return { usable: false, reason: 'stale', ageMinutes };
  }
  return { usable: true, reason: 'ok', ageMinutes };
}

// Per-channel median across capture frames for one region.
export function medianRegion(frames) {
  const med = (vals) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    r: med(frames.map((f) => f.r)),
    g: med(frames.map((f) => f.g)),
    b: med(frames.map((f) => f.b)),
  };
}
