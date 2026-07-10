import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

// The readiness checklist card. Two modes:
//  - onboarding=true  : full 4-step first-launch checklist (bigger, numbered)
//  - onboarding=false : compact status card, only expanding on problems
// Both render the SAME readiness items so they can never tell different
// stories. `onFix(id)` is supplied by the host screen (navigation/actions).
export default function ReadinessCard({ readiness, onFix, onboarding = false }) {
  const { items, ready } = readiness;

  if (!onboarding && ready) {
    return (
      <View style={[styles.card, styles.cardReady]}>
        <Text style={styles.readyText}>✓ Ready to measure</Text>
        <Text style={styles.readySub}>
          {items.find((i) => i.id === 'blank')?.detail}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {onboarding ? 'Get set up' : 'Before you measure'}
      </Text>
      {onboarding && (
        <Text style={styles.subtitle}>
          Four steps from unboxing to your first reading:
        </Text>
      )}
      {items.map((item, idx) => (
        <View key={item.id} style={styles.row}>
          <Text style={[styles.icon, { color: item.ok ? '#2E7D32' : '#B0BEC5' }]}>
            {item.ok ? '✓' : onboarding ? `${idx + 1}` : '○'}
          </Text>
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, item.ok && styles.rowTitleDone]}>{item.title}</Text>
            <Text style={styles.rowDetail}>{item.detail}</Text>
          </View>
          {!item.ok && item.fixLabel && (
            <TouchableOpacity style={styles.fixBtn} onPress={() => onFix(item.id)}>
              <Text style={styles.fixBtnText}>{item.fixLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  cardReady: { borderLeftWidth: 4, borderLeftColor: '#2E7D32', paddingVertical: 14 },
  readyText: { color: '#2E7D32', fontSize: 15, fontWeight: 'bold' },
  readySub: { color: '#78909C', fontSize: 12, marginTop: 3 },

  title: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 6 },
  subtitle: { color: '#546E7A', fontSize: 13, marginBottom: 10 },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  icon: { width: 26, fontSize: 15, fontWeight: 'bold' },
  rowBody: { flex: 1 },
  rowTitle: { color: '#1A237E', fontSize: 14, fontWeight: '600' },
  rowTitleDone: { color: '#78909C' },
  rowDetail: { color: '#90A4AE', fontSize: 12, marginTop: 1 },
  fixBtn: { backgroundColor: '#1565C0', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, marginLeft: 8 },
  fixBtnText: { color: '#FFF', fontSize: 12, fontWeight: '700' },
});
