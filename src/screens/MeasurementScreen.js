import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { postMeasure, postBlank, createCancelToken, thumbUrl, measureToAnalysis } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import { loadCalibrationPoints, saveTestResult } from '../utils/calibration';
import { loadDeviceCal, computeHardnessDeviceAware, masterCurveHash } from '../utils/deviceCalibration';
import { computeReadiness, classifyHardness, blankAgeText } from '../utils/readiness';
import MeasureProgress from '../components/MeasureProgress';
import ResultPanel from '../components/ResultPanel';
import ReadinessCard from '../components/ReadinessCard';

const APP_VERSION = require('../../package.json').version;
const SETUP_DONE_KEY = 'setup_done';          // set by SetupScreen on save/auto-tune
const ONBOARDING_DONE_KEY = 'onboarding_done';

function alertFor(e) {
  // Action-first error messages, never a cause code.
  if (e.kind === 'gate') return ['Measurement stopped', e.message];
  if (e.kind === 'http') return ['Box needs a firmware update', 'Update the box firmware (or the app) so both match, then try again.'];
  if (e.kind === 'cancelled') return ['Cancelled', 'Measurement was cancelled.'];
  return ['Box not reachable', "Check the phone is on the AQUA-BOX WiFi and mobile data is off, then try again."];
}

export default function MeasurementScreen({ navigation }) {
  const { ip, connected, status, boxId, deviceKey, hasPreview, refresh } = useBoxConnection();
  const [sampleName, setSampleName] = useState('');
  const [progress, setProgress] = useState(null); // { label, token } | null
  const [result, setResult] = useState(null);
  const [hardnessPPM, setHardnessPPM] = useState(null);
  const [deviceCalibrated, setDeviceCalibrated] = useState(false);
  const [deviceCal, setDeviceCal] = useState(null);
  const [masterPoints, setMasterPoints] = useState([]);
  const [masterHash, setMasterHash] = useState(null);
  const [saved, setSaved] = useState(false);
  const [setupDone, setSetupDone] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(true); // assume done until read

  const loadContext = useCallback(async () => {
    const pts = await loadCalibrationPoints();
    setMasterPoints(pts);
    setMasterHash(masterCurveHash(pts));
    setDeviceCal(deviceKey ? await loadDeviceCal(deviceKey) : null);
    setSetupDone((await AsyncStorage.getItem(SETUP_DONE_KEY).catch(() => null)) === '1');
    setOnboardingDone((await AsyncStorage.getItem(ONBOARDING_DONE_KEY).catch(() => null)) === '1');
  }, [deviceKey]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', () => { loadContext(); refresh(); });
    loadContext();
    return unsub;
  }, [navigation, loadContext, refresh]);

  const readiness = computeReadiness({
    connected,
    blankAgeS: status?.blank_age_s,
    masterPoints,
    deviceCal,
  });

  // Onboarding checklist = readiness plus the one-time "regions & exposure"
  // step, in first-use order. Collapses to the compact card once everything
  // has been true simultaneously at least once.
  const onboardingItems = [
    readiness.items.find((i) => i.id === 'connect'),
    {
      id: 'setup',
      ok: setupDone,
      title: 'Set regions & exposure',
      detail: setupDone ? 'Done' : 'Aim the boxes and auto-tune exposure in Setup',
      fixLabel: setupDone ? null : 'Open Setup',
    },
    readiness.items.find((i) => i.id === 'blank'),
    {
      id: 'calibrate',
      ok: readiness.items.find((i) => i.id === 'calibration').ok && readiness.items.find((i) => i.id === 'link').ok,
      title: 'Calibrate',
      detail: readiness.items.find((i) => i.id === 'calibration').ok
        ? (readiness.items.find((i) => i.id === 'link').ok ? 'Calibrated and linked' : 'Link this box to the calibration')
        : 'Run a full calibration with standards',
      fixLabel: 'Calibrate',
    },
  ];
  const onboardingAllOk = onboardingItems.every((i) => i.ok);

  useEffect(() => {
    if (!onboardingDone && onboardingAllOk) {
      AsyncStorage.setItem(ONBOARDING_DONE_KEY, '1').catch(() => {});
      setOnboardingDone(true);
    }
  }, [onboardingAllOk, onboardingDone]);

  const captureBlankInline = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Capturing reference water…', token });
    try {
      await postBlank(ip, { signal: token.signal });
      await refresh();
      Alert.alert('Reference water captured ✓', 'You can measure samples now.');
    } catch (e) {
      const [t, m] = alertFor(e);
      Alert.alert(t, m);
    } finally {
      setProgress(null);
    }
  };

  const onFix = (id) => {
    if (id === 'connect' || id === 'setup') navigation.navigate('SetupTab');
    else if (id === 'blank') {
      if (!connected) { navigation.navigate('SetupTab'); return; }
      captureBlankInline();
    }
    else if (id === 'calibration') navigation.navigate('CalibrationTab', { screen: 'FullCalibration' });
    else if (id === 'link') navigation.navigate('CalibrationTab', { screen: 'LinkBox' });
    else if (id === 'calibrate') {
      navigation.navigate('CalibrationTab', {
        screen: readiness.items.find((i) => i.id === 'calibration').ok ? 'LinkBox' : 'FullCalibration',
      });
    }
  };

  const measure = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Measuring…', token });
    setResult(null);
    setSaved(false);
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      const analysis = measureToAnalysis(m);
      const res = computeHardnessDeviceAware(analysis, masterPoints, deviceCal);
      setResult(analysis);
      setHardnessPPM(res?.ppm ?? null);
      setDeviceCalibrated(res?.deviceCalibrated ?? false);
    } catch (e) {
      const [t, m2] = alertFor(e);
      Alert.alert(t, m2);
    } finally {
      setProgress(null);
    }
  };

  const save = async () => {
    if (!result || saved) return;
    const cls = classifyHardness(hardnessPPM);
    await saveTestResult({
      label: cls?.label ?? null,
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
      blankCapturedAt: typeof result.blankAgeS === 'number' && result.blankAgeS >= 0
        ? new Date(Date.now() - result.blankAgeS * 1000).toISOString()
        : null,
      deviceWarnings: result.warnings ?? null,
    });
    setSaved(true);
  };

  const newMeasurement = () => {
    setResult(null);
    setSampleName('');
    setSaved(false);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {!result ? (
        <>
          <ReadinessCard
            readiness={onboardingDone ? readiness : { items: onboardingItems, ready: onboardingAllOk }}
            onboarding={!onboardingDone}
            onFix={onFix}
          />

          {connected && (
            <Text style={styles.blankLine}>
              Reference water: {blankAgeText(status?.blank_age_s)}
            </Text>
          )}

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

          <TouchableOpacity
            style={[styles.measureBtn, !connected && styles.btnDisabled]}
            onPress={measure}
            disabled={!connected}
          >
            <Text style={styles.measureBtnText}>📡  Measure</Text>
          </TouchableOpacity>
          {!readiness.ppmAvailable && connected && (
            <Text style={styles.uncalHint}>
              You can measure now, but without a calibration the result shows absorbance only (no ppm).
            </Text>
          )}
        </>
      ) : (
        <>
          {sampleName ? <Text style={styles.sampleTitle}>{sampleName}</Text> : null}
          <ResultPanel
            result={result}
            hardnessPPM={hardnessPPM}
            deviceCalibrated={deviceCalibrated}
            thumbUri={hasPreview ? thumbUrl(ip) : null}
            masterHash={readiness.ppmAvailable ? masterHash : null}
          />
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.saveBtn, saved && styles.savedBtn]}
              onPress={save}
              disabled={saved}
            >
              <Text style={styles.actionBtnText}>{saved ? '✓ Saved' : '💾 Save'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.newBtn2]} onPress={newMeasurement}>
              <Text style={styles.actionBtnText}>📡 New</Text>
            </TouchableOpacity>
          </View>
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

  blankLine: { color: '#546E7A', fontSize: 12, marginBottom: 12, textAlign: 'center' },

  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 6 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0',
  },

  measureBtn: { backgroundColor: '#1565C0', borderRadius: 16, paddingVertical: 22, alignItems: 'center', elevation: 3 },
  measureBtnText: { color: '#FFF', fontSize: 19, fontWeight: 'bold' },
  btnDisabled: { backgroundColor: '#B0BEC5' },
  uncalHint: { color: '#EF6C00', fontSize: 12, marginTop: 10, textAlign: 'center', lineHeight: 17 },

  sampleTitle: { fontSize: 16, fontWeight: 'bold', color: '#1A237E', marginBottom: 10, textAlign: 'center' },

  actionsRow: { flexDirection: 'row', gap: 12 },
  actionBtn: { flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32' },
  savedBtn: { backgroundColor: '#546E7A' },
  newBtn2: { backgroundColor: '#1565C0' },
  actionBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
});
