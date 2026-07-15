// Central readiness model — the single derived answer to "can this rig
// produce a trustworthy ppm reading right now?". Everything the Measurement
// tab's checklist card shows, and everything onboarding tracks, comes from
// here so the two can never disagree.

export const BLANK_MAX_AGE_S = 24 * 3600;

export function blankAgeText(s) {
  if (s === null || s === undefined || s < 0) return 'not captured yet';
  if (s < 90) return `${Math.round(s)} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  const h = s / 3600;
  if (h < 48) return `${h.toFixed(1)} hours ago`;
  return `${(h / 24).toFixed(1)} days ago`;
}

// items: ordered checklist. Each item: { id, ok, title, detail, fixLabel }
// The caller maps id → navigation/action; this module stays pure.
export function computeReadiness({ connected, blankAgeS, masterPoints, deviceCal }) {
  const items = [];

  items.push({
    id: 'connect',
    ok: !!connected,
    title: 'Box connected',
    detail: connected ? 'Connected' : 'Not connected to a measurement box',
    fixLabel: connected ? null : 'Connect',
  });

  const blankFresh =
    typeof blankAgeS === 'number' && blankAgeS >= 0 && blankAgeS <= BLANK_MAX_AGE_S;
  items.push({
    id: 'blank',
    ok: blankFresh,
    title: 'Reference water (0 ppm)',
    detail: blankFresh
      ? `Captured ${blankAgeText(blankAgeS)}`
      : blankAgeS === null || blankAgeS === undefined || blankAgeS < 0
        ? 'No reference water captured on this box'
        : `Reference water is ${blankAgeText(blankAgeS)} — capture a new one`,
    fixLabel: blankFresh ? null : 'Capture now',
  });

  const absPoints = (masterPoints || []).filter((p) => typeof p.absorbance === 'number');
  const calibrationValid = absPoints.length >= 2;
  items.push({
    id: 'calibration',
    ok: calibrationValid,
    title: 'Calibration',
    detail: calibrationValid
      ? `${absPoints.length} standards`
      : 'No calibration yet — run a full calibration or import one',
    fixLabel: calibrationValid ? null : 'Calibrate',
  });

  const linked = !!(deviceCal && deviceCal.validated);
  items.push({
    id: 'link',
    ok: linked,
    title: 'Box linked to calibration',
    detail: linked
      ? `Linked${deviceCal.fittedAt ? ' ' + new Date(deviceCal.fittedAt).toLocaleDateString() : ''}`
      : calibrationValid
        ? 'This box is not linked to the calibration yet'
        : 'Link after calibrating',
    fixLabel: linked ? null : 'Link box',
  });

  return {
    items,
    ready: items.every((i) => i.ok),
    canMeasure: !!connected, // measuring is allowed uncalibrated (absorbance-only)
    ppmAvailable: calibrationValid,
  };
}

// ── Hardness classification (mg/L CaCO3) — drinking-water convention ────────
export function classifyHardness(ppm) {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return null;
  if (ppm < 60) return { label: 'Soft', color: '#0288D1', range: '< 60 mg/L' };
  if (ppm < 120) return { label: 'Moderately hard', color: '#7B1FA2', range: '60–120 mg/L' };
  if (ppm < 180) return { label: 'Hard', color: '#EF6C00', range: '120–180 mg/L' };
  return { label: 'Very hard', color: '#C62828', range: '> 180 mg/L' };
}

// ── Curve sanity: absorbance must move in ONE direction as ppm rises ────────
// A reversal means at least one standard was mis-prepared or mis-measured;
// interpolating across it would silently give wrong ppm, so save is blocked.
export function checkCurveMonotonic(points) {
  const pts = (points || [])
    .filter((p) => typeof p.absorbance === 'number')
    .sort((a, b) => a.hardness - b.hardness);
  if (pts.length < 2) return { ok: false, reason: 'need at least 2 points' };
  let dir = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].absorbance - pts[i - 1].absorbance;
    const s = Math.sign(d);
    if (s === 0) return { ok: false, reversal: [pts[i - 1].hardness, pts[i].hardness] };
    if (dir === 0) dir = s;
    else if (s !== dir) return { ok: false, reversal: [pts[i - 1].hardness, pts[i].hardness] };
  }
  return { ok: true, direction: dir };
}

// ── Full-calibration wizard constants ────────────────────────────────────────
export const CAL_STANDARDS_PPM = [0, 50, 100, 150, 250, 400];
export const CAL_REPETITIONS = 3;
export const CAL_SIGMA_WARN = 0.02;          // σ across the 3 reps above this → offer re-run
export const FULL_CAL_VALIDATION_TOL = 0.15; // ±15% on the wizard's validation run

// Dilution recipe for one standard: mL of 1000 ppm stock per 100 mL final
// volume (topped up with distilled water).
export function dilutionForPpm(ppm) {
  return { ppm, stockMl: parseFloat((ppm / 10).toFixed(2)), waterMl: parseFloat((100 - ppm / 10).toFixed(2)) };
}
export function dilutionRows(list = CAL_STANDARDS_PPM) {
  return [...list].sort((a, b) => a - b).map(dilutionForPpm);
}

// Validate a user-edited standards list. Rules: all numbers ≥ 0, a 0 ppm
// blank must be present (it's the reference), no duplicates, at least 3
// points total (2 standards + blank) for a usable curve.
export function validateStandardsList(list) {
  const nums = (list || []).map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
    return { ok: false, error: 'Concentrations must be numbers ≥ 0.' };
  }
  if (!nums.includes(0)) {
    return { ok: false, error: 'A 0 ppm blank must be included — it is the reference.' };
  }
  if (new Set(nums).size !== nums.length) {
    return { ok: false, error: 'Duplicate concentrations are not allowed.' };
  }
  if (nums.length < 3) {
    return { ok: false, error: 'Add at least 2 standards plus the 0 ppm blank.' };
  }
  return { ok: true, sorted: [...nums].sort((a, b) => a - b) };
}
