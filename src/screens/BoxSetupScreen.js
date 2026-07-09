import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, PanResponder, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { thumbUrl, postConfig, postBlank, getProbe, createCancelToken } from '../api/boxClient';

// 4:3 preview (QVGA). Overlays use normalized 0..1 coords mapped to this box.
const PREVIEW_W = 320;
const PREVIEW_H = 240;

// Target exposure band: ROI blue level should sit here (0-255 scale) so
// there's headroom before the 1% saturation gate trips, but with a strong
// enough signal that dark reads aren't drowned in sensor noise.
const TARGET_MIN_FRAC = 0.70;
const TARGET_MAX_FRAC = 0.85;

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

export default function BoxSetupScreen({ route, navigation }) {
  const ip = route.params.ip;
  const s0 = route.params.status?.settings || {};
  const hasPreview = !!route.params.status?.capabilities?.preview;

  const [roi, setRoi] = useState(s0.roi || { x: 0.42, y: 0.30, w: 0.16, h: 0.40 });
  const [patchA, setPatchA] = useState(s0.patchA || { x: 0.14, y: 0.44, w: 0.10, h: 0.12 });
  const [patchB, setPatchB] = useState(s0.patchB || { x: 0.76, y: 0.44, w: 0.10, h: 0.12 });
  const [thumb, setThumb] = useState(thumbUrl(ip));
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState('roi');

  const [aecValue, setAecValue] = useState(s0.aec_value ?? 300);
  const [agcGain, setAgcGain] = useState(s0.agc_gain ?? 0);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const [blanking, setBlanking] = useState(false);

  // Refresh the live preview periodically (only meaningful when preview exists)
  useEffect(() => {
    if (!hasPreview) return;
    const t = setInterval(() => setThumb(thumbUrl(ip)), 2500);
    return () => clearInterval(t);
  }, [ip, hasPreview]);

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
      await postConfig(ip, { roi, patchA, patchB, aec_value: aecValue, agc_gain: agcGain });
      Alert.alert('Saved ✓', 'Settings sent to the box.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Save failed', e.message || 'Could not reach the box.');
    } finally {
      setSaving(false);
    }
  };

  // Push the current exposure/gain to the box, then probe so the live
  // saturation% / ROI level% reflect the value just tried.
  const testExposure = async () => {
    setProbing(true);
    try {
      await postConfig(ip, { roi, patchA, patchB, aec_value: aecValue, agc_gain: agcGain });
      const p = await getProbe(ip);
      setProbeResult(p);
    } catch (e) {
      Alert.alert('Probe failed', e.message || 'Could not reach the box.');
    } finally {
      setProbing(false);
    }
  };

  const nudgeExposure = (dAec, dGain) => {
    setAecValue((v) => Math.max(0, Math.min(1200, v + dAec)));
    setAgcGain((v) => Math.max(0, Math.min(30, v + dGain)));
  };

  const captureBlank = () => {
    Alert.alert(
      'Capture blank',
      'Make sure the reagent BLANK (zero-hardness sample) is in place, panel is on, nothing else in the beam. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Capture', onPress: doCaptureBlank },
      ]
    );
  };

  const doCaptureBlank = async () => {
    setBlanking(true);
    const token = createCancelToken();
    try {
      const r = await postBlank(ip, { signal: token.signal });
      Alert.alert('Blank captured ✓', `ROI net blue ${r.roi_net?.b?.toFixed?.(1) ?? '—'}.`);
    } catch (e) {
      const title = e.kind === 'gate' ? 'Blank rejected' : e.kind === 'http' ? 'Firmware mismatch' : 'Box unreachable';
      Alert.alert(title, e.message || 'Blank capture failed.');
    } finally {
      setBlanking(false);
    }
  };

  const roiLevelFrac = probeResult ? probeResult.roi.b / 255 : null;
  const inBand = roiLevelFrac !== null && roiLevelFrac >= TARGET_MIN_FRAC && roiLevelFrac <= TARGET_MAX_FRAC;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 30 }}>
      {hasPreview ? (
        <>
          <Text style={styles.hint}>Drag the boxes onto the bottle (ROI) and bare lit panel (patches).</Text>
          <View style={styles.previewWrap}>
            <View style={{ width: PREVIEW_W, height: PREVIEW_H }}>
              <Image source={{ uri: thumb }} style={styles.preview} resizeMode="cover" />
              <DraggableRect rect={roi} color="#29B6F6" label="ROI" onChange={setRoi} boxW={PREVIEW_W} boxH={PREVIEW_H} />
              <DraggableRect rect={patchA} color="#FFEB3B" label="A" onChange={setPatchA} boxW={PREVIEW_W} boxH={PREVIEW_H} />
              <DraggableRect rect={patchB} color="#FFEB3B" label="B" onChange={setPatchB} boxW={PREVIEW_W} boxH={PREVIEW_H} />
            </View>
          </View>

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
        </>
      ) : (
        <View style={styles.noPreviewBox}>
          <Text style={styles.noPreviewText}>
            This device has no camera preview (capabilities.preview = false). Region of interest is
            fixed in firmware — only exposure/gain and the blank capture apply here.
          </Text>
        </View>
      )}

      {/* Exposure / gain */}
      <View style={styles.exposureCard}>
        <Text style={styles.exposureTitle}>Exposure / gain</Text>

        <View style={styles.stepperRow}>
          <Text style={styles.stepperLabel}>Exposure (aec_value): {aecValue}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => nudgeExposure(-20, 0)}><Text style={styles.stepBtnText}>−</Text></TouchableOpacity>
          <TouchableOpacity style={styles.stepBtn} onPress={() => nudgeExposure(20, 0)}><Text style={styles.stepBtnText}>+</Text></TouchableOpacity>
        </View>
        <View style={styles.stepperRow}>
          <Text style={styles.stepperLabel}>Gain (agc_gain): {agcGain}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => nudgeExposure(0, -1)}><Text style={styles.stepBtnText}>−</Text></TouchableOpacity>
          <TouchableOpacity style={styles.stepBtn} onPress={() => nudgeExposure(0, 1)}><Text style={styles.stepBtnText}>+</Text></TouchableOpacity>
        </View>

        <TouchableOpacity style={[styles.testBtn, probing && styles.btnDisabled]} onPress={testExposure} disabled={probing}>
          {probing ? <ActivityIndicator color="#FFF" /> : <Text style={styles.testBtnText}>🔎 Test (save + probe)</Text>}
        </TouchableOpacity>

        {probeResult && (
          <View style={styles.probeBox}>
            <Text style={styles.probeLine}>
              ROI level: {probeResult.roi.b.toFixed(0)} / 255 ({(roiLevelFrac * 100).toFixed(0)}%)
              {inBand ? '  ✓ in target band' : roiLevelFrac < TARGET_MIN_FRAC ? '  ↓ too dark, increase exposure/gain' : '  ↑ too bright, reduce exposure/gain'}
            </Text>
            <View style={styles.bandBar}>
              <View style={[styles.bandTarget, { left: `${TARGET_MIN_FRAC * 100}%`, width: `${(TARGET_MAX_FRAC - TARGET_MIN_FRAC) * 100}%` }]} />
              <View style={[styles.bandMarker, { left: `${Math.min(100, roiLevelFrac * 100)}%` }]} />
            </View>
            <Text style={[styles.probeLine, {
              color: probeResult.roi_saturation_pct > 1 ? '#C62828' : '#2E7D32', marginTop: 8,
            }]}>
              ROI saturation: {probeResult.roi_saturation_pct.toFixed(2)}%
              {probeResult.roi_saturation_pct > 1 ? '  ⚠ over 1% limit — measurements will fail' : '  ✓'}
            </Text>
          </View>
        )}
      </View>

      {/* Capture blank */}
      <TouchableOpacity style={[styles.blankBtn, blanking && styles.btnDisabled]} onPress={captureBlank} disabled={blanking}>
        {blanking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.blankBtnText}>🧪 Capture Blank</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={[styles.saveBtn, saving && styles.btnDisabled]} onPress={save} disabled={saving}>
        {saving ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveBtnText}>💾 Save to box</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1A1A2E', padding: 16 },
  hint: { color: '#BBDEFB', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  previewWrap: { alignItems: 'center', marginBottom: 16 },
  preview: { width: PREVIEW_W, height: PREVIEW_H, borderRadius: 8, backgroundColor: '#000' },

  noPreviewBox: {
    backgroundColor: '#232640', borderRadius: 12, padding: 16, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#546E7A',
  },
  noPreviewText: { color: '#CFD8DC', fontSize: 13, lineHeight: 19 },

  selRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginBottom: 10 },
  selBtn: { borderWidth: 1, borderColor: '#546E7A', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 14 },
  selBtnActive: { backgroundColor: '#1565C0', borderColor: '#1565C0' },
  selBtnText: { color: '#90CAF9', fontSize: 12, fontWeight: '600' },
  selBtnTextActive: { color: '#FFF' },

  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginBottom: 20, flexWrap: 'wrap' },
  sizeLabel: { color: '#CFD8DC', fontSize: 12, marginRight: 4 },
  sizeBtn: { backgroundColor: '#37474F', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  sizeBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },

  exposureCard: { backgroundColor: '#232640', borderRadius: 14, padding: 16, marginBottom: 16 },
  exposureTitle: { color: '#FFF', fontSize: 14, fontWeight: 'bold', marginBottom: 12 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  stepperLabel: { color: '#CFD8DC', fontSize: 13, flex: 1 },
  stepBtn: { width: 40, height: 36, borderRadius: 8, backgroundColor: '#1565C0', justifyContent: 'center', alignItems: 'center' },
  stepBtnText: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },

  testBtn: { backgroundColor: '#6A1B9A', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 6 },
  testBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },

  probeBox: { marginTop: 14, padding: 12, backgroundColor: '#12141F', borderRadius: 10 },
  probeLine: { color: '#CFD8DC', fontSize: 12 },
  bandBar: { height: 10, backgroundColor: '#37474F', borderRadius: 5, marginTop: 8, marginBottom: 4, overflow: 'visible' },
  bandTarget: { position: 'absolute', height: 10, backgroundColor: 'rgba(46,125,50,0.5)', borderRadius: 5 },
  bandMarker: { position: 'absolute', width: 3, height: 14, top: -2, backgroundColor: '#FFEB3B', borderRadius: 2 },

  blankBtn: { backgroundColor: '#00838F', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginBottom: 12 },
  blankBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  saveBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
  btnDisabled: { backgroundColor: '#78909C' },
});
