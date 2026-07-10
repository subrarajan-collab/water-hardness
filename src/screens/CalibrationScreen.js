import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Share,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadCalibrationPoints, saveCalibrationPoint, deleteCalibrationPoint, clearCalibration,
} from '../utils/calibration';
import { exportMasterCurve, parseMasterCurve, masterCurveHash } from '../utils/deviceCalibration';
import { postMeasure, createCancelToken } from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import MeasureProgress from '../components/MeasureProgress';
import CurvePlot from '../components/CurvePlot';

const CALIBRATION_KEY = 'calibration_points';

function alertTitleFor(e) {
  return e.kind === 'gate' ? 'Measurement rejected'
    : e.kind === 'http' ? 'Firmware mismatch'
    : e.kind === 'cancelled' ? 'Cancelled'
    : 'Box unreachable';
}

export default function CalibrationScreen({ route, navigation }) {
  const { ip, connected, boxId, deviceKey } = useBoxConnection();
  const prefillAbsorbance = route.params?.absorbance ?? null;

  const [points, setPoints] = useState([]);
  const [absorbanceIn, setAbsorbanceIn] = useState(
    prefillAbsorbance !== null ? String(prefillAbsorbance) : ''
  );
  const [hardnessPPM, setHardnessPPM] = useState('');
  const [label, setLabel] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [measuring, setMeasuring] = useState(null);

  useEffect(() => {
    loadPoints();
  }, []);

  // React to a fresh prefill coming in via navigation params (e.g. "Add to
  // curve" from the Measurement tab) even if this screen instance already existed.
  useEffect(() => {
    if (route.params?.absorbance !== undefined && route.params.absorbance !== null) {
      setAbsorbanceIn(String(route.params.absorbance));
    }
  }, [route.params?.absorbance]);

  const loadPoints = async () => {
    const pts = await loadCalibrationPoints();
    setPoints(pts);
  };

  const absPoints = points.filter((p) => typeof p.absorbance === 'number');

  // Live-measure add-point flow: runs a real measurement on the connected
  // box and drops A_blue straight into the form instead of requiring the
  // user to read it off the Measurement tab and retype it.
  const measureForPoint = async () => {
    if (!connected) {
      Alert.alert('No box connected', 'Go to the Setup tab and connect first.');
      return;
    }
    const token = createCancelToken();
    setMeasuring(token);
    try {
      const m = await postMeasure(ip, { signal: token.signal });
      if (typeof m.A_blue !== 'number') {
        Alert.alert('No reading', 'Box did not return A_blue.');
        return;
      }
      setAbsorbanceIn(String(m.A_blue));
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Measurement failed.');
    } finally {
      setMeasuring(null);
    }
  };

  const doExport = async () => {
    if (absPoints.length < 2) {
      Alert.alert('Nothing to export', 'Add 2+ absorbance points first.');
      return;
    }
    try {
      await Share.share({ message: exportMasterCurve(points), title: 'Water hardness master curve' });
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
              loadPoints();
              Alert.alert('Imported', `Master curve installed (${imported.length} points).`);
            },
          },
        ]
      );
    } catch (e) {
      Alert.alert('Invalid curve', e.message || 'Could not parse the pasted JSON.');
    }
  };

  const addPoint = async () => {
    const a = parseFloat(absorbanceIn);
    const ppm = parseFloat(hardnessPPM);

    if (isNaN(a) || a < 0 || a > 3) {
      Alert.alert('Invalid', 'Absorbance must be a number between 0 and 3 (typically 0–1.5).');
      return;
    }
    if (isNaN(ppm) || ppm < 0) {
      Alert.alert('Invalid', 'Hardness (ppm) must be a positive number.');
      return;
    }

    const updated = await saveCalibrationPoint(null, ppm, label.trim(), a);
    setPoints(updated);
    setAbsorbanceIn('');
    setHardnessPPM('');
    setLabel('');
    navigation.setParams({ absorbance: undefined });
  };

  const removePoint = (id) => {
    Alert.alert('Delete Point', 'Remove this calibration point?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => setPoints(await deleteCalibrationPoint(id)),
      },
    ]);
  };

  const handleClearAll = () => {
    Alert.alert('Clear All', 'Delete all calibration points?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All', style: 'destructive',
        onPress: async () => { await clearCalibration(); setPoints([]); },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Master Curve</Text>
        <Text style={styles.infoText}>
          Built once (e.g. on a reference box), then shared to other boxes as a device factor.
          Measure known-hardness samples and add each as a point below.
        </Text>
      </View>

      {/* Curve plot */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>
          Curve — {absPoints.length} point{absPoints.length !== 1 ? 's' : ''}
          {absPoints.length >= 2 ? `  ·  hash ${masterCurveHash(points)}` : ''}
        </Text>
        <CurvePlot points={points} />
      </View>

      {/* Export / import */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Share</Text>
        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.exportBtn} onPress={doExport}>
            <Text style={styles.exportBtnText}>📤 Export</Text>
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
              placeholder="Paste the exported master-curve JSON here…"
              placeholderTextColor="#90A4AE"
              multiline
            />
            <TouchableOpacity
              style={[styles.addBtn, { marginTop: 8 }, !importText.trim() && styles.disabledBtn]}
              disabled={!importText.trim()}
              onPress={doImport}
            >
              <Text style={styles.addBtnText}>Install curve</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Validation-run helper */}
      <TouchableOpacity
        style={styles.calBoxBtn}
        onPress={() => navigation.navigate('DeviceCalibration', {
          boxIp: ip, deviceKey, deviceLabel: boxId || 'this box',
        })}
      >
        <Text style={styles.calBoxBtnText}>⚙️ Calibrate / validate this box →</Text>
      </TouchableOpacity>

      {/* Add point form */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Add Calibration Point</Text>

        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Absorbance A_blue</Text>
          <TouchableOpacity
            style={[styles.measureLinkBtn, !connected && styles.disabledBtn]}
            onPress={measureForPoint}
            disabled={!connected}
          >
            <Text style={styles.measureLinkBtnText}>📡 Measure</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.input}
          value={absorbanceIn}
          onChangeText={setAbsorbanceIn}
          keyboardType="numeric"
          placeholder="e.g. 0.412"
          placeholderTextColor="#90A4AE"
        />

        <Text style={styles.fieldLabel}>Known Hardness (ppm CaCO₃)</Text>
        <TextInput
          style={styles.input}
          value={hardnessPPM}
          onChangeText={setHardnessPPM}
          keyboardType="numeric"
          placeholder="e.g. 200"
          placeholderTextColor="#90A4AE"
        />

        <Text style={styles.fieldLabel}>Label (optional)</Text>
        <TextInput
          style={styles.input}
          value={label}
          onChangeText={setLabel}
          placeholder="e.g. Tap water Jan"
          placeholderTextColor="#90A4AE"
        />

        <TouchableOpacity style={styles.addBtn} onPress={addPoint}>
          <Text style={styles.addBtnText}>+ Add Point</Text>
        </TouchableOpacity>
      </View>

      {/* Points list */}
      <View style={styles.card}>
        <View style={styles.listHeader}>
          <Text style={styles.cardTitle}>Points ({points.length})</Text>
          {points.length > 0 && (
            <TouchableOpacity onPress={handleClearAll}>
              <Text style={styles.clearAllText}>Clear All</Text>
            </TouchableOpacity>
          )}
        </View>

        {points.length === 0 ? (
          <Text style={styles.emptyText}>No calibration points yet. Add at least 2 for ppm readings.</Text>
        ) : (
          points.map((pt) => (
            <View key={pt.id} style={styles.pointRow}>
              <View style={styles.pointDot} />
              <View style={styles.pointInfo}>
                <Text style={styles.pointMain}>
                  {typeof pt.absorbance === 'number'
                    ? `A ${pt.absorbance.toFixed(3)} → ${pt.hardness} ppm`
                    : `${pt.hardness} ppm`}
                </Text>
                {pt.label ? <Text style={styles.pointLabel}>{pt.label}</Text> : null}
                <Text style={styles.pointDate}>{new Date(pt.createdAt).toLocaleDateString()}</Text>
              </View>
              <TouchableOpacity onPress={() => removePoint(pt.id)} style={styles.deleteBtn}>
                <Text style={styles.deleteBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))
        )}

        {points.length === 1 && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>⚠️ Add 1 more point to enable ppm conversion.</Text>
          </View>
        )}
        {points.length >= 2 && (
          <View style={styles.successBox}>
            <Text style={styles.successText}>✓ Calibration active.</Text>
          </View>
        )}
      </View>

      <MeasureProgress visible={!!measuring} label="Measuring…" onCancel={() => measuring?.cancel()} />
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

  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20, marginBottom: 16, elevation: 2 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 14 },

  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 4 },
  measureLinkBtn: { backgroundColor: '#1565C0', borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 },
  measureLinkBtnText: { color: '#FFF', fontSize: 11, fontWeight: '700' },

  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 10, fontSize: 15, color: '#1A237E', marginBottom: 14,
    borderWidth: 1, borderColor: '#E0E0E0',
  },

  addBtn: { backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  addBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },

  calBoxBtn: { backgroundColor: '#6A1B9A', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginBottom: 16, elevation: 2 },
  calBoxBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  clearAllText: { color: '#C62828', fontSize: 13 },
  emptyText: { color: '#78909C', fontSize: 13, textAlign: 'center', lineHeight: 19, paddingVertical: 8 },

  pointRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  pointDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#1565C0', marginRight: 12 },
  pointInfo: { flex: 1 },
  pointMain: { fontSize: 14, color: '#1A237E', fontWeight: '600' },
  pointLabel: { fontSize: 12, color: '#546E7A', marginTop: 1 },
  pointDate: { fontSize: 11, color: '#90A4AE', marginTop: 1 },
  deleteBtn: { padding: 8 },
  deleteBtnText: { color: '#EF5350', fontSize: 16, fontWeight: 'bold' },

  warningBox: { backgroundColor: '#FFF8E1', borderRadius: 10, padding: 10, marginTop: 12, borderLeftWidth: 3, borderLeftColor: '#FFA000' },
  warningText: { color: '#E65100', fontSize: 12 },
  successBox: { backgroundColor: '#E8F5E9', borderRadius: 10, padding: 10, marginTop: 12, borderLeftWidth: 3, borderLeftColor: '#2E7D32' },
  successText: { color: '#1B5E20', fontSize: 12 },

  btnRow: { flexDirection: 'row', gap: 10 },
  exportBtn: { flex: 1, backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  exportBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },
  importToggleBtn: { borderWidth: 1, borderColor: '#1565C0', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  importToggleBtnText: { color: '#1565C0', fontWeight: '600', fontSize: 13 },
  importBox: {
    backgroundColor: '#F5F5F5', borderRadius: 10, padding: 12, marginTop: 10,
    minHeight: 100, textAlignVertical: 'top', fontSize: 12, color: '#1A237E',
    borderWidth: 1, borderColor: '#E0E0E0',
  },
  disabledBtn: { backgroundColor: '#B0BEC5' },
});
