import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { postMeasure, postBlank, createCancelToken } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import { computeHardness } from '../utils/colorAnalysis';
import { masterCurveHash, saveDeviceCal } from '../utils/deviceCalibration';
import {
  CAL_STANDARDS_PPM, CAL_REPETITIONS, CAL_SIGMA_WARN, FULL_CAL_VALIDATION_TOL,
  checkCurveMonotonic, dilutionForPpm, validateStandardsList,
} from '../utils/readiness';
import { CHANNELS, channelMeta, channelA, saveChannel, DEFAULT_CHANNEL } from '../utils/channelPref';
import { settingsSignature } from '../utils/probeLog';
import MeasureProgress from '../components/MeasureProgress';
import CurvePlot from '../components/CurvePlot';

const CALIBRATION_KEY = 'calibration_points';
const RUN_KEY = 'full_cal_run_v1'; // persist the in-progress run so it survives leaving the screen

// Guided full calibration with an editable standards list and per-standard
// re-measure. The 0 ppm blank is always the reference; all standards must be
// measured at the SAME exposure/gain/WB as that reference.
export default function FullCalibrationScreen({ navigation }) {
  const { ip, connected, status, boxId, deviceKey, refresh } = useBoxConnection();

  const [phase, setPhase] = useState('intro'); // intro | run | validate | done
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [concList, setConcList] = useState(CAL_STANDARDS_PPM);
  const [newConc, setNewConc] = useState('');
  // measured: { [ppmString]: { repsR, repsG, repsB, rawR, rawG, rawB, at, sig } }
  const [measured, setMeasured] = useState({});
  const [refSig, setRefSig] = useState(null);  // exposure signature when 0 ppm captured
  const [refAt, setRefAt] = useState(null);
  const [progress, setProgress] = useState(null);
  const [validation, setValidation] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const currentSig = settingsSignature(status?.settings);
  const exposureOk = refSig !== null && currentSig === refSig;
  const sortedConc = [...concList].sort((a, b) => a - b);

  // ── Persistence ──────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(RUN_KEY);
        if (raw) {
          const r = JSON.parse(raw);
          if (Array.isArray(r.concList)) setConcList(r.concList);
          if (r.measured) setMeasured(r.measured);
          if (r.channel) setChannel(r.channel);
          setRefSig(r.refSig ?? null);
          setRefAt(r.refAt ?? null);
          if (r.measured && Object.keys(r.measured).length > 0) setPhase('run');
        }
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (patch) => {
    const snapshot = { concList, measured, channel, refSig, refAt, ...patch };
    await AsyncStorage.setItem(RUN_KEY, JSON.stringify(snapshot)).catch(() => {});
  }, [concList, measured, channel, refSig, refAt]);

  useEffect(() => { refresh(); }, []); // pull latest box settings on entry

  // ── Per-channel stats + curve ────────────────────────────────────────────
  const chanStats = (entry, ch) => {
    const reps = ch === 'red' ? entry.repsR : ch === 'blue' ? entry.repsB : entry.repsG;
    if (!reps || reps.length === 0) return { mean: 0, sigma: 0 };
    const mean = reps.reduce((s, v) => s + v, 0) / reps.length;
    const sigma = Math.sqrt(reps.reduce((s, v) => s + (v - mean) ** 2, 0) / reps.length);
    return { mean: parseFloat(mean.toFixed(4)), sigma: parseFloat(sigma.toFixed(4)) };
  };

  const measuredPpms = Object.keys(measured).map(Number);
  const points = measuredPpms
    .map((ppm) => ({ absorbance: chanStats(measured[String(ppm)], channel).mean, hardness: ppm }))
    .sort((a, b) => a.hardness - b.hardness);
  const mono = checkCurveMonotonic(points);
  const reversalSet = new Set(mono.ok ? [] : (mono.reversal || []));
  const allMeasured = sortedConc.every((ppm) => measured[String(ppm)]);
  const canValidate = allMeasured && points.length >= 2 && mono.ok;

  const failAlert = (e) => {
    const msg = e.kind === 'gate' ? e.message
      : e.kind === 'http' ? 'Update the box firmware (or the app) so both match, then try again.'
      : e.kind === 'cancelled' ? null
      : 'Check the phone is on the AQUA-BOX WiFi and mobile data is off, then try again.';
    if (msg) Alert.alert('Measurement stopped', msg);
  };

  // ── Standards list editing ───────────────────────────────────────────────
  const addConc = () => {
    const v = parseFloat(newConc);
    const next = validateStandardsList([...concList, v]);
    if (!next.ok) { Alert.alert('Invalid concentration', next.error); return; }
    setConcList(next.sorted);
    setNewConc('');
    persist({ concList: next.sorted });
  };
  const removeConc = (ppm) => {
    if (ppm === 0) { Alert.alert('Cannot remove', 'The 0 ppm blank is the reference and must stay.'); return; }
    const next = concList.filter((c) => c !== ppm);
    setConcList(next);
    const m = { ...measured }; delete m[String(ppm)];
    setMeasured(m);
    persist({ concList: next, measured: m });
  };

  // ── Reference (0 ppm) capture — establishes the box blank + exposure sig ──
  const captureReference = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Capturing reference (0 ppm)…', token });
    try {
      await postBlank(ip, { signal: token.signal });
      await refresh();
    } catch (e) { setProgress(null); failAlert(e); return; }
    // measure the 0 ppm as a standard (A ≈ 0) to anchor the curve + get raw
    const entry = await runReps(0, token);
    setProgress(null);
    if (!entry) return;
    const sig = settingsSignature(status?.settings);
    const at = new Date().toISOString();
    const m = { ...measured, '0': { ...entry, sig, at } };
    setMeasured(m); setRefSig(sig); setRefAt(at);
    persist({ measured: m, refSig: sig, refAt: at });
    if (phase === 'intro') setPhase('run');
  };

  // Run CAL_REPETITIONS measurements, capturing all channels + raw ROI.
  const runReps = async (ppm, token) => {
    const repsR = [], repsG = [], repsB = [], rawR = [], rawG = [], rawB = [];
    try {
      for (let i = 0; i < CAL_REPETITIONS; i++) {
        setProgress({ label: `${ppm} ppm — run ${i + 1} of ${CAL_REPETITIONS}…`, token });
        const m = await postMeasure(ip, { signal: token.signal });
        if (typeof channelA(m, channel) !== 'number') throw Object.assign(new Error('Box did not return a reading.'), { kind: 'gate' });
        repsR.push(m.A_red); repsG.push(m.A_green); repsB.push(m.A_blue);
        const roi = m.raw?.roi || {};
        rawR.push(roi.r ?? 0); rawG.push(roi.g ?? 0); rawB.push(roi.b ?? 0);
      }
    } catch (e) { failAlert(e); return null; }
    const mean = (a) => parseFloat((a.reduce((s, v) => s + v, 0) / a.length).toFixed(2));
    return { repsR, repsG, repsB, rawR: mean(rawR), rawG: mean(rawG), rawB: mean(rawB) };
  };

  // ── Measure / re-measure one standard ────────────────────────────────────
  const measureStandard = async (ppm) => {
    if (ppm === 0) return captureReference();
    if (!exposureOk) {
      Alert.alert(
        'Reference invalid — re-reference',
        'The exposure/gain/white-balance changed since the 0 ppm reference was captured. ' +
        'Re-capture the 0 ppm reference before measuring standards, so all points share one exposure.'
      );
      return;
    }
    const token = createCancelToken();
    const entry = await runReps(ppm, token);
    setProgress(null);
    if (!entry) return;
    const sig = currentSig;
    const at = new Date().toISOString();
    const stat = chanStats(entry, channel);

    const commit = () => {
      const m = { ...measured, [String(ppm)]: { ...entry, sig, at } };
      setMeasured(m);
      persist({ measured: m });
    };
    if (stat.sigma > CAL_SIGMA_WARN) {
      Alert.alert(
        'Readings scattered',
        `The ${CAL_REPETITIONS} runs of ${ppm} ppm disagree more than expected (σ = ${stat.sigma}). ` +
        'Check the sample is mixed and the box was not moved, then re-measure — or keep this average.',
        [{ text: 'Discard', style: 'cancel' }, { text: 'Keep', onPress: commit }]
      );
    } else {
      commit();
    }
  };

  // ── Validation ───────────────────────────────────────────────────────────
  const VALIDATE_PPM = sortedConc.includes(150) ? 150 : sortedConc[Math.floor(sortedConc.length / 2)];
  const runValidation = async () => {
    const token = createCancelToken();
    setProgress({ label: `Checking against the ${VALIDATE_PPM} ppm standard…`, token });
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      const ppm = computeHardness({ absorbance: channelA(m, channel) }, points.map((p, i) => ({ ...p, id: String(i) })));
      const pass = ppm !== null && Math.abs(ppm - VALIDATE_PPM) <= FULL_CAL_VALIDATION_TOL * VALIDATE_PPM;
      setValidation({ nominal: VALIDATE_PPM, measuredPpm: ppm, pass });
      if (!pass) {
        Alert.alert('Validation failed',
          `The curve read ${ppm ?? '—'} ppm for the ${VALIDATE_PPM} ppm standard (allowed ±${FULL_CAL_VALIDATION_TOL * 100}%). ` +
          'Re-run, or go back and re-measure the flagged standard.');
      }
    } catch (e) { failAlert(e); } finally { setProgress(null); }
  };

  // ── Save + auto-link ─────────────────────────────────────────────────────
  const saveAll = async () => {
    const now = new Date().toISOString();
    const pts = sortedConc.map((ppm, i) => {
      const e = measured[String(ppm)];
      const r = chanStats(e, 'red').mean, g = chanStats(e, 'green').mean, b = chanStats(e, 'blue').mean;
      const active = channel === 'red' ? r : channel === 'blue' ? b : g;
      return {
        id: `${Date.now()}_${i}`,
        absorbance: active, absR: r, absG: g, absB: b,
        rawR: e.rawR, rawG: e.rawG, rawB: e.rawB,
        sigma: chanStats(e, channel).sigma,
        exposureSig: e.sig, measuredAt: e.at,
        hardness: ppm, blueScore: null,
        label: `full calibration ${channel}`,
        createdAt: now,
      };
    });
    await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(pts));
    await saveChannel(channel);
    await AsyncStorage.removeItem(RUN_KEY).catch(() => {});

    const activeMean = (ppm) => chanStats(measured[String(ppm)], channel).mean;
    if (deviceKey) {
      await saveDeviceCal({
        m: 1.0, c: 0.0, channel,
        standardPpm: validation?.nominal ?? VALIDATE_PPM,
        blankA: measured['0'] ? activeMean(0) : 0,
        standardA: measured[String(VALIDATE_PPM)] ? activeMean(VALIDATE_PPM) : null,
        masterHash: masterCurveHash(pts), deviceModel: boxId || 'box',
        validated: true,
        validation: { nominalPpm: validation?.nominal ?? VALIDATE_PPM, measuredPpm: validation?.measuredPpm ?? null, pass: true, at: now },
      }, deviceKey);
    }
    setPhase('done');
  };

  const restart = () => {
    Alert.alert('Start over?', 'Discard all measured standards and begin a new calibration?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start over', style: 'destructive', onPress: async () => {
        setMeasured({}); setRefSig(null); setRefAt(null); setValidation(null); setPhase('intro');
        await AsyncStorage.removeItem(RUN_KEY).catch(() => {});
      } },
    ]);
  };

  if (!connected) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerTitle}>No box connected</Text>
        <Text style={styles.centerText}>Connect to a box in the Setup tab first.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── INTRO: prep + editable list + channel ── */}
      {phase === 'intro' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Standards</Text>
            <Text style={styles.body}>
              Prepare each standard (reagent added) from a 1000 ppm CaCO₃ stock, per 100 mL topped up
              with distilled water. Edit the list for your dilution series — the 0 ppm blank is required.
            </Text>
            <View style={styles.table}>
              <View style={styles.tr}>
                <Text style={[styles.th, { flex: 1 }]}>Standard</Text>
                <Text style={[styles.th, { flex: 1 }]}>Stock</Text>
                <Text style={[styles.th, { flex: 1.2 }]}>Water</Text>
                <Text style={[styles.th, { width: 34 }]}> </Text>
              </View>
              {sortedConc.map((ppm) => {
                const d = dilutionForPpm(ppm);
                return (
                  <View key={ppm} style={styles.tr}>
                    <Text style={[styles.td, { flex: 1 }]}>{ppm} ppm{ppm === 0 ? ' (ref)' : ''}</Text>
                    <Text style={[styles.td, { flex: 1 }]}>{d.stockMl} mL</Text>
                    <Text style={[styles.td, { flex: 1.2 }]}>{d.waterMl} mL</Text>
                    {ppm !== 0 ? (
                      <TouchableOpacity style={{ width: 34, alignItems: 'center' }} onPress={() => removeConc(ppm)}>
                        <Text style={styles.rmX}>✕</Text>
                      </TouchableOpacity>
                    ) : <View style={{ width: 34 }} />}
                  </View>
                );
              })}
            </View>
            <View style={styles.addRow}>
              <TextInput
                style={styles.addInput}
                value={newConc}
                onChangeText={setNewConc}
                keyboardType="numeric"
                placeholder="Add ppm (e.g. 200)"
                placeholderTextColor="#90A4AE"
              />
              <TouchableOpacity style={styles.addBtn} onPress={addConc}>
                <Text style={styles.addBtnText}>+ Add</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Measurement colour</Text>
            <Text style={styles.body}>
              Green is recommended for the standard Eriochrome Black T (EBT) reagent — its
              wine-red complex absorbs strongest in green. Change only if your reagent differs.
            </Text>
            <View style={styles.chanRow}>
              {CHANNELS.map((c) => (
                <TouchableOpacity
                  key={c.key}
                  style={[styles.chanBtn, channel === c.key && { backgroundColor: c.color, borderColor: c.color }]}
                  onPress={() => { setChannel(c.key); persist({ channel: c.key }); }}
                >
                  <Text style={[styles.chanBtnText, channel === c.key && { color: '#FFF' }]}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => setPhase('run')}>
            <Text style={styles.primaryBtnText}>Start calibration →</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>You can leave and return — measured standards are kept.</Text>
        </>
      )}

      {/* ── RUN: reference + per-standard rows + curve + consistency ── */}
      {phase === 'run' && (
        <>
          {/* exposure guard */}
          {refSig !== null && !exposureOk && (
            <View style={styles.warnChip}>
              <Text style={styles.warnChipText}>
                ⚠ Exposure changed since the reference — re-reference. Standards are blocked until the
                0 ppm reference is re-captured so every point shares one exposure.
              </Text>
            </View>
          )}

          <Text style={styles.progressText}>
            {Object.keys(measured).length} of {sortedConc.length} measured
            {refSig !== null ? '' : ' · capture the 0 ppm reference first'}
          </Text>

          {/* standards list */}
          {sortedConc.map((ppm) => {
            const e = measured[String(ppm)];
            const isRef = ppm === 0;
            const stat = e ? chanStats(e, channel) : null;
            const outOfTrend = reversalSet.has(ppm);
            const expMismatch = e && refSig && e.sig !== refSig;
            return (
              <View key={ppm} style={[styles.stdRow, outOfTrend && styles.stdRowFlag]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stdPpm}>
                    {ppm} ppm{isRef ? ' · reference' : ''}
                    {outOfTrend ? '  ⚠ out of trend' : ''}
                  </Text>
                  {e ? (
                    <Text style={styles.stdMeta}>
                      A {stat.mean} (σ {stat.sigma}) · {new Date(e.at).toLocaleTimeString()}
                      {expMismatch ? '  ⚠ different exposure' : ''}
                    </Text>
                  ) : (
                    <Text style={styles.stdMetaPending}>not measured</Text>
                  )}
                </View>
                <TouchableOpacity
                  style={[styles.stdBtn, e && styles.stdBtnRe, (!isRef && !exposureOk) && styles.btnDisabled]}
                  onPress={() => measureStandard(ppm)}
                  disabled={!isRef && !exposureOk}
                >
                  <Text style={styles.stdBtnText}>
                    {isRef ? (e ? 'Re-capture' : 'Capture') : (e ? 'Re-measure' : 'Measure')}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })}

          {/* curve + consistency */}
          {points.length >= 2 && (
            <View style={[styles.card, { marginTop: 16 }]}>
              <Text style={styles.title}>Curve · {channelMeta(channel).label}</Text>
              <CurvePlot points={points.map((p, i) => ({ ...p, id: String(i) }))} />
              {mono.ok ? (
                <Text style={styles.okNote}>✓ Consistent — all segments move the same way.</Text>
              ) : (
                <Text style={styles.failNote}>
                  ⚠ Reversal between {mono.reversal?.[0]} and {mono.reversal?.[1]} ppm — re-measure the
                  flagged standard(s) above.
                </Text>
              )}
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryBtn, !canValidate && styles.btnDisabled]}
            onPress={() => setPhase('validate')}
            disabled={!canValidate}
          >
            <Text style={styles.primaryBtnText}>Continue to validation</Text>
          </TouchableOpacity>
          {!canValidate && (
            <Text style={styles.hint}>
              {!allMeasured ? 'Measure all standards' : 'Consistency check must pass'} to continue.
            </Text>
          )}
          <TouchableOpacity style={styles.linkBtn} onPress={restart}>
            <Text style={styles.linkBtnText}>↺ Start over</Text>
          </TouchableOpacity>
        </>
      )}

      {/* ── VALIDATE ── */}
      {phase === 'validate' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Validation (required)</Text>
            <Text style={styles.body}>
              Put the {VALIDATE_PPM} ppm standard back into the box. It's measured as an unknown — the
              new calibration must read it within ±{FULL_CAL_VALIDATION_TOL * 100}%.
            </Text>
            {validation && (
              <Text style={validation.pass ? styles.okNote : styles.failNote}>
                {validation.pass
                  ? `✓ Passed — read ${validation.measuredPpm} ppm (target ${validation.nominal} ppm)`
                  : `✗ Failed — read ${validation.measuredPpm ?? '—'} ppm (target ${validation.nominal} ppm)`}
              </Text>
            )}
          </View>
          {!validation?.pass && (
            <TouchableOpacity style={styles.primaryBtn} onPress={runValidation}>
              <Text style={styles.primaryBtnText}>📡 Run validation</Text>
            </TouchableOpacity>
          )}
          {validation?.pass && (
            <TouchableOpacity style={styles.saveBtn} onPress={saveAll}>
              <Text style={styles.primaryBtnText}>💾 Save calibration & link this box</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.linkBtn} onPress={() => setPhase('run')}>
            <Text style={styles.linkBtnText}>← Back to standards</Text>
          </TouchableOpacity>
        </>
      )}

      {/* ── DONE ── */}
      {phase === 'done' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>✓ Calibration complete</Text>
            <Text style={styles.body}>
              Saved and this box is linked. Measure samples now — or share this calibration from
              Calibration → Advanced → Export.
            </Text>
          </View>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('CalibrationHome')}>
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </>
      )}

      <MeasureProgress visible={!!progress} label={progress?.label} onCancel={() => progress?.token.cancel()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, backgroundColor: '#E3F2FD', justifyContent: 'center', alignItems: 'center', padding: 30 },
  centerTitle: { fontSize: 17, fontWeight: 'bold', color: '#546E7A', marginBottom: 6 },
  centerText: { fontSize: 13, color: '#78909C', textAlign: 'center' },

  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 14, elevation: 2 },
  title: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 10 },
  body: { color: '#37474F', fontSize: 13, lineHeight: 20, marginBottom: 8 },
  hint: { color: '#78909C', fontSize: 12, textAlign: 'center', marginTop: 8 },
  okNote: { color: '#2E7D32', fontSize: 13, fontWeight: '600', marginTop: 10 },
  failNote: { color: '#C62828', fontSize: 13, fontWeight: '600', marginTop: 10, lineHeight: 19 },

  table: { marginVertical: 10, borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#F0F0F0', paddingVertical: 6, paddingHorizontal: 10 },
  th: { fontWeight: 'bold', color: '#1565C0', fontSize: 12 },
  td: { color: '#37474F', fontSize: 12 },
  rmX: { color: '#EF5350', fontSize: 14, fontWeight: 'bold' },
  addRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  addInput: { flex: 1, backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0' },
  addBtn: { backgroundColor: '#1565C0', borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
  addBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  chanRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  chanBtn: { flex: 1, borderWidth: 1.5, borderColor: '#CFD8DC', borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  chanBtnText: { color: '#546E7A', fontWeight: '700', fontSize: 14 },

  progressText: { color: '#546E7A', fontSize: 13, fontWeight: '600', marginBottom: 12, textAlign: 'center' },

  stdRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 8, elevation: 1, borderWidth: 2, borderColor: 'transparent' },
  stdRowFlag: { borderColor: '#EF6C00', backgroundColor: '#FFF8F2' },
  stdPpm: { fontSize: 14, fontWeight: 'bold', color: '#1A237E' },
  stdMeta: { color: '#546E7A', fontSize: 12, marginTop: 2 },
  stdMetaPending: { color: '#90A4AE', fontSize: 12, marginTop: 2, fontStyle: 'italic' },
  stdBtn: { backgroundColor: '#1565C0', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
  stdBtnRe: { backgroundColor: '#6A1B9A' },
  stdBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
  btnDisabled: { backgroundColor: '#B0BEC5' },

  warnChip: { backgroundColor: '#FFF3E0', borderRadius: 10, padding: 12, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: '#EF6C00' },
  warnChipText: { color: '#E65100', fontSize: 12, fontWeight: '600', lineHeight: 18 },

  primaryBtn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  primaryBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  linkBtn: { alignItems: 'center', paddingVertical: 12 },
  linkBtnText: { color: '#546E7A', fontSize: 13 },
});
