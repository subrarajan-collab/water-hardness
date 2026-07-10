import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Share,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadCalibrationPoints, deleteCalibrationPoint, clearCalibration,
} from '../utils/calibration';
import { exportMasterCurve, parseMasterCurve, masterCurveHash, loadDeviceCal } from '../utils/deviceCalibration';
import { useBoxConnection } from '../context/BoxConnectionContext';
import CurvePlot from '../components/CurvePlot';
import Accordion from '../components/Accordion';

const CALIBRATION_KEY = 'calibration_points';

// Calibration hub: three task-shaped doors (Full calibration / Link this box
// / Accuracy check) with everything numeric behind the Advanced accordion.
export default function CalibrationScreen({ navigation }) {
  const { connected, boxId, deviceKey } = useBoxConnection();
  const [points, setPoints] = useState([]);
  const [deviceCal, setDeviceCal] = useState(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(async () => {
    setPoints(await loadCalibrationPoints());
    setDeviceCal(deviceKey ? await loadDeviceCal(deviceKey) : null);
  }, [deviceKey]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    load();
    return unsub;
  }, [navigation, load]);

  const absPoints = points.filter((p) => typeof p.absorbance === 'number');
  const calibrated = absPoints.length >= 2;
  const linked = !!(deviceCal && deviceCal.validated);

  const doExport = async () => {
    if (!calibrated) {
      Alert.alert('Nothing to share yet', 'Run a full calibration first, then you can share it to other boxes.');
      return;
    }
    try {
      await Share.share({ message: exportMasterCurve(points), title: 'Water hardness calibration' });
    } catch {}
  };

  const doImport = () => {
    try {
      const { points: imported, hash } = parseMasterCurve(importText.trim());
      Alert.alert(
        'Import calibration',
        `${imported.length} standards (version ${hash}). This replaces the current calibration. Continue?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Replace', style: 'destructive',
            onPress: async () => {
              await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(imported));
              setImportText('');
              setShowImport(false);
              load();
              Alert.alert('Imported ✓', 'Now link this box to the calibration (blank + one standard).');
            },
          },
        ]
      );
    } catch (e) {
      Alert.alert('Could not import', 'That text is not a calibration export. Paste the exact JSON that was shared from the other phone.');
    }
  };

  const removePoint = (id) => {
    Alert.alert('Delete point', 'Remove this calibration point?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => setPoints(await deleteCalibrationPoint(id)) },
    ]);
  };

  const clearAll = () => {
    Alert.alert('Delete calibration', 'Delete the whole calibration? Boxes will stop showing ppm until you calibrate again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await clearCalibration(); load(); } },
    ]);
  };

  const FlowCard = ({ emoji, title, desc, cta, onPress, disabled, badge }) => (
    <View style={styles.flowCard}>
      <View style={styles.flowHeader}>
        <Text style={styles.flowEmoji}>{emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.flowTitle}>{title}</Text>
          {badge}
        </View>
      </View>
      <Text style={styles.flowDesc}>{desc}</Text>
      <TouchableOpacity
        style={[styles.flowBtn, disabled && styles.btnDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        <Text style={styles.flowBtnText}>{cta}</Text>
      </TouchableOpacity>
      {disabled && <Text style={styles.flowDisabledNote}>Connect to a box first (Setup tab).</Text>}
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Status line */}
      <View style={styles.statusCard}>
        <Text style={styles.statusLine}>
          {calibrated
            ? `✓ Calibration active — ${absPoints.length} standards (version ${masterCurveHash(points)})`
            : '○ No calibration yet'}
        </Text>
        <Text style={styles.statusLine}>
          {linked ? `✓ This box is linked` : boxId ? '○ This box is not linked yet' : '○ No box connected'}
        </Text>
      </View>

      <FlowCard
        emoji="🧪"
        title="Full calibration"
        desc="First time, or after changing reagent chemistry. Measures 6 prepared standards (about 15 minutes) and builds the calibration from scratch."
        cta={calibrated ? 'Re-calibrate from scratch' : 'Start full calibration'}
        onPress={() => navigation.navigate('FullCalibration')}
        disabled={!connected}
      />

      <FlowCard
        emoji="🔗"
        title="Link this box"
        desc="This box is new but a calibration already exists (built here or imported). Two quick measurements adapt the calibration to this box."
        cta="Link box to calibration"
        onPress={() => navigation.navigate('LinkBox')}
        disabled={!connected || !calibrated}
      />

      <FlowCard
        emoji="✅"
        title="Accuracy check"
        desc="Routine quality control: measure one known standard and confirm the reading is still accurate. Logged to Results as a QC entry."
        cta="Run accuracy check"
        onPress={() => navigation.navigate('AccuracyCheck')}
        disabled={!connected || !calibrated}
      />

      {/* ── Expert content, tucked away ── */}
      <Accordion title="Advanced">
        <Text style={styles.advSection}>Curve</Text>
        <CurvePlot points={points} />

        <Text style={styles.advSection}>Points</Text>
        {points.length === 0 ? (
          <Text style={styles.emptyText}>No points.</Text>
        ) : (
          points.map((pt) => (
            <View key={pt.id} style={styles.pointRow}>
              <View style={styles.pointDot} />
              <View style={styles.pointInfo}>
                <Text style={styles.pointMain}>
                  {typeof pt.absorbance === 'number' ? `A ${pt.absorbance.toFixed(3)} → ${pt.hardness} ppm` : `${pt.hardness} ppm`}
                </Text>
                {pt.label ? <Text style={styles.pointLabel}>{pt.label}</Text> : null}
              </View>
              <TouchableOpacity onPress={() => removePoint(pt.id)} style={styles.deleteBtn}>
                <Text style={styles.deleteBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
        {points.length > 0 && (
          <TouchableOpacity onPress={clearAll}>
            <Text style={styles.clearAllText}>Delete entire calibration</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.advSection}>Share between phones</Text>
        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.exportBtn} onPress={doExport}>
            <Text style={styles.exportBtnText}>📤 Export JSON</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.importToggleBtn} onPress={() => setShowImport(!showImport)}>
            <Text style={styles.importToggleBtnText}>📥 Import</Text>
          </TouchableOpacity>
        </View>
        {showImport && (
          <>
            <TextInput
              style={styles.importBox}
              value={importText}
              onChangeText={setImportText}
              placeholder="Paste exported calibration JSON here…"
              placeholderTextColor="#90A4AE"
              multiline
            />
            <TouchableOpacity
              style={[styles.installBtn, !importText.trim() && styles.btnDisabled]}
              disabled={!importText.trim()}
              onPress={doImport}
            >
              <Text style={styles.installBtnText}>Install</Text>
            </TouchableOpacity>
          </>
        )}

        {deviceCal && (
          <>
            <Text style={styles.advSection}>Box link (this box)</Text>
            <Text style={styles.advMono}>
              m = {deviceCal.m}   c = {deviceCal.c}{'\n'}
              fitted {deviceCal.fittedAt ? new Date(deviceCal.fittedAt).toLocaleString() : '—'}
              {deviceCal.validation ? `\nvalidated: ${deviceCal.validation.measuredPpm} ppm vs ${deviceCal.validation.nominalPpm} ppm (${deviceCal.validation.pass ? 'pass' : 'fail'})` : ''}
            </Text>
          </>
        )}
      </Accordion>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },

  statusCard: {
    backgroundColor: '#E8EAF6', borderRadius: 14, padding: 14, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#3949AB',
  },
  statusLine: { color: '#37474F', fontSize: 13, lineHeight: 21 },

  flowCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 14, elevation: 2 },
  flowHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  flowEmoji: { fontSize: 22, marginRight: 10 },
  flowTitle: { fontSize: 15, fontWeight: 'bold', color: '#1A237E' },
  flowDesc: { color: '#546E7A', fontSize: 13, lineHeight: 19, marginBottom: 12 },
  flowBtn: { backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  flowBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  flowDisabledNote: { color: '#90A4AE', fontSize: 11, marginTop: 6, textAlign: 'center' },
  btnDisabled: { backgroundColor: '#B0BEC5' },

  advSection: { fontSize: 13, fontWeight: 'bold', color: '#1565C0', marginTop: 14, marginBottom: 8 },
  advMono: { color: '#546E7A', fontSize: 12, lineHeight: 18 },
  emptyText: { color: '#90A4AE', fontSize: 13 },

  pointRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  pointDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1565C0', marginRight: 10 },
  pointInfo: { flex: 1 },
  pointMain: { fontSize: 13, color: '#1A237E', fontWeight: '600' },
  pointLabel: { fontSize: 11, color: '#90A4AE' },
  deleteBtn: { padding: 6 },
  deleteBtnText: { color: '#EF5350', fontSize: 14, fontWeight: 'bold' },
  clearAllText: { color: '#C62828', fontSize: 12, marginTop: 10 },

  btnRow: { flexDirection: 'row', gap: 10 },
  exportBtn: { flex: 1, backgroundColor: '#1565C0', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  exportBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 12 },
  importToggleBtn: { borderWidth: 1, borderColor: '#1565C0', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  importToggleBtnText: { color: '#1565C0', fontWeight: '600', fontSize: 12 },
  importBox: {
    backgroundColor: '#F5F5F5', borderRadius: 10, padding: 12, marginTop: 10,
    minHeight: 90, textAlignVertical: 'top', fontSize: 12, color: '#1A237E',
    borderWidth: 1, borderColor: '#E0E0E0',
  },
  installBtn: { backgroundColor: '#1565C0', borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 8 },
  installBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 12 },
});
