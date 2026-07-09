import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  connectAndVerify, getStatus, postBlank, postMeasure, measureToAnalysis,
  createCancelToken, DEFAULT_IP, EXPECTED_API_VERSION,
} from '../api/boxClient';
import { loadCalibrationPoints } from '../utils/calibration';
import { loadDeviceCal, boxDeviceKey } from '../utils/deviceCalibration';
import DebugPanel from '../components/DebugPanel';
import MeasureProgress from '../components/MeasureProgress';

const LAST_IP_KEY = 'wifi_last_ip';

function ageText(s) {
  if (s === null || s === undefined || s < 0) return 'unknown — recapture';
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  const h = s / 3600;
  return `${h.toFixed(1)} h ago${h > 24 ? ' — recapture' : ''}`;
}

function alertTitleFor(e) {
  return e.kind === 'gate' ? 'Measurement rejected'
    : e.kind === 'http' ? 'Firmware mismatch'
    : e.kind === 'cancelled' ? 'Cancelled'
    : 'Box unreachable';
}

export default function HomeScreen({ navigation }) {
  const [ip, setIp] = useState(DEFAULT_IP);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [apiVersionMatch, setApiVersionMatch] = useState(true);
  const [apiVersion, setApiVersion] = useState(null);

  const [debugVisible, setDebugVisible] = useState(false);
  const [progress, setProgress] = useState(null); // { label, token } | null

  const boxId = status?.box_id;
  const deviceKey = boxId ? boxDeviceKey(boxId) : null;
  const hasPreview = !!status?.capabilities?.preview;
  const connected = !!status;

  useEffect(() => {
    AsyncStorage.getItem(LAST_IP_KEY).then((v) => { if (v) setIp(v); }).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (!connected) return;
    try {
      const s = await getStatus(ip);
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(e.message || 'Status refresh failed');
    }
  }, [ip, connected]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', refresh);
    return unsub;
  }, [navigation, refresh]);

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const r = await connectAndVerify(ip);
      await AsyncStorage.setItem(LAST_IP_KEY, ip).catch(() => {});
      setStatus(r.status);
      setApiVersion(r.apiVersion);
      setApiVersionMatch(r.apiVersionMatch);
      setStatusError(null);
    } catch (e) {
      setConnectError(e.message || 'Could not connect to the box.');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    setStatus(null);
    setStatusError(null);
  };

  const captureBlank = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Capturing blank…', token });
    try {
      const r = await postBlank(ip, { signal: token.signal });
      Alert.alert('Blank captured ✓', `ROI net blue ${r.roi_net?.b?.toFixed?.(1) ?? '—'}. Now measure a sample.`);
      await refresh();
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Blank capture failed.');
    } finally {
      setProgress(null);
    }
  };

  const measure = async () => {
    const token = createCancelToken();
    setProgress({ label: 'Measuring sample…', token });
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      const analysis = measureToAnalysis(m);
      const calPoints = await loadCalibrationPoints();
      const dCal = deviceKey ? await loadDeviceCal(deviceKey) : null;
      navigation.navigate('Result', {
        analysisData: analysis,
        boxMeta: { box_id: boxId, fw_version: status?.fw_version, ip },
        deviceKey,
        preloadedDeviceCal: dCal,
        preloadedMaster: calPoints,
      });
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Measurement failed.');
    } finally {
      setProgress(null);
    }
  };

  // ── Not connected: show the connect form ──────────────────────────────────
  if (!connected) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>💧 AQUA-BOX Water Hardness Tester</Text>
          <Text style={styles.infoText}>
            Power the box, join its WiFi network “AQUA-BOX” on this phone, then connect.
            The box is at {DEFAULT_IP} by default.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Box IP address</Text>
          <TextInput
            style={styles.input}
            value={ip}
            onChangeText={setIp}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            placeholder={DEFAULT_IP}
            placeholderTextColor="#90A4AE"
          />
          <TouchableOpacity
            style={[styles.connectBtn, connecting && styles.btnDisabled]}
            onPress={connect}
            disabled={connecting}
          >
            {connecting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.connectBtnText}>Connect</Text>}
          </TouchableOpacity>
        </View>

        {connectError && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>{connectError}</Text>
          </View>
        )}
      </ScrollView>
    );
  }

  // ── Connected: status + measure ───────────────────────────────────────────
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TouchableOpacity
        style={styles.card}
        onLongPress={() => setDebugVisible(true)}
        delayLongPress={500}
        activeOpacity={0.8}
      >
        <Text style={styles.cardTitle}>{status?.device_type || 'device'} · {boxId || '—'}</Text>
        <Text style={styles.metaText}>
          fw {status?.fw_version || '—'} (api v{apiVersion ?? '?'}
          {apiVersionMatch ? '' : `, app expects v${EXPECTED_API_VERSION} ⚠`}) · uptime {status?.uptime ?? '—'}s{'\n'}
          blank: {ageText(status?.blank_age_s)}
        </Text>
        {statusError && <Text style={styles.statusErrText}>⚠ {statusError}</Text>}
        {!apiVersionMatch && (
          <Text style={styles.apiWarnText}>
            ⚠ Firmware/app version mismatch — some features may fail. Update firmware or app.
          </Text>
        )}
        <Text style={styles.longPressHint}>long-press for debug info</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.measureBtn} onPress={measure}>
        <Text style={styles.measureBtnText}>📡  Measure sample</Text>
      </TouchableOpacity>

      <View style={styles.row}>
        <TouchableOpacity
          style={styles.secBtn}
          onPress={() => navigation.navigate('BoxSetup', { ip, status })}
        >
          <Text style={styles.secBtnText}>🎛 Box Setup</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secBtn} onPress={() => navigation.navigate('History')}>
          <Text style={styles.secBtnText}>📋 History</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <TouchableOpacity style={styles.secBtn} onPress={() => navigation.navigate('Calibration')}>
          <Text style={styles.secBtnText}>📈 Master Curve</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secBtn}
          onPress={() => navigation.navigate('DeviceCalibration', {
            boxIp: ip, deviceKey,
            deviceLabel: `${status?.device_type || 'box'} ${boxId || ''}`.trim(),
          })}
        >
          <Text style={styles.secBtnText}>⚙️ Calibrate Box</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <TouchableOpacity style={styles.linkBtn} onPress={refresh}>
          <Text style={styles.linkText}>↻ Refresh status</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.linkBtn} onPress={disconnect}>
          <Text style={styles.linkText}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      <MeasureProgress
        visible={!!progress}
        label={progress?.label}
        onCancel={() => progress?.token.cancel()}
      />
      <DebugPanel visible={debugVisible} onClose={() => setDebugVisible(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },

  infoCard: {
    backgroundColor: '#E8EAF6', borderRadius: 16, padding: 16, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#3949AB',
  },
  infoTitle: { fontWeight: 'bold', color: '#3949AB', marginBottom: 6, fontSize: 16 },
  infoText: { color: '#37474F', fontSize: 13, lineHeight: 19 },

  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 8 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 6 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0', marginBottom: 14,
  },
  connectBtn: { backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  connectBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
  btnDisabled: { backgroundColor: '#B0BEC5' },
  errBox: { backgroundColor: '#FFF3E0', borderRadius: 12, padding: 14, borderLeftWidth: 4, borderLeftColor: '#EF6C00' },
  errText: { color: '#E65100', fontSize: 13, lineHeight: 19 },

  metaText: { color: '#546E7A', fontSize: 13, lineHeight: 19 },
  statusErrText: { color: '#C62828', fontSize: 12, marginTop: 8, fontWeight: '600' },
  apiWarnText: { color: '#EF6C00', fontSize: 12, marginTop: 8, fontWeight: '600' },
  longPressHint: { color: '#B0BEC5', fontSize: 10, marginTop: 10, textAlign: 'right' },

  measureBtn: { backgroundColor: '#1565C0', borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginBottom: 12, elevation: 3 },
  measureBtnText: { color: '#FFF', fontSize: 17, fontWeight: 'bold' },

  row: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  secBtn: { flex: 1, backgroundColor: '#FFF', borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#BBDEFB' },
  secBtnText: { color: '#1565C0', fontWeight: '600', fontSize: 13 },

  linkBtn: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  linkText: { color: '#546E7A', fontSize: 13 },
});
