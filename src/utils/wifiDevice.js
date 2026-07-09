// HTTP client for AQUA-BOX style measurement devices (ESP32-CAM now, TCS34725
// later). Device-agnostic: everything is driven by /status capabilities.

const DEFAULT_IP = '192.168.4.1';

function baseUrl(ip) {
  const host = (ip || DEFAULT_IP).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `http://${host}`;
}

async function req(ip, path, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl(ip) + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const WIFI_DEFAULT_IP = DEFAULT_IP;

export const getStatus  = (ip) => req(ip, '/status', { timeoutMs: 6000 });
export const getProbe   = (ip) => req(ip, '/probe', { timeoutMs: 15000 });
export const postConfig = (ip, cfg) => req(ip, '/config', { method: 'POST', body: cfg, timeoutMs: 10000 });
export const postBlank  = (ip) => req(ip, '/blank', { method: 'POST', timeoutMs: 60000 });
export const postMeasure = (ip) => req(ip, '/measure', { method: 'POST', timeoutMs: 60000 });

// Cache-busted thumbnail URL for <Image>
export const thumbUrl = (ip) => `${baseUrl(ip)}/thumb.jpg?t=${Date.now()}`;

// Human hint for the classic Android failure: phone keeps mobile data as the
// default route and never sends the request over the no-internet AP.
export const ANDROID_FETCH_HINT =
  "Couldn't reach the box. On Android, turn OFF mobile data (or enable " +
  '"stay connected to Wi-Fi without internet") so the phone routes to the ' +
  'AQUA-BOX network, then retry.';

// Map a /measure JSON response into the analysisData shape ResultScreen reads.
export function measureToAnalysis(m) {
  const raw = m.raw || {};
  const roi = raw.roi || {};
  const r = Math.round(roi.r ?? 0), g = Math.round(roi.g ?? 0), b = Math.round(roi.b ?? 0);
  const total = r + g + b;
  return {
    r, g, b,
    blueScore: b,
    blueDominance: total > 0 ? parseFloat(((b / total) * 100).toFixed(1)) : 0,
    absorbance: m.A_blue,
    absorbanceR: m.A_red,
    absorbanceG: m.A_green,
    absorbanceStdDev: m.absorbance_sigma,
    blueScoreStdDev: m.absorbance_sigma, // reuse the stability slot
    transmittance: null,
    bgBlue: raw.patch ? Math.round(raw.patch.b ?? 0) : null,
    refMismatch: null,
    frameCount: m.frames_kept ?? null,
    rejectedFrames: (m.frames_total ?? m.frames_kept ?? 0) - (m.frames_kept ?? 0),
    pixelCount: null,
    method: 'wifi-device',
    // device diagnostics carried into history metadata
    satFraction: (m.saturation_pct ?? 0) / 100,
    darkLevel: m.dark_level ?? null,
    blankAgeS: m.blank_age_s ?? null,
    warnings: m.warnings ?? [],
  };
}
