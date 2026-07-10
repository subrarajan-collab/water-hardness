import React, { useEffect, useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, Share, Modal, ScrollView,
} from 'react-native';
import { loadHistory, clearHistory } from '../utils/calibration';
import { getHardnessLabel } from '../utils/colorAnalysis';
import ResultPanel from '../components/ResultPanel';

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  ['testedAt', (i) => i.testedAt],
  ['sampleName', (i) => i.sampleName],
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
  const rows = history.map((item) => CSV_COLUMNS.map(([, get]) => csvEscape(get(item))).join(','));
  return [header, ...rows].join('\n');
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

export default function ResultsScreen() {
  const [history, setHistory] = useState([]);
  const [boxFilter, setBoxFilter] = useState('all');
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => setHistory(await loadHistory());

  const boxIds = useMemo(() => {
    const s = new Set(history.map((h) => h.boxId).filter(Boolean));
    return ['all', ...Array.from(s)];
  }, [history]);

  const filtered = boxFilter === 'all' ? history : history.filter((h) => h.boxId === boxFilter);

  const handleClear = () => {
    Alert.alert('Clear History', 'Delete all test history?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await clearHistory(); setHistory([]); } },
    ]);
  };

  const handleExportCsv = async () => {
    if (filtered.length === 0) {
      Alert.alert('Nothing to export', 'Run a measurement and save it first.');
      return;
    }
    try {
      await Share.share({ message: toCsv(filtered), title: 'Water hardness history.csv' });
    } catch {}
  };

  // Reconstruct a ResultPanel-compatible object from a stored history entry.
  const asResult = (item) => ({
    r: item.r, g: item.g, b: item.b,
    blueScore: item.blueScore, blueDominance: item.blueDominance,
    absorbance: item.absorbance, absorbanceR: item.absorbanceR, absorbanceG: item.absorbanceG,
    absorbanceStdDev: item.absorbanceStdDev,
    frameCount: item.frameCount, rejectedFrames: item.rejectedFrames,
    satFraction: item.satFraction, darkLevel: item.darkLevel, blankAgeS: item.blankAgeS,
    warnings: item.deviceWarnings,
  });

  const renderItem = ({ item }) => {
    const labelColor = getLabelColor(item.label);
    return (
      <TouchableOpacity style={styles.item} onPress={() => setDetail(item)} activeOpacity={0.8}>
        <View style={[styles.colorDot, { backgroundColor: `rgb(${item.r},${item.g},${item.b})` }]} />
        <View style={styles.itemInfo}>
          <View style={styles.itemRow}>
            <Text style={[styles.itemLabel, { color: labelColor }]}>{item.sampleName || item.label || 'Unknown'}</Text>
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
          <Text style={styles.itemDate}>{new Date(item.testedAt).toLocaleString()}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {boxIds.length > 2 && (
        <View style={styles.filterRow}>
          {boxIds.map((id) => (
            <TouchableOpacity
              key={id}
              style={[styles.filterChip, boxFilter === id && styles.filterChipActive]}
              onPress={() => setBoxFilter(id)}
            >
              <Text style={[styles.filterChipText, boxFilter === id && styles.filterChipTextActive]}>
                {id === 'all' ? 'All boxes' : id}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

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
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No tests recorded yet.</Text>
            <Text style={styles.emptySubtext}>Run a measurement and tap "Save" to see it here.</Text>
          </View>
        }
      />

      <Modal visible={!!detail} animationType="slide" onRequestClose={() => setDetail(null)}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{detail?.sampleName || detail?.label || 'Result'}</Text>
          <TouchableOpacity onPress={() => setDetail(null)}><Text style={styles.modalClose}>✕</Text></TouchableOpacity>
        </View>
        <ScrollView style={styles.modalBody} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          {detail && (
            <ResultPanel
              result={asResult(detail)}
              hardnessPPM={detail.hardnessPPM}
              label={getHardnessLabel(detail.blueDominance)}
              deviceCalibrated={detail.deviceCalibrated}
              thumbUri={null}
            />
          )}
          {detail && (
            <View style={styles.metaCard}>
              <Text style={styles.metaCardTitle}>Traceability</Text>
              <Text style={styles.metaCardText}>
                box {detail.boxId || '—'} · fw {detail.fwVersion || '—'}{'\n'}
                master curve hash {detail.masterCurveHash || '—'}{'\n'}
                app v{detail.appVersion || '—'}{'\n'}
                {new Date(detail.testedAt).toLocaleString()}
              </Text>
            </View>
          )}
        </ScrollView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  list: { padding: 16, paddingBottom: 32 },

  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, margin: 16, marginBottom: 0 },
  filterChip: { borderWidth: 1, borderColor: '#BBDEFB', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 14, backgroundColor: '#FFF' },
  filterChipActive: { backgroundColor: '#1565C0', borderColor: '#1565C0' },
  filterChipText: { color: '#1565C0', fontSize: 12, fontWeight: '600' },
  filterChipTextActive: { color: '#FFF' },

  toolbar: { flexDirection: 'row', gap: 10, margin: 16, marginBottom: 0 },
  csvBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: '#1565C0', borderRadius: 8 },
  csvBtnText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  clearBtn: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#FFEBEE', borderRadius: 8 },
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

  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, paddingTop: 50, backgroundColor: '#1565C0',
  },
  modalTitle: { color: '#FFF', fontSize: 17, fontWeight: 'bold', flex: 1 },
  modalClose: { color: '#FFF', fontSize: 20, paddingLeft: 16 },
  modalBody: { flex: 1, backgroundColor: '#E3F2FD' },

  metaCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 16, elevation: 2 },
  metaCardTitle: { fontSize: 13, fontWeight: 'bold', color: '#546E7A', marginBottom: 6 },
  metaCardText: { color: '#78909C', fontSize: 12, lineHeight: 18 },
});
