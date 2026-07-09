import React, { useState, useEffect } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { getRequestLog, clearRequestLog } from '../api/boxClient';

// Long-press the connection status card to open this. Shows the last N HTTP
// requests the app made to the box: method, path, status, kind, RTT, and a
// preview of the response body — the fastest way to see exactly what
// happened on the wire without a laptop/proxy.
export default function DebugPanel({ visible, onClose }) {
  const [log, setLog] = useState([]);

  useEffect(() => {
    if (visible) setLog(getRequestLog());
  }, [visible]);

  const refresh = () => setLog(getRequestLog());
  const clear = () => { clearRequestLog(); setLog([]); };

  const kindColor = (kind) =>
    kind === null ? '#2E7D32' // success
    : kind === 'network' ? '#EF6C00'
    : kind === 'http' ? '#C62828'
    : kind === 'gate' ? '#6A1B9A'
    : kind === 'cancelled' ? '#546E7A'
    : '#37474F';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Debug: last requests</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.closeBtn}>✕</Text></TouchableOpacity>
          </View>

          <View style={styles.toolbar}>
            <TouchableOpacity style={styles.toolBtn} onPress={refresh}>
              <Text style={styles.toolBtnText}>↻ Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.toolBtn} onPress={clear}>
              <Text style={styles.toolBtnText}>Clear</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list}>
            {log.length === 0 && (
              <Text style={styles.emptyText}>No requests logged yet.</Text>
            )}
            {log.map((r, i) => (
              <View key={i} style={styles.row}>
                <View style={styles.rowTop}>
                  <Text style={[styles.method, { color: kindColor(r.kind) }]}>
                    {r.method} {r.path}
                  </Text>
                  <Text style={[styles.status, { color: kindColor(r.kind) }]}>
                    {r.status ?? '—'} {r.kind ? `(${r.kind})` : ''}
                  </Text>
                </View>
                <Text style={styles.meta}>
                  {new Date(r.startedAt).toLocaleTimeString()} · {r.rttMs}ms
                </Text>
                {!!r.bodyPreview && (
                  <Text style={styles.body} numberOfLines={4}>{r.bodyPreview}</Text>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#12141A', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', paddingBottom: 20 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16, borderBottomWidth: 1, borderBottomColor: '#2A2D35',
  },
  title: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  closeBtn: { color: '#90A4AE', fontSize: 20 },
  toolbar: { flexDirection: 'row', gap: 10, padding: 12 },
  toolBtn: { backgroundColor: '#1565C0', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  toolBtnText: { color: '#FFF', fontSize: 12, fontWeight: '600' },
  list: { paddingHorizontal: 16 },
  emptyText: { color: '#607D8B', fontSize: 13, textAlign: 'center', paddingVertical: 30 },
  row: { borderBottomWidth: 1, borderBottomColor: '#22252C', paddingVertical: 10 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between' },
  method: { fontSize: 13, fontWeight: 'bold' },
  status: { fontSize: 13, fontWeight: 'bold' },
  meta: { color: '#607D8B', fontSize: 11, marginTop: 2 },
  body: { color: '#B0BEC5', fontSize: 11, marginTop: 4, fontFamily: 'monospace' },
});
