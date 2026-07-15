import AsyncStorage from '@react-native-async-storage/async-storage';

// Which colour channel carries the hardness signal. For the EBT (Eriochrome
// Black T) wine-red Mg/Ca complex the absorption peak is in the GREEN band,
// so green is the default measurement channel — blue gives ~10× less signal.
// The channel is stored WITH the calibration and must be used identically at
// build time (Full Calibration) and measure time, or ppm is meaningless.

const CHANNEL_KEY = 'measurement_channel_v1';
export const DEFAULT_CHANNEL = 'green';

export const CHANNELS = [
  { key: 'green', label: 'Green', field: 'A_green', color: '#66BB6A' },
  { key: 'blue',  label: 'Blue',  field: 'A_blue',  color: '#42A5F5' },
  { key: 'red',   label: 'Red',   field: 'A_red',   color: '#EF5350' },
];

export function channelMeta(ch) {
  return CHANNELS.find((c) => c.key === ch) || CHANNELS[0];
}

// Pull the absorbance for a given channel out of a /measure response.
export function channelA(measureResp, ch) {
  const f = channelMeta(ch).field;
  const v = measureResp?.[f];
  return typeof v === 'number' ? v : null;
}

// Pull the per-channel absorbance out of a stored calibration point (which
// carries absR/absG/absB for recompute-without-remeasure).
export function pointA(point, ch) {
  if (ch === 'green') return point.absG ?? null;
  if (ch === 'red') return point.absR ?? null;
  return point.absB ?? null;
}

export async function loadChannel() {
  try {
    const v = await AsyncStorage.getItem(CHANNEL_KEY);
    return v === 'green' || v === 'blue' || v === 'red' ? v : DEFAULT_CHANNEL;
  } catch {
    return DEFAULT_CHANNEL;
  }
}

export async function saveChannel(ch) {
  await AsyncStorage.setItem(CHANNEL_KEY, ch).catch(() => {});
  return ch;
}
