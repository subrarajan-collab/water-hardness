import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { postMeasure, createCancelToken, thumbUrl, measureToAnalysis } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import { loadCalibrationPoints, saveTestResult } from '../utils/calibration';
import { loadDeviceCal, computeHardnessDeviceAware, masterCurveHash } from '../utils/deviceCalibration';
import { getHardnessLabel } from '../utils/colorAnalysis';
import MeasureProgress from '../components/MeasureProgress';
import ResultPanel from '../components/ResultPanel';

const APP_VERSION = require('../../package.json').version;

function alertTitleFor(e) {
  return e.kind === 'gate' ? 'Measurement rejected'
    : e.kind === 'http' ? 'Firmware mismatch'
    : e.kind === 'cancelled' ? 'Cancelled'
    : 'Box unreachable';
}

export default function MeasurementScreen({ navigation }) {
  const { ip, connected, status, boxId, deviceKey, hasPreview } = useBoxConnection();
  const [sampleName, setSampleName] = useState('');
  const [progress, setProgress] = useState(null); // { token } | null
  const [result, setResult] = useState(null);
  const [hardnessPPM, setHardnessPPM] = useState(null);
  const [label, setLabel] = useState(null);
  const [deviceCalibrated, setDeviceCalibrated] = useState(false);
  const [deviceCal, setDeviceCal] = useState(null);
  const [masterHash, setMasterHash] = useState(null);
  const [saved, setSaved] = useState(false);

  const measure = async () => {
    const token = createCancelToken();
    setProgress({ token });
    setResult(null);
    setSaved(false);
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      const analysis = measureToAnalysis(m);
      const calPoints = await loadCalibrationPoints();
      const dCal = deviceKey ? await loadDeviceCal(deviceKey) : null;
      setDeviceCal(dCal);
      setMasterHash(masterCurveHash(calPoints));

      const res = computeHardnessDeviceAware(analysis, calPoints, dCal);
      setResult(analysis);
      setHardnessPPM(res?.ppm ?? null);
      setDeviceCalibrated(res?.deviceCalibrated ?? false);
      setLabel(getHardnessLabel(analysis.blueDominance));
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Measurement failed.');
    } finally {
      setProgress(null);
    }
  };

  const save = async () => {
    if (!result || saved) return;
    await saveTestResult({
      label: label?.label,
      sampleName: sampleName.trim() || null,
      blueScore: result.blueScore,
      blueDominance: result.blueDominance,
      r: result.r, g: result.g, b: result.b,
      hardnessPPM,
      frameCount: result.frameCount ?? null,
      rejectedFrames: result.rejectedFrames ?? 0,
      absorbanceStdDev: result.absorbanceStdDev ?? null,
      absorbance: result.absorbance ?? null,
      absorbanceR: result.absorbanceR ?? null,
      absorbanceG: result.absorbanceG ?? null,
      boxId: boxId ?? null,
      fwVersion: status?.fw_version ?? null,
      deviceKey: deviceKey ?? null,
      deviceFactor: deviceCal ? { m: deviceCal.m, c: deviceCal.c } : null,
      deviceCalibrated,
      masterCurveHash: masterHash,
      appVersion: APP_VERSION,
      satFraction: result.satFraction ?? null,
      darkLevel: result.darkLevel ?? null,
      blankAgeS: result.blankAgeS ?? null,
      deviceWarnings: result.warnings ?? null,
    });
    setSaved(true);
  };

  const newMeasurement = () => {
    setResult(null);
    setSampleName('');
    setSaved(false);
  };

  const addToCalibration = () => {
    if (!result) return;
    navigation.navigate('CalibrationTab', {
      screen: 'CalibrationHome',
      params: { absorbance: result.absorbance ?? null },
    });
  };

  if (!connected) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.notConnectedTitle}>Not connected</Text>
        <Text style={styles.notConnectedText}>Go to the Setup tab and connect to a box first.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {!result ? (
        <>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Sample name (optional)</Text>
            <TextInput
              style={styles.input}
              value={sampleName}
              onChangeText={setSampleName}
              placeholder="e.g. Tap water, kitchen"
              placeholderTextColor="#90A4AE"
            />
          </View>

          <TouchableOpacity style={styles.measureBtn} onPress={measure}>
            <Text style={styles.measureBtnText}>📡  Measure</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <ResultPanel
            result={result}
            hardnessPPM={hardnessPPM}
            label={label}
            deviceCalibrated={deviceCalibrated}
            thumbUri={hasPreview ? thumbUrl(ip) : null}
          />
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.saveBtn, saved && styles.savedBtn]}
              onPress={save}
              disabled={saved}
            >
              <Text style={styles.actionBtnText}>{saved ? '✓ Saved' : '💾 Save'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.calBtn]} onPress={addToCalibration}>
              <Text style={styles.actionBtnText}>📈 Add to curve</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.newBtn} onPress={newMeasurement}>
            <Text style={styles.newBtnText}>📡  New Measurement</Text>
          </TouchableOpacity>
        </>
      )}

      <MeasureProgress
        visible={!!progress}
        label="Measuring…"
        onCancel={() => progress?.token.cancel()}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },

  centerContainer: { flex: 1, backgroundColor: '#E3F2FD', justifyContent: 'center', alignItems: 'center', padding: 30 },
  notConnectedTitle: { fontSize: 18, fontWeight: 'bold', color: '#546E7A', marginBottom: 8 },
  notConnectedText: { fontSize: 14, color: '#78909C', textAlign: 'center' },

  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 6 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0',
  },

  measureBtn: { backgroundColor: '#1565C0', borderRadius: 16, paddingVertical: 22, alignItems: 'center', elevation: 3 },
  measureBtnText: { color: '#FFF', fontSize: 19, fontWeight: 'bold' },

  actionsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  actionBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32' },
  savedBtn: { backgroundColor: '#546E7A' },
  calBtn: { backgroundColor: '#6A1B9A' },
  actionBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  newBtn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 16, alignItems: 'center', elevation: 2 },
  newBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
});
