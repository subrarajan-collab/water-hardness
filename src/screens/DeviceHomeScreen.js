import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { getStatus, postBlank, postMeasure, measureToAnalysis } from '../api/boxClient';
import { loadCalibrationPoints } from '../utils/calibration';
import {
  loadDeviceCal, computeHardnessDeviceAware, boxDeviceKey,
} from '../utils/deviceCalibration';

function alertTitleFor(e) {
  return e.kind === 'gate' ? 'Measurement rejected'
    : e.kind === 'http' ? 'Firmware mismatch'
    : e.kind === 'cancelled' ? 'Cancelled'
    : 'Box unreachable';
}

function ageText(s) {
  if (s === null || s === undefined || s < 0) return 'unknown — recapture';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  const h = s / 3600;
  return `${h.toFixed(1)} h ago${h > 24 ? ' — recapture' : ''}`;
}

export default function DeviceHomeScreen({ route, navigation }) {
  const ip = route.params.ip;
  const [status, setStatus] = useState(route.params.status || null);
  const [statusError, setStatusError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');

  const boxId = status?.box_id;
  const deviceKey = boxId ? boxDeviceKey(boxId) : null;
  const hasPreview = !!status?.capabilities?.preview;

  // A refresh failure must NOT wipe out already-good status — that would
  // silently regress the card to placeholder dashes with no visible cause.
  const refresh = useCallback(async () => {
    try {
      const s = await getStatus(ip);
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(e.message || 'Status refresh failed');
    }
  }, [ip]);

  useEffect(() => {
    refresh(); // don't rely solely on the 'focus' event timing
    const unsub = navigation.addListener('focus', refresh);
    return unsub;
  }, [navigation, refresh]);

  const captureBlank = async () => {
    setBusy(true); setBusyLabel('Capturing blank (~25 s)…');
    try {
      const r = await postBlank(ip);
      Alert.alert('Blank captured ✓', `ROI net blue ${r.roi_net?.b?.toFixed?.(1) ?? '—'}. Now measure a sample.`);
      await refresh();
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Measurement failed.');
    } finally { setBusy(false); }
  };

  const measure = async () => {
    setBusy(true); setBusyLabel('Measuring (~25 s)…');
    try {
      const m = await postMeasure(ip);
      const analysis = measureToAnalysis(m);
      const calPoints = await loadCalibrationPoints();
      const dCal = deviceKey ? await loadDeviceCal(deviceKey) : null;
      navigation.navigate('Result', {
        analysisData: analysis,
        frameCount: analysis.frameCount,
        deviceMode: 'wifi',
        deviceKey,
        boxMeta: { box_id: boxId, fw_version: status?.fw_version, ip },
        skipDeviceLoad: true,          // ResultScreen uses the cal we pass
        preloadedDeviceCal: dCal,
        preloadedMaster: calPoints,
      });
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Measurement failed.');
    } finally { setBusy(false); }
  };

  if (busy) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1565C0" />
        <Text style={styles.busyText}>{busyLabel}</Text>
        <Text style={styles.busySub}>Keep the phone on the box WiFi.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{status?.device_type || 'device'} · {boxId || '—'}</Text>
        <Text style={styles.metaText}>
          fw {status?.fw_version || '—'} · uptime {status?.uptime ?? '—'}s{'\n'}
          blank: {ageText(status?.blank_age_s)}
        </Text>
        {statusError && (
          <Text style={styles.statusErrText}>⚠ {statusError}</Text>
        )}
      </View>

      <TouchableOpacity style={styles.measureBtn} onPress={measure}>
        <Text style={styles.measureBtnText}>📡  Measure sample</Text>
      </TouchableOpacity>

      <View style={styles.row}>
        <TouchableOpacity style={styles.secBtn} onPress={captureBlank}>
          <Text style={styles.secBtnText}>🧪 Capture blank</Text>
        </TouchableOpacity>
        {hasPreview && (
          <TouchableOpacity
            style={styles.secBtn}
            onPress={() => navigation.navigate('DeviceSetup', { ip, status })}
          >
            <Text style={styles.secBtnText}>🎛 ROI setup</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity
        style={styles.calBtn}
        onPress={() => navigation.navigate('DeviceCalibration', {
          sourceType: 'box',
          boxIp: ip,
          deviceKey,
          deviceLabel: `${status?.device_type || 'box'} ${boxId || ''}`.trim(),
        })}
      >
        <Text style={styles.calBtnText}>⚙️  Calibrate this box</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.refreshBtn} onPress={refresh}>
        <Text style={styles.refreshText}>↻ Refresh status</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#E3F2FD', padding: 24 },
  busyText: { marginTop: 18, fontSize: 16, fontWeight: 'bold', color: '#1565C0' },
  busySub: { marginTop: 6, fontSize: 13, color: '#546E7A' },

  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 8 },
  metaText: { color: '#546E7A', fontSize: 13, lineHeight: 19 },
  statusErrText: { color: '#C62828', fontSize: 12, marginTop: 8, fontWeight: '600' },

  measureBtn: { backgroundColor: '#1565C0', borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginBottom: 12, elevation: 3 },
  measureBtnText: { color: '#FFF', fontSize: 17, fontWeight: 'bold' },

  row: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  secBtn: { flex: 1, backgroundColor: '#FFF', borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#BBDEFB' },
  secBtnText: { color: '#1565C0', fontWeight: '600', fontSize: 13 },

  calBtn: { backgroundColor: '#6A1B9A', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginBottom: 12 },
  calBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  refreshBtn: { alignItems: 'center', paddingVertical: 10 },
  refreshText: { color: '#546E7A', fontSize: 13 },
});
