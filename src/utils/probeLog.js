import AsyncStorage from '@react-native-async-storage/async-storage';

// Small persisted ring buffer of probe readings so a dilution series can be
// captured on the bench without screenshots. Everything here is raw /probe
// data (ROI means + saturation) plus the settings in force at capture time.

const LOG_KEY = 'probe_log_v1';
const REF_KEY = 'probe_ref_v1';
const LOG_MAX = 60;

// A "settings signature" — the exposure/gain/WB values that affect what the
// sensor returns. If these differ between the stored reference and now, a
// raw-mean ratio A = log10(I_ref/I_now) is meaningless, so we compare
// signatures and invalidate the reference when they change.
export function settingsSignature(s) {
  if (!s) return null;
  return [s.aec_value, s.agc_gain, s.r_gain, s.b_gain].join('|');
}

// Build a normalized probe record from a raw /probe response + settings.
export function makeProbeRecord(probe, settings) {
  const roi = probe.roi || {};
  return {
    at: new Date().toISOString(),
    r: Number(roi.r) || 0,
    g: Number(roi.g) || 0,
    b: Number(roi.b) || 0,
    sat: Number(probe.roi_saturation_pct) || 0,
    sig: settingsSignature(settings),
    aec: settings?.aec_value ?? null,
    gain: settings?.agc_gain ?? null,
    rGain: settings?.r_gain ?? null,
    bGain: settings?.b_gain ?? null,
  };
}

export async function appendProbe(record) {
  const log = await loadProbeLog();
  const next = [record, ...log].slice(0, LOG_MAX);
  await AsyncStorage.setItem(LOG_KEY, JSON.stringify(next)).catch(() => {});
  return next;
}

export async function loadProbeLog() {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function clearProbeLog() {
  await AsyncStorage.removeItem(LOG_KEY).catch(() => {});
}

// ── Reference (quick-compare) ────────────────────────────────────────────────
export async function setReference(record) {
  await AsyncStorage.setItem(REF_KEY, JSON.stringify(record)).catch(() => {});
  return record;
}
export async function loadReference() {
  try {
    const raw = await AsyncStorage.getItem(REF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export async function clearReference() {
  await AsyncStorage.removeItem(REF_KEY).catch(() => {});
}

// Per-channel absorbance A = log10(I_ref / I_now) from raw ROI means.
// Guards: clamp intensities to >=1 to avoid log(0)/divide-by-zero; returns
// null per channel if either value is non-positive.
export function computeReferenceA(ref, now) {
  const a = (iref, inow) => {
    if (!(iref > 0) || !(inow > 0)) return null;
    return parseFloat(Math.log10(iref / inow).toFixed(4));
  };
  const A = { r: a(ref.r, now.r), g: a(ref.g, now.g), b: a(ref.b, now.b) };
  // largest-magnitude channel (deviation from 0 in either direction)
  let maxCh = null, maxAbs = -1;
  for (const ch of ['r', 'g', 'b']) {
    if (A[ch] === null) continue;
    if (Math.abs(A[ch]) > maxAbs) { maxAbs = Math.abs(A[ch]); maxCh = ch; }
  }
  return { A, maxCh };
}

// CSV for the recent-probes export.
export function probeLogToCsv(log) {
  const header = 'timestamp,R,G,B,sat_pct,aec_value,agc_gain,r_gain,b_gain';
  const rows = (log || []).map((p) =>
    [p.at, p.r.toFixed(2), p.g.toFixed(2), p.b.toFixed(2), p.sat.toFixed(2),
     p.aec ?? '', p.gain ?? '', p.rGain ?? '', p.bGain ?? ''].join(',')
  );
  return [header, ...rows].join('\n');
}
