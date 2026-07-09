import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadCalibrationPoints } from '../utils/calibration';
import {
  fitDeviceFactor, saveDeviceCal, loadDeviceCal, masterCurveHash,
  computeHardnessDeviceAware, VALIDATION_TOLERANCE, getDeviceModel,
  phoneDeviceKey,
} from '../utils/deviceCalibration';
import { postMeasure } from '../api/boxClient';

const PROGRESS_KEY_BASE = 'device_cal_progress_v1';

// Guided per-phone calibration:
//   1. measure the reagent BLANK        → A_blank
//   2. measure one known STANDARD       → A_std
//   3. fit A_device = m·A_master + c    (with sanity guards)
//   4. VALIDATE: re-measure the standard as an unknown, accept within ±10%
export default function DeviceCalibrationScreen({ route, navigation }) {
  // Source: phone camera (default) or a WiFi box.
  const sourceType = route.params?.sourceType || 'phone'; // 'phone' | 'box'
  const boxIp = route.params?.boxIp || null;
  const deviceKey = route.params?.deviceKey || phoneDeviceKey();
  const deviceLabel = route.params?.deviceLabel || getDeviceModel();
  const PROGRESS_KEY = `${PROGRESS_KEY_BASE}:${deviceKey}`;

  const [masterPoints, setMasterPoints] = useState([]);
  const [progress, setProgress] = useState({ standardPpm: '150' });
  const [existingCal, setExistingCal] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      setMasterPoints(await loadCalibrationPoints());
      setExistingCal(await loadDeviceCal(deviceKey));
      try {
        const raw = await AsyncStorage.getItem(PROGRESS_KEY);
        if (raw) setProgress(JSON.parse(raw));
      } catch {}
    })();
  }, []);

  const persist = async (p) => {
    setProgress(p);
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(p)).catch(() => {});
  };

  // ── Receive a measurement back from Camera → Result ───────────────────────
  useEffect(() => {
    const captured = route.params?.captured;
    if (!captured) return;
    navigation.setParams({ captured: undefined });
    handleCaptured(captured);
  }, [route.params?.captured]);

  const handleCaptured = async (captured) => {
    const p = { ...progress };
    if (captured.for === 'device-blank') {
      p.blankA = captured.absorbance;
      await persist(p);
    } else if (captured.for === 'device-standard') {
      p.standardA = captured.absorbance;
      await persist(p);
      await tryFit(p);
    } else if (captured.for === 'device-validate') {
      await handleValidation(captured.absorbance, p);
    }
  };

  const tryFit = async (p) => {
    const standardPpm = parseFloat(p.standardPpm);
    const fit = fitDeviceFactor({
      blankA: p.blankA,
      standardA: p.standardA,
      standardPpm,
      masterPoints,
    });
    if (fit.error) {
      Alert.alert('Fit rejected', fit.error);
      // clear the standard so the user re-measures after fixing the issue
      await persist({ ...p, standardA: undefined });
      return;
    }
    const record = await saveDeviceCal({
      m: fit.m,
      c: fit.c,
      standardPpm,
      blankA: p.blankA,
      standardA: p.standardA,
      masterHash: masterCurveHash(masterPoints),
      deviceModel: deviceLabel,
      validated: false,
      validation: null,
    }, deviceKey);
    setExistingCal(record);
    await persist({ ...p, fitted: true });
    Alert.alert(
      'Device factor fitted',
      `m = ${fit.m}, c = ${fit.c}\n\nNow validate: re-measure the ${standardPpm} ppm standard as an unknown.`
    );
  };

  const handleValidation = async (absorbance, p) => {
    const cal = await loadDeviceCal(deviceKey);
    if (!cal) return;
    const res = computeHardnessDeviceAware({ absorbance }, masterPoints, cal);
    const nominal = parseFloat(p.standardPpm);
    const measured = res?.ppm ?? null;
    const pass =
      measured !== null && Math.abs(measured - nominal) <= VALIDATION_TOLERANCE * nominal;

    const record = await saveDeviceCal({
      ...cal,
      validated: pass,
      validation: {
        nominalPpm: nominal,
        measuredPpm: measured,
        pass,
        at: new Date().toISOString(),
      },
    }, deviceKey);
    setExistingCal(record);

    if (pass) {
      await AsyncStorage.removeItem(PROGRESS_KEY).catch(() => {});
      await persist({ standardPpm: p.standardPpm, done: true });
      Alert.alert(
        'Validation passed ✓',
        `Standard measured ${measured} ppm (nominal ${nominal} ppm, within ±${VALIDATION_TOLERANCE * 100}%).\n${deviceLabel} is calibrated.`
      );
    } else {
      Alert.alert(
        'Validation failed',
        `Standard measured ${measured ?? '—'} ppm vs nominal ${nominal} ppm (limit ±${VALIDATION_TOLERANCE * 100}%).\n\nRepeat the validation, or restart the fit if it keeps failing.`
      );
    }
  };

  const restart = async () => {
    await AsyncStorage.removeItem(PROGRESS_KEY).catch(() => {});
    setProgress({ standardPpm: progress.standardPpm || '150' });
  };

  // Phone source → route through the camera flow (returns via route.captured).
  // Box source → call /measure directly and handle the absorbance inline.
  const goMeasure = async (what) => {
    if (sourceType === 'box') {
      setBusy(true);
      try {
        const m = await postMeasure(boxIp);
        if (typeof m.A_blue !== 'number') { Alert.alert('No reading', 'Box did not return A_blue.'); return; }
        await handleCaptured({ for: what, absorbance: m.A_blue });
      } catch (e) {
        // e.kind: 'network' (unreachable), 'http' (firmware/app mismatch),
        // 'gate' (box rejected — clipping, no blank, etc.), 'cancelled'.
        const title = e.kind === 'gate' ? 'Measurement rejected'
          : e.kind === 'http' ? 'Firmware mismatch'
          : e.kind === 'cancelled' ? 'Cancelled'
          : 'Box unreachable';
        Alert.alert(title, e.message || 'Could not run the measurement.');
      } finally {
        setBusy(false);
      }
      return;
    }
    navigation.navigate('Camera', { captureFor: what });
  };

  const masterReady = masterPoints.filter((pt) => typeof pt.absorbance === 'number').length >= 2;
  const ppmValid = Number.isFinite(parseFloat(progress.standardPpm)) && parseFloat(progress.standardPpm) > 0;

  const step = !progress.blankA && !progress.fitted ? 1
    : !progress.fitted ? 2
    : !(existingCal?.validated) ? 3
    : 4;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Calibrate · {deviceLabel}</Text>
        <Text style={styles.infoText}>
          Two measurements map {sourceType === 'box' ? 'this box' : 'this phone'} onto the master
          curve: the reagent blank and one known standard. A validation run then confirms the fit.
          {sourceType === 'box' ? ' Measurements run on the box over WiFi.' : ''}
        </Text>
      </View>

      {!masterReady && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            ⚠️ No master curve. Build one on the Calibration screen (2+ absorbance points) or
            import one in Settings first.
          </Text>
        </View>
      )}

      {/* Standard ppm */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Standard concentration</Text>
        <TextInput
          style={styles.input}
          value={String(progress.standardPpm ?? '')}
          onChangeText={(t) => persist({ ...progress, standardPpm: t })}
          keyboardType="numeric"
          placeholder="150"
          placeholderTextColor="#90A4AE"
          editable={!progress.fitted}
        />
        <Text style={styles.fieldNote}>ppm CaCO₃ of the known standard (default 150)</Text>
      </View>

      {/* Step 1: blank */}
      <View style={[styles.card, step === 1 && styles.cardActive]}>
        <Text style={styles.cardTitle}>
          1. Reagent blank {typeof progress.blankA === 'number' ? `✓  A = ${progress.blankA.toFixed(3)}` : ''}
        </Text>
        <Text style={styles.stepText}>
          Bottle with reagent-treated ZERO-hardness water (distilled + reagent).
        </Text>
        {step === 1 && (
          <TouchableOpacity
            style={[styles.measureBtn, (!masterReady || !ppmValid || busy) && styles.btnDisabled]}
            disabled={!masterReady || !ppmValid || busy}
            onPress={() => goMeasure('device-blank')}
          >
            <Text style={styles.measureBtnText}>{busy ? '… measuring' : (sourceType === 'box' ? '📡 Measure blank' : '📷 Measure blank')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Step 2: standard */}
      <View style={[styles.card, step === 2 && styles.cardActive]}>
        <Text style={styles.cardTitle}>
          2. Known standard {typeof progress.standardA === 'number' ? `✓  A = ${progress.standardA.toFixed(3)}` : ''}
        </Text>
        <Text style={styles.stepText}>
          Bottle with the {progress.standardPpm || '—'} ppm standard, reagent added.
        </Text>
        {step === 2 && (
          <TouchableOpacity style={[styles.measureBtn, busy && styles.btnDisabled]} disabled={busy} onPress={() => goMeasure('device-standard')}>
            <Text style={styles.measureBtnText}>{busy ? '… measuring' : (sourceType === 'box' ? '📡 Measure standard' : '📷 Measure standard')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Step 3: validation */}
      <View style={[styles.card, step === 3 && styles.cardActive]}>
        <Text style={styles.cardTitle}>
          3. Validate {existingCal?.validated ? '✓ passed' : ''}
        </Text>
        <Text style={styles.stepText}>
          Re-measure the same standard as an unknown. Accepted within ±{VALIDATION_TOLERANCE * 100}% of nominal.
          {existingCal?.validation && !existingCal.validated
            ? `\nLast attempt: ${existingCal.validation.measuredPpm ?? '—'} ppm (nominal ${existingCal.validation.nominalPpm}).`
            : ''}
        </Text>
        {step === 3 && (
          <TouchableOpacity style={[styles.measureBtn, busy && styles.btnDisabled]} disabled={busy} onPress={() => goMeasure('device-validate')}>
            <Text style={styles.measureBtnText}>{busy ? '… measuring' : (sourceType === 'box' ? '📡 Validation run' : '📷 Validation run')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {step === 4 && (
        <View style={styles.successBox}>
          <Text style={styles.successText}>
            ✓ {deviceLabel} is calibrated (m = {existingCal.m}, c = {existingCal.c}).{'\n'}
            Validated {existingCal.validation?.measuredPpm} ppm against {existingCal.validation?.nominalPpm} ppm.
          </Text>
        </View>
      )}

      <TouchableOpacity style={styles.restartBtn} onPress={restart}>
        <Text style={styles.restartBtnText}>↺ Restart calibration</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },
  infoCard: {
    backgroundColor: '#E8EAF6', borderRadius: 16, padding: 16,
    marginBottom: 16, borderLeftWidth: 4, borderLeftColor: '#3949AB',
  },
  infoTitle: { fontWeight: 'bold', color: '#3949AB', marginBottom: 6, fontSize: 14 },
  infoText: { color: '#37474F', fontSize: 13, lineHeight: 19 },

  warnBox: {
    backgroundColor: '#FFF8E1', borderRadius: 12, padding: 12, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#FFA000',
  },
  warnText: { color: '#E65100', fontSize: 13, lineHeight: 18 },

  card: {
    backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 14, elevation: 2,
    borderWidth: 2, borderColor: 'transparent',
  },
  cardActive: { borderColor: '#1565C0' },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 8 },
  stepText: { color: '#546E7A', fontSize: 13, lineHeight: 19, marginBottom: 10 },

  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 10, fontSize: 15, color: '#1A237E',
    borderWidth: 1, borderColor: '#E0E0E0',
  },
  fieldNote: { color: '#90A4AE', fontSize: 11, marginTop: 6 },

  measureBtn: {
    backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 13, alignItems: 'center',
  },
  measureBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  btnDisabled: { backgroundColor: '#B0BEC5' },

  successBox: {
    backgroundColor: '#E8F5E9', borderRadius: 12, padding: 14, marginBottom: 14,
    borderLeftWidth: 4, borderLeftColor: '#2E7D32',
  },
  successText: { color: '#1B5E20', fontSize: 13, lineHeight: 20 },

  restartBtn: { alignItems: 'center', paddingVertical: 12 },
  restartBtnText: { color: '#C62828', fontSize: 13, fontWeight: '600' },
});
