import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { loadCalibrationPoints } from '../utils/calibration';
import {
  fitDeviceFactor, saveDeviceCal, loadDeviceCal, masterCurveHash,
  computeHardnessDeviceAware, VALIDATION_TOLERANCE,
} from '../utils/deviceCalibration';
import { postMeasure, postBlank, createCancelToken } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import MeasureProgress from '../components/MeasureProgress';

// "Link this box to the calibration" — the device-factor fit + validation,
// presented as a 3-step task with zero mention of slope/offset numbers
// (those remain visible under Calibration → Advanced for experts).
export default function LinkBoxScreen({ navigation }) {
  const { ip, connected, boxId, deviceKey, refresh } = useBoxConnection();

  const [masterPoints, setMasterPoints] = useState([]);
  const [standardPpm, setStandardPpm] = useState('150');
  const [blankA, setBlankA] = useState(null);
  const [standardA, setStandardA] = useState(null);
  const [fitted, setFitted] = useState(false);
  const [validated, setValidated] = useState(false);
  const [validationInfo, setValidationInfo] = useState(null);
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    (async () => {
      setMasterPoints(await loadCalibrationPoints());
      const cal = deviceKey ? await loadDeviceCal(deviceKey) : null;
      if (cal?.validated) setValidated(true);
    })();
  }, [deviceKey]);

  const failAlert = (e) => {
    const msg = e.kind === 'gate' ? e.message
      : e.kind === 'http' ? 'Update the box firmware (or the app) so both match, then try again.'
      : e.kind === 'cancelled' ? null
      : 'Check the phone is on the AQUA-BOX WiFi and mobile data is off, then try again.';
    if (msg) Alert.alert('Measurement stopped', msg);
  };

  const measureA = async (label) => {
    const token = createCancelToken();
    setProgress({ label, token });
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      if (typeof m.A_blue !== 'number') throw Object.assign(new Error('Box did not return a reading.'), { kind: 'gate' });
      return m.A_blue;
    } finally {
      setProgress(null);
    }
  };

  // Step 1: reference water — recapture the box blank AND measure it.
  const doBlank = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Capturing reference water…', token });
    try {
      await postBlank(ip, { signal: token.signal });
      await refresh();
    } catch (e) { setProgress(null); failAlert(e); return; }
    setProgress(null);
    try {
      const a = await measureA('Measuring reference water…');
      setBlankA(a);
    } catch (e) { failAlert(e); }
  };

  // Step 2: known standard → fit (guarded), stored unvalidated.
  const doStandard = async () => {
    const nominal = parseFloat(standardPpm);
    if (!Number.isFinite(nominal) || nominal <= 0) {
      Alert.alert('Enter the standard', 'Type the ppm value of your known standard (e.g. 150) before measuring.');
      return;
    }
    let a;
    try { a = await measureA(`Measuring ${nominal} ppm standard…`); }
    catch (e) { failAlert(e); return; }

    const fit = fitDeviceFactor({ blankA, standardA: a, standardPpm: nominal, masterPoints });
    if (fit.error) {
      Alert.alert('Link failed', fit.error);
      return;
    }
    await saveDeviceCal({
      m: fit.m, c: fit.c,
      standardPpm: nominal, blankA, standardA: a,
      masterHash: masterCurveHash(masterPoints),
      deviceModel: boxId || 'box',
      validated: false, validation: null,
    }, deviceKey);
    setStandardA(a);
    setFitted(true);
  };

  // Step 3: validation — re-measure the standard as an unknown, ±10%.
  const doValidate = async () => {
    const nominal = parseFloat(standardPpm);
    let a;
    try { a = await measureA('Validation run…'); }
    catch (e) { failAlert(e); return; }

    const cal = await loadDeviceCal(deviceKey);
    const res = computeHardnessDeviceAware({ absorbance: a }, masterPoints, cal);
    const measuredPpm = res?.ppm ?? null;
    const pass = measuredPpm !== null && Math.abs(measuredPpm - nominal) <= VALIDATION_TOLERANCE * nominal;

    await saveDeviceCal({
      ...cal,
      validated: pass,
      validation: { nominalPpm: nominal, measuredPpm, pass, at: new Date().toISOString() },
    }, deviceKey);
    setValidationInfo({ measuredPpm, nominal, pass });
    setValidated(pass);
    if (!pass) {
      Alert.alert(
        'Check failed',
        `The box read ${measuredPpm ?? '—'} ppm for the ${nominal} ppm standard (allowed ±${VALIDATION_TOLERANCE * 100}%). ` +
        'Re-run the validation. If it keeps failing, run a full calibration instead.'
      );
    }
  };

  const step = blankA === null ? 1 : !fitted ? 2 : !validated ? 3 : 4;
  const masterReady = masterPoints.filter((p) => typeof p.absorbance === 'number').length >= 2;

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
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Link {boxId || 'this box'} to the calibration</Text>
        <Text style={styles.infoText}>
          Two quick measurements teach this box how to read the shared calibration accurately:
          the reference water and one known standard, then a check.
        </Text>
      </View>

      {!masterReady && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            No calibration to link to yet. Run a full calibration first, or import one under
            Calibration → Advanced.
          </Text>
        </View>
      )}

      <View style={[styles.card, step === 1 && styles.cardActive]}>
        <Text style={styles.cardTitle}>
          1. Reference water (0 ppm) {blankA !== null ? '✓' : ''}
        </Text>
        <Text style={styles.stepText}>Distilled water with reagent added — put it in the box.</Text>
        {step === 1 && (
          <TouchableOpacity
            style={[styles.btn, !masterReady && styles.btnDisabled]}
            disabled={!masterReady}
            onPress={doBlank}
          >
            <Text style={styles.btnText}>📡 Capture & measure</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={[styles.card, step === 2 && styles.cardActive]}>
        <Text style={styles.cardTitle}>2. Known standard {fitted ? '✓' : ''}</Text>
        <Text style={styles.stepText}>A sample of known hardness, reagent added.</Text>
        <TextInput
          style={styles.input}
          value={standardPpm}
          onChangeText={setStandardPpm}
          keyboardType="numeric"
          placeholder="150"
          placeholderTextColor="#90A4AE"
          editable={step <= 2}
        />
        <Text style={styles.fieldNote}>ppm of the standard (150 recommended)</Text>
        {step === 2 && (
          <TouchableOpacity style={styles.btn} onPress={doStandard}>
            <Text style={styles.btnText}>📡 Measure standard</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={[styles.card, step === 3 && styles.cardActive]}>
        <Text style={styles.cardTitle}>3. Check {validated ? '✓ passed' : ''}</Text>
        <Text style={styles.stepText}>
          The same standard is measured once more as an unknown — it must read within
          ±{VALIDATION_TOLERANCE * 100}%.
          {validationInfo && !validationInfo.pass
            ? `\nLast try: ${validationInfo.measuredPpm ?? '—'} ppm (target ${validationInfo.nominal}).`
            : ''}
        </Text>
        {step === 3 && (
          <TouchableOpacity style={styles.btn} onPress={doValidate}>
            <Text style={styles.btnText}>📡 Run check</Text>
          </TouchableOpacity>
        )}
      </View>

      {step === 4 && (
        <>
          <View style={styles.successBox}>
            <Text style={styles.successText}>
              ✓ {boxId || 'This box'} is linked to the calibration
              {validationInfo ? ` — checked at ${validationInfo.measuredPpm} ppm vs ${validationInfo.nominal} ppm.` : '.'}
            </Text>
          </View>
          <TouchableOpacity style={styles.btn} onPress={() => navigation.navigate('CalibrationHome')}>
            <Text style={styles.btnText}>Done</Text>
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

  infoCard: {
    backgroundColor: '#E8EAF6', borderRadius: 16, padding: 16, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#3949AB',
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
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 15, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0',
  },
  fieldNote: { color: '#90A4AE', fontSize: 11, marginTop: 6, marginBottom: 10 },

  btn: { backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  btnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  btnDisabled: { backgroundColor: '#B0BEC5' },

  successBox: {
    backgroundColor: '#E8F5E9', borderRadius: 12, padding: 14, marginBottom: 14,
    borderLeftWidth: 4, borderLeftColor: '#2E7D32',
  },
  successText: { color: '#1B5E20', fontSize: 13, lineHeight: 20 },
});
