import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, PanResponder, Alert, ActivityIndicator,
} from 'react-native';
import { thumbUrl, postConfig, getStatus } from '../api/boxClient';

// 4:3 preview (QVGA). Overlays use normalized 0..1 coords mapped to this box.
const PREVIEW_W = 320;
const PREVIEW_H = 240;

function DraggableRect({ rect, color, label, onChange, boxW, boxH }) {
  const start = useRef({ x: 0, y: 0 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { start.current = { x: rect.x, y: rect.y }; },
      onPanResponderMove: (_e, g) => {
        const nx = Math.min(1 - rect.w, Math.max(0, start.current.x + g.dx / boxW));
        const ny = Math.min(1 - rect.h, Math.max(0, start.current.y + g.dy / boxH));
        onChange({ ...rect, x: nx, y: ny });
      },
    })
  ).current;

  return (
    <View
      {...pan.panHandlers}
      style={{
        position: 'absolute',
        left: rect.x * boxW, top: rect.y * boxH,
        width: rect.w * boxW, height: rect.h * boxH,
        borderWidth: 2, borderColor: color, borderRadius: 4,
        backgroundColor: color + '22',
        justifyContent: 'flex-start', alignItems: 'flex-start',
      }}
    >
      <Text style={{ color, fontSize: 10, fontWeight: 'bold', textShadowColor: '#000', textShadowRadius: 3 }}>
        {label}
      </Text>
    </View>
  );
}

export default function DeviceSetupScreen({ route, navigation }) {
  const ip = route.params.ip;
  const s0 = route.params.status?.settings || {};
  const [roi, setRoi] = useState(s0.roi || { x: 0.42, y: 0.30, w: 0.16, h: 0.40 });
  const [patchA, setPatchA] = useState(s0.patchA || { x: 0.14, y: 0.44, w: 0.10, h: 0.12 });
  const [patchB, setPatchB] = useState(s0.patchB || { x: 0.76, y: 0.44, w: 0.10, h: 0.12 });
  const [thumb, setThumb] = useState(thumbUrl(ip));
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState('roi'); // which rect the size steppers act on

  // Refresh the preview periodically
  useEffect(() => {
    const t = setInterval(() => setThumb(thumbUrl(ip)), 2500);
    return () => clearInterval(t);
  }, [ip]);

  const current = sel === 'roi' ? roi : sel === 'patchA' ? patchA : patchB;
  const setCurrent = sel === 'roi' ? setRoi : sel === 'patchA' ? setPatchA : setPatchB;
  const resize = (dw, dh) => {
    setCurrent((r) => ({
      ...r,
      w: Math.min(1 - r.x, Math.max(0.03, r.w + dw)),
      h: Math.min(1 - r.y, Math.max(0.03, r.h + dh)),
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await postConfig(ip, { roi, patchA, patchB });
      Alert.alert('Saved ✓', 'ROI and patches sent to the box.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Save failed', e.message || 'Could not reach the box.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>Drag the boxes onto the bottle (ROI) and bare lit panel (patches).</Text>

      <View style={styles.previewWrap}>
        <View style={{ width: PREVIEW_W, height: PREVIEW_H }}>
          <Image source={{ uri: thumb }} style={styles.preview} resizeMode="cover" />
          <DraggableRect rect={roi} color="#29B6F6" label="ROI" onChange={setRoi} boxW={PREVIEW_W} boxH={PREVIEW_H} />
          <DraggableRect rect={patchA} color="#FFEB3B" label="A" onChange={setPatchA} boxW={PREVIEW_W} boxH={PREVIEW_H} />
          <DraggableRect rect={patchB} color="#FFEB3B" label="B" onChange={setPatchB} boxW={PREVIEW_W} boxH={PREVIEW_H} />
        </View>
      </View>

      {/* Which rect the size steppers control */}
      <View style={styles.selRow}>
        {[['roi', 'ROI'], ['patchA', 'Patch A'], ['patchB', 'Patch B']].map(([k, lbl]) => (
          <TouchableOpacity key={k} style={[styles.selBtn, sel === k && styles.selBtnActive]} onPress={() => setSel(k)}>
            <Text style={[styles.selBtnText, sel === k && styles.selBtnTextActive]}>{lbl}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.sizeRow}>
        <Text style={styles.sizeLabel}>Size {sel}: {(current.w * 100).toFixed(0)}×{(current.h * 100).toFixed(0)}%</Text>
        <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(-0.02, 0)}><Text style={styles.sizeBtnText}>W−</Text></TouchableOpacity>
        <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0.02, 0)}><Text style={styles.sizeBtnText}>W+</Text></TouchableOpacity>
        <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0, -0.02)}><Text style={styles.sizeBtnText}>H−</Text></TouchableOpacity>
        <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0, 0.02)}><Text style={styles.sizeBtnText}>H+</Text></TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.saveBtn, saving && styles.btnDisabled]} onPress={save} disabled={saving}>
        {saving ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveBtnText}>💾 Save to box</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1A1A2E', padding: 16 },
  hint: { color: '#BBDEFB', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  previewWrap: { alignItems: 'center', marginBottom: 16 },
  preview: { width: PREVIEW_W, height: PREVIEW_H, borderRadius: 8, backgroundColor: '#000' },

  selRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginBottom: 10 },
  selBtn: { borderWidth: 1, borderColor: '#546E7A', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 14 },
  selBtnActive: { backgroundColor: '#1565C0', borderColor: '#1565C0' },
  selBtnText: { color: '#90CAF9', fontSize: 12, fontWeight: '600' },
  selBtnTextActive: { color: '#FFF' },

  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginBottom: 18, flexWrap: 'wrap' },
  sizeLabel: { color: '#CFD8DC', fontSize: 12, marginRight: 4 },
  sizeBtn: { backgroundColor: '#37474F', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  sizeBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },

  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  saveBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
  btnDisabled: { backgroundColor: '#78909C' },
});
