import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { loadCalibrationPoints, saveTestResult } from '../utils/calibration';
import {
  loadDeviceCal, computeHardnessDeviceAware, masterCurveHash, VALIDATION_TOLERANCE,
} from '../utils/deviceCalibration';
import { postMeasure, createCancelToken, measureToAnalysis } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import { classifyHardness } from '../utils/readiness';
import MeasureProgress from '../components/MeasureProgress';

const APP_VERSION = require('../../package.json').version;

// Routine QC: measure one known standard, pass/fail against ±10%, log the
// run to Results tagged as a QC entry. On fail, guide to re-link, then to a
// full recalibration.
export default function AccuracyCheckScreen({ navigation }) {
  const { ip, connected, boxId, deviceKey, status } = useBoxConnection();
  const [nominal, setNominal] = useState('150');
  const [progress, setProgress] = useState(null);
  const [outcome, setOutcome] = useState(null); // { measuredPpm, pass, absorbance }
  const [masterPoints, setMasterPoints] = useState([]);
  const [deviceCal, setDeviceCal] = useState(null);

  useEffect(() => {
    (async () => {
      setMasterPoints(await loadCalibrationPoints());
      setDeviceCal(deviceKey ? await loadDeviceCal(deviceKey) : null);
    })();
  }, [deviceKey]);

  const run = async () => {
    const target = parseFloat(nominal);
    if (!Number.isFinite(target) || target <= 0) {
      Alert.alert('Enter the standard', 'Type the ppm of the standard you are checking with (e.g. 150).');
      return;
    }
    const token = createCancelToken();
    setProgress({ label: 'Running accuracy check…', token });
    setOutcome(null);
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      const analysis = measureToAnalysis(m);
      const res = computeHardnessDeviceAware(analysis, masterPoints, deviceCal);
      const measuredPpm = res?.ppm ?? null;
      const pass = measuredPpm !== null && Math.abs(measuredPpm - target) <= VALIDATION_TOLERANCE * target;
      setOutcome({ measuredPpm, pass, target });

      // Log to history, tagged as QC
      const cls = classifyHardness(measuredPpm);
      await saveTestResult({
        qc: true,
        qcNominalPpm: target,
        qcPass: pass,
        label: cls?.label ?? null,
        sampleName: `QC ${target} ppm`,
        blueScore: analysis.blueScore,
        blueDominance: analysis.blueDominance,
        r: analysis.r, g: analysis.g, b: analysis.b,
        hardnessPPM: measuredPpm,
        frameCount: analysis.frameCount ?? null,
        rejectedFrames: analysis.rejectedFrames ?? 0,
        absorbanceStdDev: analysis.absorbanceStdDev ?? null,
        absorbance: analysis.absorbance ?? null,
        absorbanceR: analysis.absorbanceR ?? null,
        absorbanceG: analysis.absorbanceG ?? null,
        boxId: boxId ?? null,
        fwVersion: status?.fw_version ?? null,
        deviceKey: deviceKey ?? null,
        deviceFactor: deviceCal ? { m: deviceCal.m, c: deviceCal.c } : null,
        deviceCalibrated: !!(deviceCal && deviceCal.validated),
        masterCurveHash: masterCurveHash(masterPoints),
        appVersion: APP_VERSION,
        satFraction: analysis.satFraction ?? null,
        darkLevel: analysis.darkLevel ?? null,
        blankAgeS: analysis.blankAgeS ?? null,
        deviceWarnings: analysis.warnings ?? null,
      });
    } catch (e) {
      const msg = e.kind === 'gate' ? e.message
        : e.kind === 'http' ? 'Update the box firmware (or the app) so both match, then try again.'
        : e.kind === 'cancelled' ? null
        : 'Check the phone is on the AQUA-BOX WiFi and mobile data is off, then try again.';
      if (msg) Alert.alert('Check stopped', msg);
    } finally {
      setProgress(null);
    }
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
      <View style={styles.card}>
        <Text style={styles.title}>Accuracy check</Text>
        <Text style={styles.body}>
          Put a standard of known hardness (reagent added) into the box, enter its value, and run
          the check. The reading must be within ±{VALIDATION_TOLERANCE * 100}% to pass. The run is
          saved to Results as a QC entry either way.
        </Text>
        <Text style={styles.fieldLabel}>Standard hardness (ppm)</Text>
        <TextInput
          style={styles.input}
          value={nominal}
          onChangeText={setNominal}
          keyboardType="numeric"
          placeholder="150"
          placeholderTextColor="#90A4AE"
        />
      </View>

      <TouchableOpacity style={styles.btn} onPress={run}>
        <Text style={styles.btnText}>📡 Run accuracy check</Text>
      </TouchableOpacity>

      {outcome && (
        <View style={[styles.banner, outcome.pass ? styles.bannerPass : styles.bannerFail]}>
          <Text style={[styles.bannerTitle, { color: outcome.pass ? '#1B5E20' : '#B71C1C' }]}>
            {outcome.pass ? '✓ PASS' : '✗ FAIL'}
          </Text>
          <Text style={[styles.bannerText, { color: outcome.pass ? '#1B5E20' : '#B71C1C' }]}>
            Read {outcome.measuredPpm ?? '—'} ppm · target {outcome.target} ppm (±{VALIDATION_TOLERANCE * 100}%)
          </Text>
          {!outcome.pass && (
            <>
              <Text style={styles.fixText}>
                First re-link this box to the calibration. If the check still fails afterwards, run a
                full calibration — the chemistry may have changed.
              </Text>
              <View style={styles.fixRow}>
                <TouchableOpacity style={styles.fixBtn} onPress={() => navigation.navigate('LinkBox')}>
                  <Text style={styles.fixBtnText}>🔗 Re-link box</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.fixBtnOutline} onPress={() => navigation.navigate('FullCalibration')}>
                  <Text style={styles.fixBtnOutlineText}>🧪 Full recalibration</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
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
  title: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 8 },
  body: { color: '#546E7A', fontSize: 13, lineHeight: 19, marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 6 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 15, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0',
  },

  btn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  btnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  banner: { borderRadius: 16, padding: 18, marginTop: 16, elevation: 2 },
  bannerPass: { backgroundColor: '#E8F5E9', borderLeftWidth: 5, borderLeftColor: '#2E7D32' },
  bannerFail: { backgroundColor: '#FFEBEE', borderLeftWidth: 5, borderLeftColor: '#C62828' },
  bannerTitle: { fontSize: 22, fontWeight: 'bold' },
  bannerText: { fontSize: 14, marginTop: 4, fontWeight: '600' },
  fixText: { color: '#B71C1C', fontSize: 12, lineHeight: 18, marginTop: 10 },
  fixRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  fixBtn: { flex: 1, backgroundColor: '#C62828', borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  fixBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 12 },
  fixBtnOutline: { flex: 1, borderWidth: 1, borderColor: '#C62828', borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  fixBtnOutlineText: { color: '#C62828', fontWeight: 'bold', fontSize: 12 },
});
