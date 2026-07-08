import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
} from 'react-native';
import { loadCalibrationPoints, loadHistory } from '../utils/calibration';

export default function HomeScreen({ navigation }) {
  const [calibrationCount, setCalibrationCount] = useState(0);
  const [testCount, setTestCount] = useState(0);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', async () => {
      const cal = await loadCalibrationPoints();
      const hist = await loadHistory();
      setCalibrationCount(cal.length);
      setTestCount(hist.length);
    });
    return unsubscribe;
  }, [navigation]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.dropletIcon}>
          <Text style={styles.dropletText}>💧</Text>
        </View>
        <Text style={styles.title}>Water Hardness Tester</Text>
        <Text style={styles.subtitle}>
          Measure water hardness by analyzing blue colour intensity of your reagent solution
        </Text>
      </View>

      {/* How it works */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>How It Works</Text>
        <View style={styles.step}>
          <View style={styles.stepNum}><Text style={styles.stepNumText}>1</Text></View>
          <Text style={styles.stepText}>Add reagent to water sample — solution turns blue</Text>
        </View>
        <View style={styles.step}>
          <View style={styles.stepNum}><Text style={styles.stepNumText}>2</Text></View>
          <Text style={styles.stepText}>Capture photo of the test tube</Text>
        </View>
        <View style={styles.step}>
          <View style={styles.stepNum}><Text style={styles.stepNumText}>3</Text></View>
          <Text style={styles.stepText}>Select the liquid region in the image</Text>
        </View>
        <View style={styles.step}>
          <View style={styles.stepNum}><Text style={styles.stepNumText}>4</Text></View>
          <Text style={styles.stepText}>Get blue intensity score and hardness reading</Text>
        </View>
      </View>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>{testCount}</Text>
          <Text style={styles.statLabel}>Tests Done</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>{calibrationCount}</Text>
          <Text style={styles.statLabel}>Cal. Points</Text>
        </View>
      </View>

      {/* Main action */}
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => navigation.navigate('Camera')}
        activeOpacity={0.85}
      >
        <Text style={styles.primaryButtonText}>📷  Start New Test</Text>
      </TouchableOpacity>

      {/* Secondary actions */}
      <View style={styles.secondaryRow}>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => navigation.navigate('Calibration')}
        >
          <Text style={styles.secondaryButtonText}>⚙️  Calibration</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => navigation.navigate('History')}
        >
          <Text style={styles.secondaryButtonText}>📋  History</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => navigation.navigate('Settings')}
        >
          <Text style={styles.secondaryButtonText}>🔧  Settings</Text>
        </TouchableOpacity>
      </View>

      {/* Tip */}
      <View style={styles.tipBox}>
        <Text style={styles.tipTitle}>📌 Tip for accurate results</Text>
        <Text style={styles.tipText}>
          Photograph the test tube against a plain white or light-coloured background. Hold the tube steady and use good lighting. Avoid direct sunlight glare on the glass.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },

  header: { alignItems: 'center', marginBottom: 24 },
  dropletIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#1565C0', justifyContent: 'center', alignItems: 'center',
    marginBottom: 12, elevation: 4,
  },
  dropletText: { fontSize: 36 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1565C0', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#546E7A', textAlign: 'center', marginTop: 6, lineHeight: 20 },

  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20,
    marginBottom: 16, elevation: 2,
  },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#1565C0', marginBottom: 14 },
  step: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  stepNum: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: '#1565C0',
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  stepNumText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },
  stepText: { flex: 1, fontSize: 14, color: '#37474F', lineHeight: 20 },

  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statCard: {
    flex: 1, backgroundColor: '#1565C0', borderRadius: 16,
    padding: 16, alignItems: 'center', elevation: 2,
  },
  statNum: { fontSize: 28, fontWeight: 'bold', color: '#FFFFFF' },
  statLabel: { fontSize: 12, color: '#BBDEFB', marginTop: 4 },

  primaryButton: {
    backgroundColor: '#1565C0', borderRadius: 16, paddingVertical: 18,
    alignItems: 'center', marginBottom: 12, elevation: 4,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },

  secondaryRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  secondaryButton: {
    flex: 1, backgroundColor: '#FFFFFF', borderRadius: 16, paddingVertical: 14,
    alignItems: 'center', elevation: 2, borderWidth: 1, borderColor: '#BBDEFB',
  },
  secondaryButtonText: { color: '#1565C0', fontSize: 14, fontWeight: '600' },

  tipBox: {
    backgroundColor: '#FFF9C4', borderRadius: 16, padding: 16,
    borderLeftWidth: 4, borderLeftColor: '#F9A825',
  },
  tipTitle: { fontSize: 13, fontWeight: 'bold', color: '#F57F17', marginBottom: 6 },
  tipText: { fontSize: 13, color: '#5D4037', lineHeight: 19 },
});
