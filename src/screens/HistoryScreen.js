import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { loadHistory, clearHistory } from '../utils/calibration';

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
            Blue score: {item.blueScore} · Dominance: {item.blueDominance}%
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
        <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
          <Text style={styles.clearBtnText}>Clear History</Text>
        </TouchableOpacity>
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
              Run a test and tap "Save Result" to see it here.
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

  clearBtn: {
    alignSelf: 'flex-end', margin: 16, marginBottom: 0,
    paddingHorizontal: 14, paddingVertical: 6,
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
  itemDate: { color: '#90A4AE', fontSize: 11, marginTop: 2 },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { fontSize: 17, color: '#78909C', fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: '#90A4AE', marginTop: 8, textAlign: 'center', lineHeight: 19 },
});
