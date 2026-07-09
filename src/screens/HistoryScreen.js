import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Share,
} from 'react-native';
import { loadHistory, clearHistory } from '../utils/calibration';

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  ['testedAt', (i) => i.testedAt],
  ['boxId', (i) => i.boxId],
  ['fwVersion', (i) => i.fwVersion],
  ['label', (i) => i.label],
  ['hardnessPPM', (i) => i.hardnessPPM],
  ['absorbance', (i) => i.absorbance],
  ['absorbanceR', (i) => i.absorbanceR],
  ['absorbanceG', (i) => i.absorbanceG],
  ['absorbanceStdDev', (i) => i.absorbanceStdDev],
  ['blueScore', (i) => i.blueScore],
  ['blueDominance', (i) => i.blueDominance],
  ['frameCount', (i) => i.frameCount],
  ['rejectedFrames', (i) => i.rejectedFrames],
  ['satFraction', (i) => i.satFraction],
  ['blankAgeS', (i) => i.blankAgeS],
  ['deviceCalibrated', (i) => i.deviceCalibrated],
  ['deviceFactorM', (i) => i.deviceFactor?.m],
  ['deviceFactorC', (i) => i.deviceFactor?.c],
  ['masterCurveHash', (i) => i.masterCurveHash],
  ['appVersion', (i) => i.appVersion],
];

function toCsv(history) {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = history.map((item) =>
    CSV_COLUMNS.map(([, get]) => csvEscape(get(item))).join(',')
  );
  return [header, ...rows].join('\n');
}

export default function HistoryScreen({ navigation }) {
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', loadData);
    return unsubscribe;
  }, [navigation]);

  const loadData = async () => {
    const data = await loadHistory();
    setHistory(data);
  };

  const handleClear = () => {
    Alert.alert('Clear History', 'Delete all test history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearHistory();
          setHistory([]);
        },
      },
    ]);
  };

  const handleExportCsv = async () => {
    if (history.length === 0) {
      Alert.alert('Nothing to export', 'Run a test and save it first.');
      return;
    }
    try {
      await Share.share({ message: toCsv(history), title: 'Water hardness history.csv' });
    } catch {}
  };

  const renderItem = ({ item }) => {
    const labelColor = getLabelColor(item.label);
    return (
      <View style={styles.item}>
        <View style={[styles.colorDot, { backgroundColor: `rgb(${item.r},${item.g},${item.b})` }]} />
        <View style={styles.itemInfo}>
          <View style={styles.itemRow}>
            <Text style={[styles.itemLabel, { color: labelColor }]}>{item.label || 'Unknown'}</Text>
            {item.hardnessPPM !== null && item.hardnessPPM !== undefined ? (
              <Text style={styles.itemPPM}>{item.hardnessPPM} ppm</Text>
            ) : null}
          </View>
          <Text style={styles.itemSub}>
            {typeof item.absorbance === 'number' ? `A_blue ${item.absorbance.toFixed(3)}` : `Blue ${item.blueScore}`}
            {item.deviceCalibrated ? ' · calibrated ✓' : ''}
          </Text>
          <Text style={styles.itemMeta}>
            {item.boxId ? `box ${item.boxId}` : ''}{item.fwVersion ? ` · fw ${item.fwVersion}` : ''}
          </Text>
          <Text style={styles.itemDate}>
            {new Date(item.testedAt).toLocaleString()}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {history.length > 0 && (
        <View style={styles.toolbar}>
          <TouchableOpacity style={styles.csvBtn} onPress={handleExportCsv}>
            <Text style={styles.csvBtnText}>⬇ Export CSV</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
            <Text style={styles.clearBtnText}>Clear History</Text>
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No tests recorded yet.</Text>
            <Text style={styles.emptySubtext}>
              Run a measurement and tap "Save" to see it here.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function getLabelColor(label) {
  switch (label) {
    case 'Soft': return '#0288D1';
    case 'Moderately Hard': return '#7B1FA2';
    case 'Hard': return '#8E24AA';
    case 'Very Hard': return '#C62828';
    default: return '#546E7A';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  list: { padding: 16, paddingBottom: 32 },

  toolbar: { flexDirection: 'row', gap: 10, margin: 16, marginBottom: 0 },
  csvBtn: {
    flex: 1, paddingVertical: 8, alignItems: 'center',
    backgroundColor: '#1565C0', borderRadius: 8,
  },
  csvBtnText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  clearBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: '#FFEBEE', borderRadius: 8,
  },
  clearBtnText: { color: '#C62828', fontSize: 13 },

  item: {
    backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16,
    marginBottom: 10, flexDirection: 'row', alignItems: 'center', elevation: 1,
  },
  colorDot: { width: 44, height: 44, borderRadius: 22, marginRight: 14, elevation: 1 },
  itemInfo: { flex: 1 },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  itemLabel: { fontSize: 15, fontWeight: 'bold' },
  itemPPM: { fontSize: 15, fontWeight: 'bold', color: '#1565C0' },
  itemSub: { color: '#546E7A', fontSize: 12, marginTop: 3 },
  itemMeta: { color: '#90A4AE', fontSize: 11, marginTop: 1 },
  itemDate: { color: '#90A4AE', fontSize: 11, marginTop: 2 },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { fontSize: 17, color: '#78909C', fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: '#90A4AE', marginTop: 8, textAlign: 'center', lineHeight: 19 },
});
