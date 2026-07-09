import React, { useState, useEffect, useRef } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';

// Full-screen overlay shown while a /measure or /blank sequence runs on the
// box (~25 s). The box gives no progress callbacks — it's one synchronous
// HTTP response — so progress here is purely elapsed wall-clock time against
// the known approximate duration. The Cancel button calls the caller's
// cancel() (an AbortController from api/boxClient.createCancelToken()).
export default function MeasureProgress({ visible, label = 'Measuring…', estimateS = 25, onCancel }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);

  useEffect(() => {
    if (!visible) { setElapsed(0); startRef.current = null; return; }
    startRef.current = Date.now();
    const t = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000);
    }, 200);
    return () => clearInterval(t);
  }, [visible]);

  if (!visible) return null;

  const progress = Math.min(1, elapsed / estimateS);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <ActivityIndicator size="large" color="#1565C0" />
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.elapsed}>{elapsed.toFixed(1)}s{estimateS ? ` / ~${estimateS}s` : ''}</Text>

          <View style={styles.barBg}>
            <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
          </View>

          {onCancel && (
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center' },
  card: { backgroundColor: '#FFF', borderRadius: 20, padding: 28, width: '80%', alignItems: 'center', elevation: 6 },
  label: { marginTop: 16, fontSize: 16, fontWeight: 'bold', color: '#1565C0', textAlign: 'center' },
  elapsed: { marginTop: 6, fontSize: 13, color: '#78909C' },
  barBg: { width: '100%', height: 6, borderRadius: 3, backgroundColor: '#E3F2FD', marginTop: 16, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#1565C0', borderRadius: 3 },
  cancelBtn: { marginTop: 20, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10, borderWidth: 1, borderColor: '#C62828' },
  cancelBtnText: { color: '#C62828', fontWeight: '600', fontSize: 14 },
});
