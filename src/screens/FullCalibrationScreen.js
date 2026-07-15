import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { postMeasure, postBlank, createCancelToken } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import { computeHardness } from '../utils/colorAnalysis';
import { masterCurveHash, saveDeviceCal } from '../utils/deviceCalibration';
import {
  CAL_STANDARDS_PPM, CAL_REPETITIONS, CAL_SIGMA_WARN, FULL_CAL_VALIDATION_TOL,
  checkCurveMonotonic, dilutionRows,
} from '../utils/readiness';
import { CHANNELS, channelMeta, channelA, saveChannel, DEFAULT_CHANNEL } from '../utils/channelPref';
import MeasureProgress from '../components/MeasureProgress';
import CurvePlot from '../components/CurvePlot';

const CALIBRATION_KEY = 'calibration_points';

// Guided full calibration: intro (standards prep + dilution table) → one
// screen per standard (auto 3 repetitions, averaged, σ-checked) → curve
// preview with monotonicity gate → mandatory validation run (±15%) → save
// and auto-link this box (a box that just built the curve is by definition
// its reference: link factor 1.0 / 0.0, marked validated by the run).
export default function FullCalibrationScreen({ navigation }) {
  const { ip, connected, boxId, deviceKey, refresh } = useBoxConnection();

  const [phase, setPhase] = useState('intro'); // intro | standards | preview | validate | done
  const [stdIndex, setStdIndex] = useState(0);
  // Each entry keeps ALL three channels' reps so the curve can be rebuilt on
  // any channel without re-measuring: { ppm, repsR:[], repsG:[], repsB:[] }
  const [measured, setMeasured] = useState([]);
  const [channel, setChannel] = useState(DEFAULT_CHANNEL); // green (EBT peak)
  const [progress, setProgress] = useState(null);
  const [validation, setValidation] = useState(null); // {nominal, measuredPpm, pass}

  const ppmNow = CAL_STANDARDS_PPM[stdIndex];

  // Per-channel mean + σ for one standard entry.
  const chanStats = (entry, ch) => {
    const reps = ch === 'red' ? entry.repsR : ch === 'blue' ? entry.repsB : entry.repsG;
    if (!reps || reps.length === 0) return { mean: 0, sigma: 0 };
    const mean = reps.reduce((s, v) => s + v, 0) / reps.length;
    const sigma = Math.sqrt(reps.reduce((s, v) => s + (v - mean) ** 2, 0) / reps.length);
    return { mean: parseFloat(mean.toFixed(4)), sigma: parseFloat(sigma.toFixed(4)) };
  };

  // Curve points on the ACTIVE channel — recomputes instantly when `channel`
  // changes, no re-measuring needed.
  const points = measured.map((m) => ({ absorbance: chanStats(m, channel).mean, hardness: m.ppm }));

  const failAlert = (e) => {
    const msg = e.kind === 'gate' ? e.message
      : e.kind === 'http' ? 'Update the box firmware (or the app) so both match, then try again.'
      : e.kind === 'cancelled' ? null
      : 'Check the phone is on the AQUA-BOX WiFi and mobile data is off, then try again.';
    if (msg) Alert.alert('Measurement stopped', msg);
  };

  // Fresh reference water first — the 0-ppm standard doubles as the blank.
  const captureBlankFirst = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Capturing reference water (0 ppm)…', token });
    try {
      await postBlank(ip, { signal: token.signal });
      await refresh();
      setPhase('standards');
      setStdIndex(0);
      setMeasured([]);
    } catch (e) {
      failAlert(e);
    } finally {
      setProgress(null);
    }
  };

  // Measure the current standard: CAL_REPETITIONS runs, capturing ALL three
  // channels each run so the curve can later be rebuilt on any channel.
  const measureStandard = async () => {
    const token = createCancelToken();
    const repsR = [], repsG = [], repsB = [];
    try {
      for (let i = 0; i < CAL_REPETITIONS; i++) {
        setProgress({ label: `Standard ${ppmNow} ppm — run ${i + 1} of ${CAL_REPETITIONS}…`, token });
        const m = await postMeasure(ip, { signal: token.signal });
        const a = channelA(m, channel);
        if (typeof a !== 'number') throw Object.assign(new Error('Box did not return a reading.'), { kind: 'gate' });
        repsR.push(m.A_red); repsG.push(m.A_green); repsB.push(m.A_blue);
      }
    } catch (e) {
      setProgress(null);
      failAlert(e);
      return;
    }
    setProgress(null);

    const entry = { ppm: ppmNow, repsR, repsG, repsB };
    const { sigma } = chanStats(entry, channel);

    const accept = () => {
      const next = [...measured.filter((m) => m.ppm !== ppmNow), entry];
      setMeasured(next);
      if (stdIndex + 1 < CAL_STANDARDS_PPM.length) setStdIndex(stdIndex + 1);
      else setPhase('preview');
    };

    if (sigma > CAL_SIGMA_WARN) {
      Alert.alert(
        'Readings scattered',
        `The ${CAL_REPETITIONS} runs disagree more than expected (σ = ${sigma.toFixed(4)}). ` +
        'Check the sample is well mixed and the box was not moved, then re-run — or keep this average anyway.',
        [
          { text: 'Re-run this standard', onPress: () => {} },
          { text: 'Keep anyway', onPress: accept },
        ]
      );
    } else {
      accept();
    }
  };

  // Curve preview → monotonicity gate.
  const mono = checkCurveMonotonic(points);
  const proceedToValidation = () => {
    if (!mono.ok) {
      const [a, b] = mono.reversal || [];
      Alert.alert(
        'Curve has a reversal',
        `The readings between ${a} ppm and ${b} ppm go the wrong way — one of those standards was ` +
        'probably mis-prepared or mis-measured. Re-measure it before the calibration can be saved.',
        (mono.reversal || []).map((ppm) => ({
          text: `Re-measure ${ppm} ppm`,
          onPress: () => { setStdIndex(CAL_STANDARDS_PPM.indexOf(ppm)); setPhase('standards'); },
        })).concat([{ text: 'Cancel', style: 'cancel' }])
      );
      return;
    }
    setPhase('validate');
  };

  // Mandatory validation: re-measure one standard as an unknown.
  const VALIDATE_PPM = 150;
  const runValidation = async () => {
    const token = createCancelToken();
    setProgress({ label: `Checking against the ${VALIDATE_PPM} ppm standard…`, token });
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      const ppm = computeHardness({ absorbance: channelA(m, channel) }, points.map((p, i) => ({ ...p, id: String(i) })));
      const pass = ppm !== null && Math.abs(ppm - VALIDATE_PPM) <= FULL_CAL_VALIDATION_TOL * VALIDATE_PPM;
      setValidation({ nominal: VALIDATE_PPM, measuredPpm: ppm, pass });
      if (!pass) {
        Alert.alert(
          'Validation failed',
          `The curve read ${ppm ?? '—'} ppm for the ${VALIDATE_PPM} ppm standard (allowed ±${FULL_CAL_VALIDATION_TOL * 100}%). ` +
          'Re-run the validation, or go back and re-measure the standards.'
        );
      }
    } catch (e) {
      failAlert(e);
    } finally {
      setProgress(null);
    }
  };

  const saveAll = async () => {
    const now = new Date().toISOString();
    const pts = measured.map((m, i) => {
      const r = chanStats(m, 'red').mean, g = chanStats(m, 'green').mean, b = chanStats(m, 'blue').mean;
      const active = channel === 'red' ? r : channel === 'blue' ? b : g;
      return {
        id: `${Date.now()}_${i}`,
        absorbance: active,          // active-channel value used for ppm
        absR: r, absG: g, absB: b,   // all channels → recompute later
        hardness: m.ppm,
        blueScore: null,
        label: `full calibration ${channel} (σ ${chanStats(m, channel).sigma})`,
        createdAt: now,
      };
    });
    await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(pts));
    await saveChannel(channel); // curve + measurements must use the same channel

    const activeMean = (m) => chanStats(m, channel).mean;
    // Auto-link this box: it built the curve, so it maps 1:1 onto it.
    if (deviceKey) {
      await saveDeviceCal({
        m: 1.0, c: 0.0,
        channel,
        standardPpm: validation?.nominal ?? VALIDATE_PPM,
        blankA: measured.find((m) => m.ppm === 0) ? activeMean(measured.find((m) => m.ppm === 0)) : 0,
        standardA: measured.find((m) => m.ppm === VALIDATE_PPM) ? activeMean(measured.find((m) => m.ppm === VALIDATE_PPM)) : null,
        masterHash: masterCurveHash(pts),
        deviceModel: boxId || 'box',
        validated: true,
        validation: {
          nominalPpm: validation?.nominal ?? VALIDATE_PPM,
          measuredPpm: validation?.measuredPpm ?? null,
          pass: true,
          at: now,
        },
      }, deviceKey);
    }
    setPhase('done');
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

      {phase === 'intro' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Before you start</Text>
            <Text style={styles.body}>
              You'll need 6 prepared standards, each with reagent added. Prepare them from a
              1000 ppm CaCO₃ stock solution (per 100 mL, top up with distilled water):
            </Text>
            <View style={styles.table}>
              <View style={styles.tr}>
                <Text style={[styles.th, { flex: 1 }]}>Standard</Text>
                <Text style={[styles.th, { flex: 1 }]}>Stock</Text>
                <Text style={[styles.th, { flex: 1.4 }]}>Distilled water</Text>
              </View>
              {dilutionRows().map((r) => (
                <View key={r.ppm} style={styles.tr}>
                  <Text style={[styles.td, { flex: 1 }]}>{r.ppm} ppm</Text>
                  <Text style={[styles.td, { flex: 1 }]}>{r.stockMl} mL</Text>
                  <Text style={[styles.td, { flex: 1.4 }]}>{r.waterMl} mL</Text>
                </View>
              ))}
            </View>
            <Text style={styles.body}>
              The whole run takes about 15 minutes. Each standard is measured {CAL_REPETITIONS} times
              automatically and averaged.
            </Text>
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
                  onPress={() => setChannel(c.key)}
                >
                  <Text style={[styles.chanBtnText, channel === c.key && { color: '#FFF' }]}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={captureBlankFirst}>
            <Text style={styles.primaryBtnText}>Start — capture reference water (0 ppm)</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>Put the 0 ppm sample (distilled water + reagent) in the box first.</Text>
        </>
      )}

      {phase === 'standards' && (
        <>
          {/* progress bar across standards */}
          <View style={styles.progressRow}>
            {CAL_STANDARDS_PPM.map((ppm, i) => {
              const done = measured.some((m) => m.ppm === ppm);
              const active = i === stdIndex;
              return (
                <View key={ppm} style={[styles.progressSeg, done && styles.progressSegDone, active && styles.progressSegActive]}>
                  <Text style={[styles.progressSegText, (done || active) && { color: '#FFF' }]}>{ppm}</Text>
                </View>
              );
            })}
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Standard {stdIndex + 1} of {CAL_STANDARDS_PPM.length}: {ppmNow} ppm</Text>
            <Text style={styles.body}>
              1. Put the {ppmNow} ppm standard (reagent added) into the box.{'\n'}
              2. Close the box fully.{'\n'}
              3. Tap Measure — {CAL_REPETITIONS} runs are taken and averaged automatically.
            </Text>
            {measured.some((m) => m.ppm === ppmNow) && (
              <Text style={styles.doneNote}>
                Already measured (A {chanStats(measured.find((m) => m.ppm === ppmNow), channel).mean}) — measuring again replaces it.
              </Text>
            )}
          </View>
          <TouchableOpacity style={styles.primaryBtn} onPress={measureStandard}>
            <Text style={styles.primaryBtnText}>📡 Measure {ppmNow} ppm standard</Text>
          </TouchableOpacity>

          {measured.length > 0 && (
            <View style={styles.miniList}>
              {measured.map((m) => (
                <Text key={m.ppm} style={styles.miniLine}>
                  ✓ {m.ppm} ppm → A {chanStats(m, channel).mean} (σ {chanStats(m, channel).sigma})
                </Text>
              ))}
            </View>
          )}
        </>
      )}

      {phase === 'preview' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Curve preview · {channelMeta(channel).label} channel</Text>
            <CurvePlot points={points.map((p, i) => ({ ...p, id: String(i) }))} />
            {mono.ok ? (
              <Text style={styles.okNote}>✓ Curve looks consistent (all segments move the same way).</Text>
            ) : (
              <Text style={styles.failNote}>
                ⚠ Reversal between {mono.reversal?.[0]} and {mono.reversal?.[1]} ppm — the calibration
                can't be saved until that standard is re-measured.
              </Text>
            )}
            {measured.map((m) => (
              <Text key={m.ppm} style={styles.miniLine}>{m.ppm} ppm → A {chanStats(m, channel).mean} (σ {chanStats(m, channel).sigma})</Text>
            ))}
          </View>
          <TouchableOpacity style={[styles.primaryBtn, !mono.ok && styles.btnDisabled]} onPress={proceedToValidation}>
            <Text style={styles.primaryBtnText}>Continue to validation</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkBtn} onPress={() => { setPhase('standards'); }}>
            <Text style={styles.linkBtnText}>← Back to standards</Text>
          </TouchableOpacity>
        </>
      )}

      {phase === 'validate' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Validation (required)</Text>
            <Text style={styles.body}>
              Put the {VALIDATE_PPM} ppm standard back into the box. It will be measured as an
              unknown — the new calibration must read it within ±{FULL_CAL_VALIDATION_TOL * 100}%.
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
          <TouchableOpacity style={styles.linkBtn} onPress={() => setPhase('preview')}>
            <Text style={styles.linkBtnText}>← Back to preview</Text>
          </TouchableOpacity>
        </>
      )}

      {phase === 'done' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>✓ Calibration complete</Text>
            <Text style={styles.body}>
              The calibration is saved and this box is linked. You can measure samples now — and share
              this calibration to other phones from Calibration → Advanced → Export.
            </Text>
          </View>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('CalibrationHome')}>
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </>
      )}

      <MeasureProgress
        visible={!!progress}
        label={progress?.label}
        onCancel={() => progress?.token.cancel()}
      />
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
  doneNote: { color: '#EF6C00', fontSize: 12, marginTop: 4 },
  okNote: { color: '#2E7D32', fontSize: 13, fontWeight: '600', marginTop: 10 },
  failNote: { color: '#C62828', fontSize: 13, fontWeight: '600', marginTop: 10, lineHeight: 19 },

  table: { marginVertical: 10, borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, overflow: 'hidden' },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#F0F0F0', paddingVertical: 6, paddingHorizontal: 10 },
  th: { fontWeight: 'bold', color: '#1565C0', fontSize: 12 },
  td: { color: '#37474F', fontSize: 12 },

  progressRow: { flexDirection: 'row', gap: 4, marginBottom: 14 },
  progressSeg: { flex: 1, borderRadius: 8, paddingVertical: 7, backgroundColor: '#CFD8DC', alignItems: 'center' },
  progressSegDone: { backgroundColor: '#2E7D32' },
  progressSegActive: { backgroundColor: '#1565C0' },
  progressSegText: { fontSize: 11, fontWeight: '700', color: '#546E7A' },

  miniList: { marginTop: 14, backgroundColor: '#FFF', borderRadius: 12, padding: 12 },
  miniLine: { color: '#546E7A', fontSize: 12, lineHeight: 19 },
  chanRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  chanBtn: { flex: 1, borderWidth: 1.5, borderColor: '#CFD8DC', borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  chanBtnText: { color: '#546E7A', fontWeight: '700', fontSize: 14 },

  primaryBtn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  primaryBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  btnDisabled: { backgroundColor: '#B0BEC5' },
  linkBtn: { alignItems: 'center', paddingVertical: 12 },
  linkBtnText: { color: '#546E7A', fontSize: 13 },
});
