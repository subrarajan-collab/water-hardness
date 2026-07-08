import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, Dimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImageManipulator from 'expo-image-manipulator';
import { analyzeColumnProfile } from '../utils/colorAnalysis';
import { loadLayout, saveLayout, resetLayout, DEFAULT_LAYOUT } from '../utils/layoutConfig';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const PATCH = 72;
const WATER_W = Math.round(SCREEN_W * 0.16);

// Auto-placement constraints (fractions of screen width)
const MIN_OFFSET = 0.11;  // stay clear of the bottle (~±8%) with a gap
const MAX_OFFSET = 0.38;

export default function PanelSetupScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [layout, setLayout] = useState({ ...DEFAULT_LAYOUT });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Probe with the panel ON and NO bottle.');
  const cameraRef = useRef(null);

  useEffect(() => {
    loadLayout().then(setLayout);
  }, []);

  useEffect(() => {
    if (permission && !permission.granted) requestPermission();
  }, [permission]);

  const waterCenterY = layout.waterCenterYFrac * SCREEN_H;
  const rects = {
    water: {
      left: (SCREEN_W - WATER_W) / 2,
      top: waterCenterY - layout.waterHeight / 2,
      w: WATER_W, h: layout.waterHeight,
    },
    bgL: {
      left: SCREEN_W / 2 - layout.patchOffsetFrac * SCREEN_W - PATCH / 2,
      top: waterCenterY - PATCH / 2,
      w: PATCH, h: PATCH,
    },
    bgR: {
      left: SCREEN_W / 2 + layout.patchOffsetFrac * SCREEN_W - PATCH / 2,
      top: waterCenterY - PATCH / 2,
      w: PATCH, h: PATCH,
    },
  };

  const nudge = (key, delta, min, max) => {
    setLayout((l) => ({ ...l, [key]: Math.min(max, Math.max(min, l[key] + delta)) }));
  };

  // ── Auto-placement: probe shot of the bare panel (no bottle) ──────────────
  const autoPlace = async () => {
    setBusy(true);
    setStatus('Taking probe shot…');
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7, base64: false, skipProcessing: true,
      });
      const probe = await ImageManipulator.manipulateAsync(photo.uri, [], {});
      const imgW = probe.width, imgH = probe.height;

      // Horizontal strip at the water-ROI height, mapped through the cover crop
      const scale = Math.max(SCREEN_W / imgW, SCREEN_H / imgH);
      const dy = (imgH * scale - SCREEN_H) / 2;
      const stripTopImg = Math.max(0, Math.round((rects.bgL.top + dy) / scale));
      const stripHImg = Math.max(8, Math.round(PATCH / scale));
      const dx = (imgW * scale - SCREEN_W) / 2;
      const visLeftImg = Math.max(0, Math.round(dx / scale));           // screen x=0 in image px
      const visWImg = Math.min(Math.round(SCREEN_W / scale), imgW - visLeftImg);

      const strip = await ImageManipulator.manipulateAsync(
        photo.uri,
        [
          { crop: { originX: visLeftImg, originY: stripTopImg, width: visWImg, height: Math.min(stripHImg, imgH - stripTopImg) } },
          { resize: { width: 240 } },
        ],
        { format: ImageManipulator.SaveFormat.JPEG, base64: false }
      );
      const { columns, width: W } = await analyzeColumnProfile(strip.uri);

      // Smooth (moving average, window 5)
      const sm = columns.map((_, i) => {
        let s = 0, n = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(W - 1, i + 2); j++) { s += columns[j]; n++; }
        return s / n;
      });
      const maxB = Math.max(...sm);
      if (maxB < 40) {
        setStatus('Panel looks dark — is the LED on?');
        Alert.alert('Panel dark', 'The probe shot shows no bright panel. Turn the LED panel on and try again.');
        return;
      }

      const patchW = Math.max(4, Math.round((PATCH / SCREEN_W) * W));
      const center = W / 2;
      const windowStats = (cFrac, sign) => {
        const cCol = center + sign * cFrac * W;
        const lo = Math.round(cCol - patchW / 2), hi = Math.round(cCol + patchW / 2);
        if (lo < 0 || hi >= W) return null;
        let s = 0, n = 0;
        for (let i = lo; i <= hi; i++) { s += sm[i]; n++; }
        const mean = s / n;
        let v = 0;
        for (let i = lo; i <= hi; i++) v += (sm[i] - mean) ** 2;
        return { mean, cv: Math.sqrt(v / n) / mean };
      };

      // Prefer the FARTHEST offset where both sides are bright, flat, and matched
      let best = null, fallback = null;
      for (let f = MAX_OFFSET; f >= MIN_OFFSET; f -= 0.01) {
        const L = windowStats(f, -1), R = windowStats(f, +1);
        if (!L || !R) continue;
        const mismatch = Math.abs(L.mean - R.mean) / ((L.mean + R.mean) / 2);
        const bright = L.mean >= 0.65 * maxB && R.mean >= 0.65 * maxB;
        const flat = L.cv <= 0.10 && R.cv <= 0.10;
        if (bright && flat && mismatch <= 0.04 && !best) best = { f, mismatch };
        const okDim = L.mean >= 0.5 * maxB && R.mean >= 0.5 * maxB;
        if (okDim && (!fallback || mismatch < fallback.mismatch)) fallback = { f, mismatch };
      }

      const pick = best || fallback;
      if (!pick) {
        setStatus('No usable flat/bright zone found — check panel and LED.');
        Alert.alert(
          'Auto-placement failed',
          'Could not find bright, flat panel on both sides. Position the patches manually with the arrows.'
        );
        return;
      }
      setLayout((l) => ({ ...l, patchOffsetFrac: parseFloat(pick.f.toFixed(3)) }));
      setStatus(
        `Patches placed at ±${(pick.f * 100).toFixed(0)}% width · ` +
        `L/R mismatch ${(pick.mismatch * 100).toFixed(1)}%` +
        (best ? ' ✓' : ' (best available — panel is uneven)')
      );
    } catch (e) {
      Alert.alert('Probe failed', e.message || 'Could not analyse the probe shot.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await saveLayout(layout);
    Alert.alert('Saved', 'Capture layout updated.', [
      { text: 'OK', onPress: () => navigation.goBack() },
    ]);
  };

  const reset = async () => {
    const d = await resetLayout();
    setLayout(d);
    setStatus('Layout reset to defaults.');
  };

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text style={{ color: '#37474F' }}>Camera permission required.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView style={styles.camera} ref={cameraRef} facing="back" flash="off" enableTorch={false}>
        {/* overlays */}
        <View pointerEvents="none" style={[styles.waterRect, {
          left: rects.water.left, top: rects.water.top, width: rects.water.w, height: rects.water.h,
        }]} />
        {[rects.bgL, rects.bgR].map((r, i) => (
          <View key={i} pointerEvents="none" style={[styles.bgPatch, {
            left: r.left, top: r.top, width: r.w, height: r.h,
          }]} />
        ))}

        <SafeAreaView style={styles.overlay}>
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
              <Text style={styles.backBtnText}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.topTitle}>Panel Setup</Text>
            <View style={{ width: 40 }} />
          </View>

          <View style={styles.panel}>
            <Text style={styles.statusText}>{status}</Text>

            <TouchableOpacity style={styles.autoBtn} onPress={autoPlace} disabled={busy}>
              {busy
                ? <ActivityIndicator color="#FFF" />
                : <Text style={styles.autoBtnText}>📸 Auto-place patches (no bottle)</Text>}
            </TouchableOpacity>

            {/* manual nudges */}
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>Patch offset  ±{(layout.patchOffsetFrac * 100).toFixed(0)}%</Text>
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => nudge('patchOffsetFrac', -0.01, MIN_OFFSET, MAX_OFFSET)}><Text style={styles.ctrlBtnText}>◀</Text></TouchableOpacity>
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => nudge('patchOffsetFrac', +0.01, MIN_OFFSET, MAX_OFFSET)}><Text style={styles.ctrlBtnText}>▶</Text></TouchableOpacity>
            </View>
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>ROI height  {layout.waterHeight}px</Text>
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => nudge('waterHeight', -10, 60, 400)}><Text style={styles.ctrlBtnText}>−</Text></TouchableOpacity>
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => nudge('waterHeight', +10, 60, 400)}><Text style={styles.ctrlBtnText}>+</Text></TouchableOpacity>
            </View>
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>ROI position  {(layout.waterCenterYFrac * 100).toFixed(0)}%</Text>
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => nudge('waterCenterYFrac', -0.02, 0.2, 0.8)}><Text style={styles.ctrlBtnText}>▲</Text></TouchableOpacity>
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => nudge('waterCenterYFrac', +0.02, 0.2, 0.8)}><Text style={styles.ctrlBtnText}>▼</Text></TouchableOpacity>
            </View>

            <View style={styles.saveRow}>
              <TouchableOpacity style={styles.resetBtn} onPress={reset}>
                <Text style={styles.resetBtnText}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={save}>
                <Text style={styles.saveBtnText}>💾 Save layout</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#E3F2FD' },

  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
  },
  backBtnText: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  topTitle: { color: '#FFF', fontSize: 16, fontWeight: 'bold', textShadowColor: '#000', textShadowRadius: 4 },

  waterRect: { position: 'absolute', borderWidth: 3, borderColor: '#29B6F6', borderRadius: 10 },
  bgPatch: {
    position: 'absolute', borderWidth: 2, borderColor: '#FFEB3B',
    borderStyle: 'dashed', borderRadius: 6,
  },

  panel: {
    backgroundColor: 'rgba(0,0,0,0.65)', margin: 12, borderRadius: 16, padding: 14,
  },
  statusText: { color: '#BBDEFB', fontSize: 12, textAlign: 'center', marginBottom: 10 },
  autoBtn: {
    backgroundColor: '#6A1B9A', borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', marginBottom: 12,
  },
  autoBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  ctrlRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  ctrlLabel: { color: '#FFF', fontSize: 13, flex: 1 },
  ctrlBtn: {
    width: 44, height: 36, borderRadius: 8, backgroundColor: '#1565C0',
    justifyContent: 'center', alignItems: 'center',
  },
  ctrlBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },

  saveRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  resetBtn: {
    flex: 1, borderWidth: 1, borderColor: '#90A4AE', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  resetBtnText: { color: '#CFD8DC', fontWeight: '600' },
  saveBtn: {
    flex: 2, backgroundColor: '#2E7D32', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  saveBtnText: { color: '#FFF', fontWeight: 'bold' },
});
