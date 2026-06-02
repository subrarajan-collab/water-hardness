import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  FlatList,
} from 'react-native';
import {
  loadCalibrationPoints,
  saveCalibrationPoint,
  deleteCalibrationPoint,
  clearCalibration,
} from '../utils/calibration';

export default function CalibrationScreen({ route, navigation }) {
  const prefillBlueScore = route.params?.blueScore;

  const [points, setPoints] = useState([]);
  const [blueScore, setBlueScore] = useState(
    prefillBlueScore ? String(prefillBlueScore) : ''
  );
  const [hardnessPPM, setHardnessPPM] = useState('');
  const [label, setLabel] = useState('');

  useEffect(() => {
    loadPoints();
  }, []);

  const loadPoints = async () => {
    const pts = await loadCalibrationPoints();
    setPoints(pts);
  };

  const addPoint = async () => {
    const bs = parseFloat(blueScore);
    const ppm = parseFloat(hardnessPPM);

    if (isNaN(bs) || bs < 0 || bs > 255) {
      Alert.alert('Invalid', 'Blue score must be between 0 and 255.');
      return;
    }
    if (isNaN(ppm) || ppm < 0) {
      Alert.alert('Invalid', 'Hardness (ppm) must be a positive number.');
      return;
    }

    const updated = await saveCalibrationPoint(bs, ppm, label.trim());
    setPoints(updated);
    setBlueScore('');
    setHardnessPPM('');
    setLabel('');
  };

  const removePoint = (id) => {
    Alert.alert('Delete Point', 'Remove this calibration point?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const updated = await deleteCalibrationPoint(id);
          setPoints(updated);
        },
      },
    ]);
  };

  const handleClearAll = () => {
    Alert.alert('Clear All', 'Delete all calibration points?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All',
        style: 'destructive',
        onPress: async () => {
          await clearCalibration();
          setPoints([]);
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Explanation */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>How Calibration Works</Text>
        <Text style={styles.infoText}>
          Measure water samples with a known hardness (e.g. from a lab reference), run them through the app, and record the blue score alongside the known ppm value. With 2+ points the app builds a linear curve to convert future blue scores into ppm.
        </Text>
      </View>

      {/* Add point form */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Add Calibration Point</Text>

        <Text style={styles.fieldLabel}>Blue Score (0–255)</Text>
        <TextInput
          style={styles.input}
          value={blueScore}
          onChangeText={setBlueScore}
          keyboardType="numeric"
          placeholder="e.g. 142"
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
          <Text style={styles.cardTitle}>
            Calibration Curve ({points.length} point{points.length !== 1 ? 's' : ''})
          </Text>
          {points.length > 0 && (
            <TouchableOpacity onPress={handleClearAll}>
              <Text style={styles.clearAllText}>Clear All</Text>
            </TouchableOpacity>
          )}
        </View>

        {points.length === 0 ? (
          <Text style={styles.emptyText}>No calibration points yet. Add at least 2 points for ppm readings.</Text>
        ) : (
          points.map((pt) => (
            <View key={pt.id} style={styles.pointRow}>
              <View style={styles.pointDot} />
              <View style={styles.pointInfo}>
                <Text style={styles.pointMain}>
                  Blue {pt.blueScore} → {pt.hardness} ppm
                </Text>
                {pt.label ? (
                  <Text style={styles.pointLabel}>{pt.label}</Text>
                ) : null}
                <Text style={styles.pointDate}>
                  {new Date(pt.createdAt).toLocaleDateString()}
                </Text>
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
            <Text style={styles.successText}>✓ Calibration active — ppm readings enabled.</Text>
          </View>
        )}
      </View>
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

  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20,
    marginBottom: 16, elevation: 2,
  },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 14 },

  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 4 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 10, fontSize: 15, color: '#1A237E', marginBottom: 14,
    borderWidth: 1, borderColor: '#E0E0E0',
  },

  addBtn: {
    backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginTop: 4,
  },
  addBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },

  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  clearAllText: { color: '#C62828', fontSize: 13 },

  emptyText: { color: '#78909C', fontSize: 13, textAlign: 'center', lineHeight: 19, paddingVertical: 8 },

  pointRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F5F5F5',
  },
  pointDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#1565C0', marginRight: 12 },
  pointInfo: { flex: 1 },
  pointMain: { fontSize: 14, color: '#1A237E', fontWeight: '600' },
  pointLabel: { fontSize: 12, color: '#546E7A', marginTop: 1 },
  pointDate: { fontSize: 11, color: '#90A4AE', marginTop: 1 },
  deleteBtn: { padding: 8 },
  deleteBtnText: { color: '#EF5350', fontSize: 16, fontWeight: 'bold' },

  warningBox: {
    backgroundColor: '#FFF8E1', borderRadius: 10, padding: 10,
    marginTop: 12, borderLeftWidth: 3, borderLeftColor: '#FFA000',
  },
  warningText: { color: '#E65100', fontSize: 12 },

  successBox: {
    backgroundColor: '#E8F5E9', borderRadius: 10, padding: 10,
    marginTop: 12, borderLeftWidth: 3, borderLeftColor: '#2E7D32',
  },
  successText: { color: '#1B5E20', fontSize: 12 },
});
