import AsyncStorage from '@react-native-async-storage/async-storage';

const LAYOUT_KEY = 'panel_layout_v1';

// Bottle-mode capture geometry, as fractions of screen size where possible so
// the same config survives across screen resolutions.
//
// patchOffsetFrac: reference-patch centres sit at ±(frac × screen width) from
//   centre. Default 0.19 — the lit panel covers only the central ~45% of the
//   frame at the current rig geometry, and the bottle occupies ~±8%.
// waterHeight: water-ROI height in px. Covers ONLY the smooth cylindrical
//   section of the bottle — excludes the moulded bottom dome and the bright
//   band below the bottle.
// waterCenterYFrac: vertical centre of the water ROI (and the patches — the
//   patches always sit at the SAME height so the panel's vertical gradient
//   cancels in the L/R average).
export const DEFAULT_LAYOUT = {
  patchOffsetFrac: 0.19,
  waterHeight: 170,
  waterCenterYFrac: 0.46,
};

export async function loadLayout() {
  try {
    const raw = await AsyncStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_LAYOUT, ...parsed };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export async function saveLayout(layout) {
  const merged = { ...DEFAULT_LAYOUT, ...layout, savedAt: new Date().toISOString() };
  await AsyncStorage.setItem(LAYOUT_KEY, JSON.stringify(merged));
  return merged;
}

export async function resetLayout() {
  await AsyncStorage.removeItem(LAYOUT_KEY);
  return { ...DEFAULT_LAYOUT };
}
