import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Share,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadCalibrationPoints } from '../utils/calibration';
import {
  exportMasterCurve, parseMasterCurve, masterCurveHash,
  loadDeviceCal, clearDeviceCal, getDeviceModel,
} from '../utils/deviceCalibration';

const CALIBRATION_KEY = 'calibration_points';

export default function SettingsScreen({ navigation }) {
  const [points, setPoints] = useState([]);
  const [deviceCal, setDeviceCal] = useState(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const refresh = async () => {
    setPoints(await loadCalibrationPoints());
    setDeviceCal(await loadDeviceCal());
  };

  useEffect(() => {
    const unsub = navigation.addListener('focus', refresh);
    refresh();
    return unsub;
  }, [navigation]);

  const absPoints = points.filter((p) => typeof p.absorbance === 'number');

  const doExport = async () => {
    if (absPoints.length < 2) {
      Alert.alert('Nothing to export', 'Build a master curve first (2+ absorbance calibration points).');
      return;
    }
    try {
      await Share.share({
        message: exportMasterCurve(points),
        title: 'Water hardness master curve',
      });
    } catch {}
  };

  const doImport = () => {
    try {
      const { points: imported, hash } = parseMasterCurve(importText.trim());
      Alert.alert(
        'Import master curve',
        `${imported.length} points (hash ${hash}). This REPLACES the current calibration curve. Continue?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Replace',
            style: 'destructive',
            onPress: async () => {
              await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(imported));
              setImportText('');
              setShowImport(false);
              refresh();
              Alert.alert('Imported', `Master curve installed (${imported.length} points).`);
            },
          },
        ]
      );
    } catch (e) {
      Alert.alert('Invalid curve', e.message || 'Could not parse the pasted JSON.');
    }
  };

  const doClearDeviceCal = () => {
    Alert.alert('Clear device calibration', 'Remove the device factor for this phone?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await clearDeviceCal(); refresh(); } },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── Master curve ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Master curve</Text>
        <Text style={styles.rowText}>
          {absPoints.length} absorbance point{absPoints.length !== 1 ? 's' : ''}
          {absPoints.length >= 2 ? `  ·  hash ${masterCurveHash(points)}` : '  (need 2+)'}
        </Text>
        <Text style={styles.noteText}>
          Built once on the reference phone (Calibration screen), then shared to other phones.
        </Text>
        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.btnPrimary} onPress={doExport}>
            <Text style={styles.btnPrimaryText}>📤 Export (share JSON)</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnOutline} onPress={() => setShowImport(!showImport)}>
            <Text style={styles.btnOutlineText}>📥 Import</Text>
          </TouchableOpacity>
        </View>
        {showImport && (
          <>
            <TextInput
              style={styles.importBox}
              value={importText}
              onChangeText={setImportText}
              placeholder='Paste the exported master-curve JSON here…'
              placeholderTextColor="#90A4AE"
              multiline
            />
            <TouchableOpacity
              style={[styles.btnPrimary, { marginTop: 8 }, !importText.trim() && styles.btnDisabled]}
              disabled={!importText.trim()}
              onPress={doImport}
            >
              <Text style={styles.btnPrimaryText}>Install curve</Text>
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity onPress={() => navigation.navigate('Calibration')}>
          <Text style={styles.linkText}>Open calibration screen →</Text>
        </TouchableOpacity>
      </View>

      {/* ── Device calibration ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>This phone · {getDeviceModel()}</Text>
        {deviceCal ? (
          <>
            <Text style={styles.rowText}>
              {deviceCal.validated ? '✓ Calibrated & validated' : '⚠ Fitted, NOT validated'}
            </Text>
            <Text style={styles.noteText}>
              m = {deviceCal.m}, c = {deviceCal.c} · fitted {new Date(deviceCal.fittedAt).toLocaleDateString()}
              {'\n'}standard {deviceCal.standardPpm} ppm · blank A = {deviceCal.blankA?.toFixed(3)}
              {deviceCal.validation
                ? `\nvalidation: ${deviceCal.validation.measuredPpm ?? '—'} ppm vs ${deviceCal.validation.nominalPpm} ppm ${deviceCal.validation.pass ? '✓' : '✗'}`
                : ''}
              {deviceCal.masterHash ? `\nmaster hash at fit: ${deviceCal.masterHash}` : ''}
            </Text>
          </>
        ) : (
          <Text style={styles.rowText}>
            Not calibrated for this phone — results use the master curve directly.
          </Text>
        )}
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={styles.btnPrimary}
            onPress={() => navigation.navigate('DeviceCalibration')}
          >
            <Text style={styles.btnPrimaryText}>
              {deviceCal ? '↺ Re-run device calibration' : '🧪 Calibrate this phone'}
            </Text>
          </TouchableOpacity>
          {deviceCal && (
            <TouchableOpacity style={styles.btnOutline} onPress={doClearDeviceCal}>
              <Text style={[styles.btnOutlineText, { color: '#C62828' }]}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Capture layout ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Capture layout</Text>
        <Text style={styles.noteText}>
          Reference-patch positions and water ROI for the bottle rig.
        </Text>
        <TouchableOpacity
          style={[styles.btnPrimary, { marginTop: 10 }]}
          onPress={() => navigation.navigate('PanelSetup')}
        >
          <Text style={styles.btnPrimaryText}>🎛 Panel setup</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },
  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 8 },
  rowText: { color: '#1A237E', fontSize: 14, fontWeight: '600', marginBottom: 6 },
  noteText: { color: '#546E7A', fontSize: 12, lineHeight: 18 },
  linkText: { color: '#1565C0', fontSize: 13, marginTop: 10, fontWeight: '600' },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btnPrimary: {
    flex: 1, backgroundColor: '#1565C0', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  btnPrimaryText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },
  btnOutline: {
    borderWidth: 1, borderColor: '#1565C0', borderRadius: 12,
    paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center',
  },
  btnOutlineText: { color: '#1565C0', fontWeight: '600', fontSize: 13 },
  btnDisabled: { backgroundColor: '#B0BEC5' },

  importBox: {
    backgroundColor: '#F5F5F5', borderRadius: 10, padding: 12, marginTop: 10,
    minHeight: 100, textAlignVertical: 'top', fontSize: 12, color: '#1A237E',
    borderWidth: 1, borderColor: '#E0E0E0',
  },
});
