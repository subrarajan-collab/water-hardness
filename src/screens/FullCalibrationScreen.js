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
  const [measured, setMeasured] = useState([]); // [{ppm, absorbance, sigma, reps:[..]}]
  const [progress, setProgress] = useState(null);
  const [validation, setValidation] = useState(null); // {nominal, measuredPpm, pass}

  const ppmNow = CAL_STANDARDS_PPM[stdIndex];
  const points = measured.map((m) => ({ absorbance: m.absorbance, hardness: m.ppm }));

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

  // Measure the current standard: CAL_REPETITIONS runs, averaged, σ across reps.
  const measureStandard = async () => {
    const token = createCancelToken();
    const reps = [];
    try {
      for (let i = 0; i < CAL_REPETITIONS; i++) {
        setProgress({ label: `Standard ${ppmNow} ppm — run ${i + 1} of ${CAL_REPETITIONS}…`, token });
        const m = await postMeasure(ip, { signal: token.signal });
        if (typeof m.A_blue !== 'number') throw Object.assign(new Error('Box did not return a reading.'), { kind: 'gate' });
        reps.push(m.A_blue);
      }
    } catch (e) {
      setProgress(null);
      failAlert(e);
      return;
    }
    setProgress(null);

    const mean = reps.reduce((s, v) => s + v, 0) / reps.length;
    const sigma = Math.sqrt(reps.reduce((s, v) => s + (v - mean) ** 2, 0) / reps.length);
    const entry = { ppm: ppmNow, absorbance: parseFloat(mean.toFixed(4)), sigma: parseFloat(sigma.toFixed(4)), reps };

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
      const ppm = computeHardness({ absorbance: m.A_blue }, points.map((p, i) => ({ ...p, id: String(i) })));
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
    const pts = measured.map((m, i) => ({
      id: `${Date.now()}_${i}`,
      absorbance: m.absorbance,
      hardness: m.ppm,
      blueScore: null,
      label: `full calibration (σ ${m.sigma})`,
      createdAt: now,
    }));
    await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(pts));

    // Auto-link this box: it built the curve, so it maps 1:1 onto it.
    if (deviceKey) {
      await saveDeviceCal({
        m: 1.0, c: 0.0,
        standardPpm: validation?.nominal ?? VALIDATE_PPM,
        blankA: measured.find((m) => m.ppm === 0)?.absorbance ?? 0,
        standardA: measured.find((m) => m.ppm === VALIDATE_PPM)?.absorbance ?? null,
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
                Already measured (A {measured.find((m) => m.ppm === ppmNow).absorbance}) — measuring again replaces it.
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
                  ✓ {m.ppm} ppm → A {m.absorbance} (σ {m.sigma})
                </Text>
              ))}
            </View>
          )}
        </>
      )}

      {phase === 'preview' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Curve preview</Text>
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
              <Text key={m.ppm} style={styles.miniLine}>{m.ppm} ppm → A {m.absorbance} (σ {m.sigma})</Text>
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

  primaryBtn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  primaryBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  btnDisabled: { backgroundColor: '#B0BEC5' },
  linkBtn: { alignItems: 'center', paddingVertical: 12 },
  linkBtnText: { color: '#546E7A', fontSize: 13 },
});
