// Single source of truth for talking to an AQUA-BOX measurement device
// (ESP32-CAM today, TCS34725 later — everything is capability-driven via
// /status). No screen should call fetch() directly; everything goes through
// the functions exported here, so there is exactly one place that knows the
// base URL, the endpoint paths, and how to interpret a response.

export const DEFAULT_IP = '192.168.4.1';

// Bump this whenever the HTTP API's request/response SHAPE changes. Compared
// against the firmware's own api_version (from /ping or /status) on connect.
// v2: r_gain/b_gain in /status+/config, roi_p99 in /probe, POST /autotune,
//     GET /ledtest, /config validates and rejects out-of-range values (400).
export const EXPECTED_API_VERSION = 2;

// The one place every endpoint path is spelled out. If you add a route to
// the firmware, add it here — screens must not hardcode paths.
export const ENDPOINTS = {
  PING:     { method: 'GET',  path: '/ping' },
  STATUS:   { method: 'GET',  path: '/status' },
  PROBE:    { method: 'GET',  path: '/probe' },
  AUTOTUNE: { method: 'POST', path: '/autotune' },
  LEDTEST:  { method: 'GET',  path: '/ledtest' },
  THUMB:    { method: 'GET',  path: '/thumb.jpg' },
  CONFIG:   { method: 'POST', path: '/config' },
  BLANK:    { method: 'POST', path: '/blank' },
  MEASURE:  { method: 'POST', path: '/measure' },
};

// Mirrors the firmware's /config validation ranges (Bug 2) so the app can
// refuse to save before even sending the request; the server-side check in
// aqua_endpoints.cpp::hConfig is the authoritative backstop either way.
export const CONFIG_LIMITS = {
  aecValue: { min: 1, max: 1200 },
  agcGain:  { min: 0, max: 30 },
  rGain:    { min: 0.1, max: 8 },
  bGain:    { min: 0.1, max: 8 },
};

export const DEFAULT_CONFIG = { aec_value: 300, agc_gain: 2, r_gain: 1.0, b_gain: 1.0 };

function baseUrl(ip) {
  const host = (ip || DEFAULT_IP).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `http://${host}`;
}

// ─── Error taxonomy ───────────────────────────────────────────────────────────
// Exactly three kinds, matched to three distinct causes a user can act on:
//   'network'   — the request never reached the box (WiFi/routing problem)
//   'http'      — the box responded, but with a non-2xx status (route
//                 missing/mismatched → almost always a firmware/app version
//                 mismatch, NOT a connectivity problem — never call this
//                 "unreachable")
//   'gate'      — the box responded 200 OK, but its own measurement logic
//                 rejected the request (clipping, light leak, stale blank,
//                 no blank stored, etc. — the body carries {ok:false,error})
//   'cancelled' — the caller aborted the request (Cancel button)
export class ApiError extends Error {
  constructor(kind, message, meta = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    Object.assign(this, meta);
  }
}

export const NETWORK_ERROR_MESSAGE =
  "Can't reach box — check WiFi is AQUA-BOX, disable mobile data (or allow " +
  '"stay connected to Wi-Fi without internet"), then retry.';

// ─── Request log (ring buffer) for the debug panel ───────────────────────────
const REQUEST_LOG_MAX = 25;
let requestLog = [];
function logRequest(entry) {
  requestLog = [entry, ...requestLog].slice(0, REQUEST_LOG_MAX);
}
export function getRequestLog() { return requestLog; }
export function clearRequestLog() { requestLog = []; }

// Create an abortable handle a screen can pass as `signal` and later call
// `cancel()` on (used for the /measure Cancel button).
export function createCancelToken() {
  const controller = new AbortController();
  return { signal: controller.signal, cancel: (reason) => controller.abort(reason) };
}

// ─── Core request function ────────────────────────────────────────────────────
async function req(ip, path, { method = 'GET', body, timeoutMs = 8000, signal: externalSignal } = {}) {
  const url = baseUrl(ip) + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onExternalAbort = () => controller.abort('cancelled');
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort('cancelled');
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  const startedAt = Date.now();
  let status = null, bodyText = '', kind = null, ok = false;

  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      const wasCancelled = !!externalSignal?.aborted;
      kind = wasCancelled ? 'cancelled' : 'network';
      const message = wasCancelled ? 'Measurement cancelled.' : NETWORK_ERROR_MESSAGE;
      throw new ApiError(kind, message, { method, path, url });
    }

    status = res.status;
    bodyText = await res.text();

    if (!res.ok) {
      kind = 'http';
      throw new ApiError(
        'http',
        `Box firmware mismatch: ${method} ${path} returned ${res.status} — update firmware or app.`,
        { method, path, url, status }
      );
    }

    let parsed;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      kind = 'http';
      throw new ApiError(
        'http',
        `${method} ${path} returned invalid JSON — update firmware or app.`,
        { method, path, url, status }
      );
    }

    if (parsed && parsed.ok === false) {
      kind = 'gate';
      throw new ApiError('gate', parsed.error || 'Box rejected the request.', {
        method, path, url, status, body: parsed,
      });
    }

    ok = true;
    return parsed;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    logRequest({
      method, path, url, status, ok, kind,
      bodyPreview: bodyText.slice(0, 400),
      startedAt, rttMs: Date.now() - startedAt,
    });
  }
}

// ─── Endpoint functions ────────────────────────────────────────────────────────
export const ping       = (ip) => req(ip, ENDPOINTS.PING.path, { timeoutMs: 5000 });
export const getStatus  = (ip) => req(ip, ENDPOINTS.STATUS.path, { timeoutMs: 6000 });
export const getProbe   = (ip) => req(ip, ENDPOINTS.PROBE.path, { timeoutMs: 15000 });
export const postAutotune = (ip, opts = {}) => req(ip, ENDPOINTS.AUTOTUNE.path, { method: 'POST', timeoutMs: 30000, signal: opts.signal });
export const getLedTest = (ip) => req(ip, ENDPOINTS.LEDTEST.path, { timeoutMs: 15000 });
export const postConfig = (ip, cfg) => req(ip, ENDPOINTS.CONFIG.path, { method: 'POST', body: cfg, timeoutMs: 10000 });
export const postBlank  = (ip, opts = {}) => req(ip, ENDPOINTS.BLANK.path, { method: 'POST', timeoutMs: 60000, signal: opts.signal });
export const postMeasure = (ip, opts = {}) => req(ip, ENDPOINTS.MEASURE.path, { method: 'POST', timeoutMs: 60000, signal: opts.signal });

// Cache-busted thumbnail URL for <Image>. Not routed through req() since it's
// consumed directly by the Image component, not fetched as JSON.
export const thumbUrl = (ip) => `${baseUrl(ip)}${ENDPOINTS.THUMB.path}?t=${Date.now()}`;

// ─── Connect + verify ─────────────────────────────────────────────────────────
// Calls /ping first specifically so a stale-firmware box (missing routes)
// shows an explicit API-version mismatch instead of a mystery 404 on
// whichever endpoint the user happens to trigger next.
export async function connectAndVerify(ip) {
  let apiVersion = null;
  try {
    const p = await ping(ip);
    apiVersion = p?.api_version ?? null;
  } catch (e) {
    if (e.kind === 'network') throw e; // can't reach the box at all — bubble up
    // e.kind === 'http' (no /ping route, e.g. pre-API-version firmware) or
    // 'gate' — box is reachable but definitely running an old/different build.
    apiVersion = 0;
  }
  const status = await getStatus(ip);
  if (apiVersion === null) apiVersion = status?.api_version ?? null;
  return {
    status,
    apiVersion,
    apiVersionMatch: apiVersion === EXPECTED_API_VERSION,
  };
}

// ─── Result mapping ─────────────────────────────────────────────────────────
// Maps a /measure JSON response into the analysisData shape ResultScreen reads.
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
    blueScoreStdDev: m.absorbance_sigma,
    transmittance: null,
    bgBlue: raw.patch ? Math.round(raw.patch.b ?? 0) : null,
    refMismatch: null,
    frameCount: m.frames_kept ?? null,
    rejectedFrames: (m.frames_total ?? m.frames_kept ?? 0) - (m.frames_kept ?? 0),
    pixelCount: null,
    method: 'wifi-device',
    satFraction: (m.saturation_pct ?? 0) / 100,
    darkLevel: m.dark_level ?? null,
    blankAgeS: m.blank_age_s ?? null,
    warnings: m.warnings ?? [],
  };
}

// ─── Config validation (client-side mirror of the firmware's /config gate) ──
// Returns null if valid, or a human message naming the offending field if
// not — used to grey out Save and show the reason before a request is even
// sent (Bug 2: the box also rejects with 400 as the authoritative backstop).
export function validateConfigValues({ aec_value, agc_gain, r_gain, b_gain }) {
  const { aecValue, agcGain, rGain, bGain } = CONFIG_LIMITS;
  if (!Number.isFinite(aec_value) || aec_value < aecValue.min || aec_value > aecValue.max) {
    return `Exposure must be ${aecValue.min}-${aecValue.max} (got ${aec_value}).`;
  }
  if (!Number.isFinite(agc_gain) || agc_gain < agcGain.min || agc_gain > agcGain.max) {
    return `Gain must be ${agcGain.min}-${agcGain.max} (got ${agc_gain}).`;
  }
  if (!Number.isFinite(r_gain) || r_gain < rGain.min || r_gain > rGain.max) {
    return `Red WB gain must be ${rGain.min}-${rGain.max} (got ${r_gain}).`;
  }
  if (!Number.isFinite(b_gain) || b_gain < bGain.min || b_gain > bGain.max) {
    return `Blue WB gain must be ${bGain.min}-${bGain.max} (got ${b_gain}).`;
  }
  return null;
}
