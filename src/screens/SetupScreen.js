import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image, PanResponder,
  Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import {
  thumbUrl, postConfig, postBlank, postAutotune, getLedTest, createCancelToken,
  DEFAULT_IP, validateConfigValues, DEFAULT_CONFIG, CONFIG_LIMITS,
} from '../api/boxClient';
import { useBoxConnection } from '../context/BoxConnectionContext';
import DebugPanel from '../components/DebugPanel';

const PREVIEW_W = 300;
const PREVIEW_H = 225;

function ageText(s) {
  if (s === null || s === undefined || s < 0) return 'unknown — recapture';
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  const h = s / 3600;
  return `${h.toFixed(1)} h ago${h > 24 ? ' — recapture' : ''}`;
}

function alertTitleFor(e) {
  return e.kind === 'gate' ? 'Rejected'
    : e.kind === 'http' ? 'Firmware mismatch'
    : e.kind === 'cancelled' ? 'Cancelled'
    : 'Box unreachable';
}

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
      }}
    >
      <Text style={{ color, fontSize: 10, fontWeight: 'bold', textShadowColor: '#000', textShadowRadius: 3 }}>
        {label}
      </Text>
    </View>
  );
}

export default function SetupScreen() {
  const {
    ip, setIp, status, connecting, statusError, connected, hasPreview,
    apiVersion, apiVersionMatch, EXPECTED_API_VERSION,
    connect, disconnect, refresh,
  } = useBoxConnection();

  const [connectError, setConnectError] = useState(null);
  const [debugVisible, setDebugVisible] = useState(false);

  // Form state — populated from box status whenever it changes (Bug 2:
  // never starts from a hardcoded 0, always mirrors what the box reports).
  const [roi, setRoi] = useState({ x: 0.42, y: 0.30, w: 0.16, h: 0.40 });
  const [patchA, setPatchA] = useState({ x: 0.14, y: 0.44, w: 0.10, h: 0.12 });
  const [patchB, setPatchB] = useState({ x: 0.76, y: 0.44, w: 0.10, h: 0.12 });
  const [aecValue, setAecValue] = useState(DEFAULT_CONFIG.aec_value);
  const [agcGain, setAgcGain] = useState(DEFAULT_CONFIG.agc_gain);
  const [rGain, setRGain] = useState(DEFAULT_CONFIG.r_gain);
  const [bGain, setBGain] = useState(DEFAULT_CONFIG.b_gain);
  const [sel, setSel] = useState('roi');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [thumb, setThumb] = useState(null);
  const [saving, setSaving] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [ledTesting, setLedTesting] = useState(false);
  const [ledResult, setLedResult] = useState(null);
  const [tuneResult, setTuneResult] = useState(null);
  const [blanking, setBlanking] = useState(false);

  // Load form fields from the box whenever we (re)connect / get fresh status.
  useEffect(() => {
    const s = status?.settings;
    if (!s) return;
    if (s.roi) setRoi(s.roi);
    if (s.patchA) setPatchA(s.patchA);
    if (s.patchB) setPatchB(s.patchB);
    if (typeof s.aec_value === 'number') setAecValue(s.aec_value);
    if (typeof s.agc_gain === 'number') setAgcGain(s.agc_gain);
    if (typeof s.r_gain === 'number') setRGain(s.r_gain);
    if (typeof s.b_gain === 'number') setBGain(s.b_gain);
  }, [status]);

  useEffect(() => {
    if (!connected || !hasPreview) { setThumb(null); return; }
    setThumb(thumbUrl(ip));
    const t = setInterval(() => setThumb(thumbUrl(ip)), 2500);
    return () => clearInterval(t);
  }, [ip, connected, hasPreview]);

  const doConnect = async () => {
    setConnectError(null);
    const r = await connect(ip);
    if (!r.ok) setConnectError(r.error);
  };

  const current = sel === 'roi' ? roi : sel === 'patchA' ? patchA : patchB;
  const setCurrent = sel === 'roi' ? setRoi : sel === 'patchA' ? setPatchA : setPatchB;
  const resize = (dw, dh) => {
    setCurrent((r) => ({
      ...r,
      w: Math.min(1 - r.x, Math.max(0.03, r.w + dw)),
      h: Math.min(1 - r.y, Math.max(0.03, r.h + dh)),
    }));
  };

  // ── Auto-tune exposure (Bug 1c) — replaces manual +/- guesswork ──────────
  const autoTune = async () => {
    setTuning(true);
    setTuneResult(null);
    try {
      await postConfig(ip, { roi, patchA, patchB, r_gain: rGain, b_gain: bGain });
      const r = await postAutotune(ip);
      setAecValue(r.aec_value);
      setTuneResult(r);
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Auto-tune failed.');
    } finally {
      setTuning(false);
    }
  };

  // ── LED test (Bug 3) ───────────────────────────────────────────────────────
  const runLedTest = async () => {
    setLedTesting(true);
    setLedResult(null);
    try {
      const r = await getLedTest(ip);
      setLedResult(r);
      if (r.responding === false) {
        Alert.alert('LED not responding', 'Check wiring/power to the illumination LED.');
      }
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'LED test failed.');
    } finally {
      setLedTesting(false);
    }
  };

  // ── Save (Bug 2): validate, confirm old→new, only then send ──────────────
  const save = () => {
    const invalid = validateConfigValues({ aec_value: aecValue, agc_gain: agcGain, r_gain: rGain, b_gain: bGain });
    if (invalid) {
      Alert.alert('Invalid settings', invalid + '\n\nFix the value before saving.');
      return;
    }
    const s0 = status?.settings || {};
    const changes = [];
    if (s0.aec_value !== aecValue) changes.push(`Exposure: ${s0.aec_value ?? '—'} → ${aecValue}`);
    if (s0.agc_gain !== agcGain) changes.push(`Gain: ${s0.agc_gain ?? '—'} → ${agcGain}`);
    if (s0.r_gain !== rGain) changes.push(`Red WB: ${s0.r_gain ?? '—'} → ${rGain}`);
    if (s0.b_gain !== bGain) changes.push(`Blue WB: ${s0.b_gain ?? '—'} → ${bGain}`);
    changes.push('ROI/patch regions updated');

    Alert.alert(
      'Save to box?',
      changes.join('\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: doSave },
      ]
    );
  };

  const doSave = async () => {
    setSaving(true);
    try {
      await postConfig(ip, { roi, patchA, patchB, aec_value: aecValue, agc_gain: agcGain, r_gain: rGain, b_gain: bGain });
      await refresh();
      Alert.alert('Saved ✓', 'Settings sent to the box.');
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaults = () => {
    Alert.alert('Restore defaults?', 'Exposure 300, gain 2, WB gains 1.0/1.0. ROI/patches unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore', onPress: () => {
          setAecValue(DEFAULT_CONFIG.aec_value);
          setAgcGain(DEFAULT_CONFIG.agc_gain);
          setRGain(DEFAULT_CONFIG.r_gain);
          setBGain(DEFAULT_CONFIG.b_gain);
          setTuneResult(null);
        },
      },
    ]);
  };

  // ── Capture blank ──────────────────────────────────────────────────────────
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
      await refresh();
      Alert.alert('Blank captured ✓', `ROI net blue ${r.roi_net?.b?.toFixed?.(1) ?? '—'}.`);
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Blank capture failed.');
    } finally {
      setBlanking(false);
    }
  };

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>💧 AQUA-BOX Water Hardness Tester</Text>
          <Text style={styles.infoText}>
            Power the box, join its WiFi network “AQUA-BOX” on this phone, then connect.
            The box is at {DEFAULT_IP} by default.
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Box IP address</Text>
          <TextInput
            style={styles.input}
            value={ip}
            onChangeText={setIp}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            placeholder={DEFAULT_IP}
            placeholderTextColor="#90A4AE"
          />
          <TouchableOpacity style={[styles.primaryBtn, connecting && styles.btnDisabled]} onPress={doConnect} disabled={connecting}>
            {connecting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>Connect</Text>}
          </TouchableOpacity>
        </View>
        {connectError && (
          <View style={styles.errBox}><Text style={styles.errText}>{connectError}</Text></View>
        )}
      </ScrollView>
    );
  }

  // ── Connected ────────────────────────────────────────────────────────────

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Connection card */}
      <TouchableOpacity style={styles.card} onLongPress={() => setDebugVisible(true)} delayLongPress={500} activeOpacity={0.85}>
        <Text style={styles.cardTitle}>Connection</Text>
        <Text style={styles.metaText}>
          {status?.device_type || 'device'} · {status?.box_id || '—'} · fw {status?.fw_version || '—'}{'\n'}
          api v{apiVersion ?? '?'}{apiVersionMatch ? ' ✓' : ` — app expects v${EXPECTED_API_VERSION} ⚠`}
        </Text>
        {statusError && <Text style={styles.errInlineText}>⚠ {statusError}</Text>}
        {!apiVersionMatch && (
          <Text style={styles.warnInlineText}>⚠ Firmware/app mismatch — update firmware or app.</Text>
        )}
        <View style={styles.rowSmall}>
          <TouchableOpacity style={styles.linkBtn} onPress={refresh}><Text style={styles.linkText}>↻ Refresh</Text></TouchableOpacity>
          <TouchableOpacity style={styles.linkBtn} onPress={disconnect}><Text style={styles.linkText}>Disconnect</Text></TouchableOpacity>
        </View>
        <Text style={styles.longPressHint}>long-press for debug info</Text>
      </TouchableOpacity>

      {/* Camera & Regions card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Camera & Regions</Text>
        {hasPreview ? (
          <>
            <Text style={styles.hint}>Drag onto the bottle (ROI) and bare lit panel (patches).</Text>
            <View style={styles.previewWrap}>
              <View style={{ width: PREVIEW_W, height: PREVIEW_H }}>
                {thumb && <Image source={{ uri: thumb }} style={styles.preview} resizeMode="cover" />}
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
              <Text style={styles.sizeLabel}>{(current.w * 100).toFixed(0)}×{(current.h * 100).toFixed(0)}%</Text>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(-0.02, 0)}><Text style={styles.sizeBtnText}>W−</Text></TouchableOpacity>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0.02, 0)}><Text style={styles.sizeBtnText}>W+</Text></TouchableOpacity>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0, -0.02)}><Text style={styles.sizeBtnText}>H−</Text></TouchableOpacity>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0, 0.02)}><Text style={styles.sizeBtnText}>H+</Text></TouchableOpacity>
            </View>
          </>
        ) : (
          <Text style={styles.noPreviewText}>
            This device has no camera preview. Region of interest is fixed in firmware.
          </Text>
        )}
      </View>

      {/* Illumination card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Illumination</Text>

        <TouchableOpacity style={[styles.primaryBtnPurple, tuning && styles.btnDisabled]} onPress={autoTune} disabled={tuning}>
          {tuning ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>🔎 Auto-tune exposure</Text>}
        </TouchableOpacity>
        {tuneResult && (
          <Text style={styles.resultLine}>
            {tuneResult.in_band ? '✓ Tuned' : '~ Best effort'} — level {(tuneResult.roi_p99_max / 255 * 100).toFixed(0)}%
          </Text>
        )}

        <TouchableOpacity style={[styles.secondaryBtn, ledTesting && styles.btnDisabled]} onPress={runLedTest} disabled={ledTesting}>
          {ledTesting ? <ActivityIndicator color="#1565C0" /> : <Text style={styles.secondaryBtnText}>💡 LED test</Text>}
        </TouchableOpacity>
        {ledResult && (
          <Text style={[styles.resultLine, { color: ledResult.responding ? '#2E7D32' : '#C62828' }]}>
            {ledResult.responding ? `✓ LED responding (Δ${ledResult.delta.toFixed(0)})` : `⚠ LED not responding — check wiring/power`}
          </Text>
        )}

        <TouchableOpacity style={styles.advancedToggle} onPress={() => setShowAdvanced(!showAdvanced)}>
          <Text style={styles.advancedToggleText}>{showAdvanced ? '▾' : '▸'} Advanced</Text>
        </TouchableOpacity>
        {showAdvanced && (
          <View style={styles.advancedBox}>
            <StepperRow label={`Exposure (aec_value): ${aecValue}`} onMinus={() => setAecValue((v) => Math.max(CONFIG_LIMITS.aecValue.min, v - 20))} onPlus={() => setAecValue((v) => Math.min(CONFIG_LIMITS.aecValue.max, v + 20))} />
            <StepperRow label={`Gain (agc_gain): ${agcGain}`} onMinus={() => setAgcGain((v) => Math.max(CONFIG_LIMITS.agcGain.min, v - 1))} onPlus={() => setAgcGain((v) => Math.min(CONFIG_LIMITS.agcGain.max, v + 1))} />
            <StepperRow label={`Red WB gain: ${rGain.toFixed(2)}`} onMinus={() => setRGain((v) => Math.max(CONFIG_LIMITS.rGain.min, +(v - 0.05).toFixed(2)))} onPlus={() => setRGain((v) => Math.min(CONFIG_LIMITS.rGain.max, +(v + 0.05).toFixed(2)))} />
            <StepperRow label={`Blue WB gain: ${bGain.toFixed(2)}`} onMinus={() => setBGain((v) => Math.max(CONFIG_LIMITS.bGain.min, +(v - 0.05).toFixed(2)))} onPlus={() => setBGain((v) => Math.min(CONFIG_LIMITS.bGain.max, +(v + 0.05).toFixed(2)))} />
            <TouchableOpacity style={styles.restoreBtn} onPress={restoreDefaults}>
              <Text style={styles.restoreBtnText}>↺ Restore defaults</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Blank card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Blank</Text>
        <Text style={styles.metaText}>Blank age: {ageText(status?.blank_age_s)}</Text>
        <TouchableOpacity style={[styles.tealBtn, blanking && styles.btnDisabled]} onPress={captureBlank} disabled={blanking}>
          {blanking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>🧪 Capture Blank</Text>}
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.saveBtn, saving && styles.btnDisabled]} onPress={save} disabled={saving}>
        {saving ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveBtnText}>💾 Save to box</Text>}
      </TouchableOpacity>

      <DebugPanel visible={debugVisible} onClose={() => setDebugVisible(false)} />
    </ScrollView>
  );
}

function StepperRow({ label, onMinus, onPlus }) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <TouchableOpacity style={styles.stepBtn} onPress={onMinus}><Text style={styles.stepBtnText}>−</Text></TouchableOpacity>
      <TouchableOpacity style={styles.stepBtn} onPress={onPlus}><Text style={styles.stepBtnText}>+</Text></TouchableOpacity>
    </View>
  );
}

const ACCENT = '#1565C0';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },

  infoCard: {
    backgroundColor: '#E8EAF6', borderRadius: 16, padding: 16, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#3949AB',
  },
  infoTitle: { fontWeight: 'bold', color: '#3949AB', marginBottom: 6, fontSize: 16 },
  infoText: { color: '#37474F', fontSize: 13, lineHeight: 19 },

  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: ACCENT, marginBottom: 10 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 6 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0', marginBottom: 14,
  },
  primaryBtn: { backgroundColor: ACCENT, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryBtnPurple: { backgroundColor: '#6A1B9A', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginBottom: 6 },
  primaryBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  secondaryBtn: { borderWidth: 1, borderColor: ACCENT, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  secondaryBtnText: { color: ACCENT, fontWeight: '700', fontSize: 13 },
  tealBtn: { backgroundColor: '#00838F', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  btnDisabled: { backgroundColor: '#B0BEC5' },
  resultLine: { color: '#546E7A', fontSize: 12, marginTop: 8, textAlign: 'center' },

  errBox: { backgroundColor: '#FFF3E0', borderRadius: 12, padding: 14, borderLeftWidth: 4, borderLeftColor: '#EF6C00' },
  errText: { color: '#E65100', fontSize: 13, lineHeight: 19 },

  metaText: { color: '#546E7A', fontSize: 13, lineHeight: 19 },
  errInlineText: { color: '#C62828', fontSize: 12, marginTop: 8, fontWeight: '600' },
  warnInlineText: { color: '#EF6C00', fontSize: 12, marginTop: 8, fontWeight: '600' },
  rowSmall: { flexDirection: 'row', gap: 16, marginTop: 10 },
  linkBtn: { paddingVertical: 4 },
  linkText: { color: '#546E7A', fontSize: 13 },
  longPressHint: { color: '#B0BEC5', fontSize: 10, marginTop: 10, textAlign: 'right' },

  hint: { color: '#546E7A', fontSize: 12, marginBottom: 10 },
  previewWrap: { alignItems: 'center', marginBottom: 12 },
  preview: { width: PREVIEW_W, height: PREVIEW_H, borderRadius: 8, backgroundColor: '#000', position: 'absolute' },
  noPreviewText: { color: '#546E7A', fontSize: 13, lineHeight: 19 },

  selRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginBottom: 10 },
  selBtn: { borderWidth: 1, borderColor: '#CFD8DC', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 14 },
  selBtnActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  selBtnText: { color: '#546E7A', fontSize: 12, fontWeight: '600' },
  selBtnTextActive: { color: '#FFF' },

  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', flexWrap: 'wrap' },
  sizeLabel: { color: '#546E7A', fontSize: 12, marginRight: 4 },
  sizeBtn: { backgroundColor: '#ECEFF1', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  sizeBtnText: { color: '#1A237E', fontWeight: 'bold', fontSize: 13 },

  advancedToggle: { marginTop: 12 },
  advancedToggleText: { color: ACCENT, fontSize: 13, fontWeight: '600' },
  advancedBox: { marginTop: 10, backgroundColor: '#F5F5F5', borderRadius: 10, padding: 12 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  stepperLabel: { color: '#37474F', fontSize: 13, flex: 1 },
  stepBtn: { width: 36, height: 32, borderRadius: 8, backgroundColor: ACCENT, justifyContent: 'center', alignItems: 'center' },
  stepBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  restoreBtn: { marginTop: 4, alignItems: 'center', paddingVertical: 8 },
  restoreBtnText: { color: '#C62828', fontSize: 12, fontWeight: '600' },

  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 16, alignItems: 'center', elevation: 2 },
  saveBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
});
