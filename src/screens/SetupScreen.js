import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image, PanResponder,
  Alert, ActivityIndicator, ScrollView, Share,
} from 'react-native';
import {
  thumbUrl, postConfig, postBlank, postAutotune, getLedTest, getProbe, createCancelToken,
  DEFAULT_IP, validateConfigValues, DEFAULT_CONFIG, CONFIG_LIMITS,
} from '../api/boxClient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBoxConnection } from '../context/BoxConnectionContext';
import DebugPanel from '../components/DebugPanel';
import {
  makeProbeRecord, appendProbe, loadProbeLog, clearProbeLog,
  setReference, loadReference, clearReference, computeReferenceA,
  settingsSignature, probeLogToCsv,
} from '../utils/probeLog';

// Onboarding step "Set regions & exposure" is marked complete the first time
// either Save-to-box or Auto-tune succeeds (read by the Measurement tab).
const SETUP_DONE_KEY = 'setup_done';
const markSetupDone = () => AsyncStorage.setItem(SETUP_DONE_KEY, '1').catch(() => {});

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
    apiVersion, apiVersionMatch, apiVersionOutdated, RECOMMENDED_API_VERSION, MIN_API_VERSION,
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
  // Patches A/B are diagnostics only — the hardness reading uses the ROI
  // alone (dark-subtracted against the reference water). Keep them out of
  // the main flow; experts can still place them from this toggle.
  const [showPatches, setShowPatches] = useState(false);

  const [thumb, setThumb] = useState(null);
  const [saving, setSaving] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [ledTesting, setLedTesting] = useState(false);
  const [ledResult, setLedResult] = useState(null);
  const [tuneResult, setTuneResult] = useState(null);
  const [blanking, setBlanking] = useState(false);

  // Live probe readout + quick-compare reference
  const [probe, setProbe] = useState(null);       // last /probe {roi,sat,...}
  const [probing, setProbing] = useState(false);
  const [reference, setReferenceState] = useState(null); // stored ref record
  const [probeLog, setProbeLog] = useState([]);
  const [showProbes, setShowProbes] = useState(false);

  // Current settings signature — reference is only valid if it matches.
  const currentSig = settingsSignature({ aec_value: aecValue, agc_gain: agcGain, r_gain: rGain, b_gain: bGain });
  const refValid = reference && reference.sig === currentSig;

  useEffect(() => {
    loadReference().then(setReferenceState).catch(() => {});
    loadProbeLog().then(setProbeLog).catch(() => {});
  }, []);

  // Central handler: any probe response (from Refresh / auto-tune / LED test)
  // updates the live readout and is appended to the ring buffer.
  const ingestProbe = async (p) => {
    if (!p || !p.roi) return;
    setProbe(p);
    const rec = makeProbeRecord(p, { aec_value: aecValue, agc_gain: agcGain, r_gain: rGain, b_gain: bGain });
    setProbeLog(await appendProbe(rec));
  };

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

  // ── Refresh probe — live ROI readout on demand ───────────────────────────
  const refreshProbe = async () => {
    setProbing(true);
    try {
      const p = await getProbe(ip);
      await ingestProbe(p);
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Could not read the box.');
    } finally {
      setProbing(false);
    }
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
      markSetupDone();
      // refresh the live readout at the new exposure
      try { await ingestProbe(await getProbe(ip)); } catch {}
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
      try { await ingestProbe(await getProbe(ip)); } catch {}
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'LED test failed.');
    } finally {
      setLedTesting(false);
    }
  };

  // ── Quick-compare reference ──────────────────────────────────────────────
  const setAsReference = async () => {
    if (!probe?.roi) {
      Alert.alert('Take a reading first', 'Tap Refresh to read the box, then set it as the reference.');
      return;
    }
    const rec = makeProbeRecord(probe, { aec_value: aecValue, agc_gain: agcGain, r_gain: rGain, b_gain: bGain });
    await setReference(rec);
    setReferenceState(rec);
  };
  const clearRef = async () => {
    await clearReference();
    setReferenceState(null);
  };

  const exportProbes = async () => {
    if (!probeLog.length) { Alert.alert('No probes yet', 'Take some readings first.'); return; }
    try { await Share.share({ message: probeLogToCsv(probeLog), title: 'InPhoton-Aqua probes.csv' }); } catch {}
  };
  const clearProbes = async () => {
    await clearProbeLog();
    setProbeLog([]);
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
      markSetupDone();
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
      'Capture reference water',
      'Reference water = distilled water (0 ppm) with reagent added. Make sure it is in the box, the panel is on, and nothing else is in the beam. Continue?',
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
      Alert.alert('Reference water captured ✓', 'You can measure samples now.');
    } catch (e) {
      Alert.alert(alertTitleFor(e), e.message || 'Could not capture the reference water.');
    } finally {
      setBlanking(false);
    }
  };

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.logoWrap}>
          <Image source={require('../../assets/inphoton-logo.png')} style={styles.logo} resizeMode="contain" />
          <Text style={styles.logoSub}>Aqua — Water Hardness Tester</Text>
        </View>
        <View style={styles.infoCard}>
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
      <View style={styles.logoWrapSmall}>
        <Image source={require('../../assets/inphoton-logo.png')} style={styles.logoSmall} resizeMode="contain" />
      </View>

      {/* Connection card */}
      <TouchableOpacity style={styles.card} onLongPress={() => setDebugVisible(true)} delayLongPress={500} activeOpacity={0.85}>
        <Text style={styles.cardTitle}>Connection</Text>
        <Text style={styles.metaText}>
          {status?.device_type || 'device'} · {status?.box_id || '—'} · fw {status?.fw_version || '—'}{'\n'}
          api v{apiVersion ?? '?'}{apiVersionMatch ? (apiVersionOutdated ? ' ·' : ' ✓') : ` — app needs v${MIN_API_VERSION}+ ⚠`}
        </Text>
        {statusError && <Text style={styles.errInlineText}>⚠ {statusError}</Text>}
        {!apiVersionMatch && (
          <Text style={styles.warnInlineText}>
            ⚠ This box's firmware is too old for the app (needs v{MIN_API_VERSION}+). Reflash the box.
          </Text>
        )}
        {apiVersionMatch && apiVersionOutdated && (
          <Text style={styles.infoInlineText}>
            Box firmware is v{apiVersion} — everything works, but per-run repeatability (σ) needs
            v{RECOMMENDED_API_VERSION}. Calibration σ is measured by the app and is unaffected.
          </Text>
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
            <Text style={styles.hint}>Drag the blue box onto the water sample.</Text>
            <View style={styles.previewWrap}>
              <View style={{ width: PREVIEW_W, height: PREVIEW_H }}>
                {thumb && <Image source={{ uri: thumb }} style={styles.preview} resizeMode="cover" />}
                <DraggableRect rect={roi} color="#29B6F6" label="Sample" onChange={setRoi} boxW={PREVIEW_W} boxH={PREVIEW_H} />
                {showPatches && (
                  <>
                    <DraggableRect rect={patchA} color="#FFEB3B" label="A" onChange={setPatchA} boxW={PREVIEW_W} boxH={PREVIEW_H} />
                    <DraggableRect rect={patchB} color="#FFEB3B" label="B" onChange={setPatchB} boxW={PREVIEW_W} boxH={PREVIEW_H} />
                  </>
                )}
              </View>
            </View>
            {showPatches && (
              <View style={styles.selRow}>
                {[['roi', 'Sample'], ['patchA', 'Patch A'], ['patchB', 'Patch B']].map(([k, lbl]) => (
                  <TouchableOpacity key={k} style={[styles.selBtn, sel === k && styles.selBtnActive]} onPress={() => setSel(k)}>
                    <Text style={[styles.selBtnText, sel === k && styles.selBtnTextActive]}>{lbl}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={styles.sizeRow}>
              <Text style={styles.sizeLabel}>{(current.w * 100).toFixed(0)}×{(current.h * 100).toFixed(0)}%</Text>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(-0.02, 0)}><Text style={styles.sizeBtnText}>W−</Text></TouchableOpacity>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0.02, 0)}><Text style={styles.sizeBtnText}>W+</Text></TouchableOpacity>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0, -0.02)}><Text style={styles.sizeBtnText}>H−</Text></TouchableOpacity>
              <TouchableOpacity style={styles.sizeBtn} onPress={() => resize(0, 0.02)}><Text style={styles.sizeBtnText}>H+</Text></TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.advancedToggle}
              onPress={() => { const next = !showPatches; setShowPatches(next); if (!next) setSel('roi'); }}
            >
              <Text style={styles.advancedToggleText}>
                {showPatches ? '▾' : '▸'} Diagnostic patches (not used in the reading)
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.noPreviewText}>
            This device has no camera preview. Region of interest is fixed in firmware.
          </Text>
        )}
      </View>

      {/* Live readout card */}
      <View style={styles.card}>
        <View style={styles.readoutHeader}>
          <Text style={styles.cardTitle}>Live readout</Text>
          <TouchableOpacity style={styles.refreshBtn} onPress={refreshProbe} disabled={probing}>
            {probing ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={styles.refreshBtnText}>↻ Refresh</Text>}
          </TouchableOpacity>
        </View>

        {probe?.roi ? (
          <ProbeReadout probe={probe} />
        ) : (
          <Text style={styles.readoutHint}>Tap Refresh to read the sample-region colour.</Text>
        )}

        {/* Quick-compare (reference) */}
        <View style={styles.refDivider} />
        {reference && !refValid && (
          <View style={styles.warnChip}>
            <Text style={styles.warnChipText}>⚠ Settings changed — reference invalid. Re-reference.</Text>
          </View>
        )}
        {refValid && probe?.roi ? (
          <ReferenceReadout reference={reference} probe={probe} />
        ) : (
          <Text style={styles.readoutHint}>
            {reference ? '' : 'Set a reference to compare later readings against it (A = log₁₀(I_ref / I_now)).'}
          </Text>
        )}
        <View style={styles.refBtnRow}>
          <TouchableOpacity
            style={[styles.refBtn, !probe?.roi && styles.btnDisabled]}
            onPress={setAsReference}
            disabled={!probe?.roi}
          >
            <Text style={styles.refBtnText}>📌 Set as reference</Text>
          </TouchableOpacity>
          {reference && (
            <TouchableOpacity style={styles.refClearBtn} onPress={clearRef}>
              <Text style={styles.refClearBtnText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
        {reference && (
          <Text style={styles.refAge}>Reference set {timeAgo(reference.at)}</Text>
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

            {/* Recent probes ring buffer */}
            <TouchableOpacity style={styles.probesToggle} onPress={() => setShowProbes(!showProbes)}>
              <Text style={styles.advancedToggleText}>
                {showProbes ? '▾' : '▸'} Recent probes ({probeLog.length})
              </Text>
            </TouchableOpacity>
            {showProbes && (
              <View style={styles.probesBox}>
                {probeLog.length === 0 ? (
                  <Text style={styles.readoutHint}>No probes logged yet.</Text>
                ) : (
                  probeLog.slice(0, 12).map((p, i) => (
                    <Text key={i} style={styles.probeLogLine}>
                      {new Date(p.at).toLocaleTimeString()}  R{p.r.toFixed(0)} G{p.g.toFixed(0)} B{p.b.toFixed(0)}  sat {p.sat.toFixed(1)}%
                    </Text>
                  ))
                )}
                <View style={styles.refBtnRow}>
                  <TouchableOpacity style={styles.exportProbesBtn} onPress={exportProbes}>
                    <Text style={styles.exportProbesBtnText}>⬇ Export CSV</Text>
                  </TouchableOpacity>
                  {probeLog.length > 0 && (
                    <TouchableOpacity style={styles.refClearBtn} onPress={clearProbes}>
                      <Text style={styles.refClearBtnText}>Clear log</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Blank card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Reference water (0 ppm)</Text>
        <Text style={styles.tooltipText}>
          The zero point every reading is compared against: distilled water with reagent added.
          Recapture it daily and whenever the box is moved.
        </Text>
        <Text style={styles.metaText}>Last captured: {ageText(status?.blank_age_s)}</Text>
        <TouchableOpacity style={[styles.tealBtn, blanking && styles.btnDisabled]} onPress={captureBlank} disabled={blanking}>
          {blanking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>🧪 Capture reference water</Text>}
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

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

// Live ROI mean per channel: value (0–255), % of full scale, max highlighted,
// plus overall clipping %.
function ProbeReadout({ probe }) {
  const chans = [['R', probe.roi.r, '#EF5350'], ['G', probe.roi.g, '#66BB6A'], ['B', probe.roi.b, '#42A5F5']];
  const maxVal = Math.max(probe.roi.r, probe.roi.g, probe.roi.b);
  return (
    <View>
      <View style={styles.chanRow}>
        {chans.map(([name, val, col]) => {
          const isMax = val === maxVal;
          return (
            <View key={name} style={[styles.chanCell, isMax && styles.chanCellMax]}>
              <Text style={[styles.chanName, { color: col }]}>{name}{isMax ? ' ▲' : ''}</Text>
              <Text style={styles.chanVal}>{val.toFixed(0)}</Text>
              <Text style={styles.chanPct}>{((val / 255) * 100).toFixed(0)}%</Text>
            </View>
          );
        })}
      </View>
      <Text style={[styles.clipLine, { color: probe.roi_saturation_pct > 1 ? '#C62828' : '#78909C' }]}>
        Clipping: {Number(probe.roi_saturation_pct).toFixed(2)}%
        {probe.roi_saturation_pct > 1 ? ' ⚠ over 1% — measurements will fail' : ''}
      </Text>
    </View>
  );
}

// Live per-channel A = log10(I_ref / I_now), largest-A channel highlighted.
function ReferenceReadout({ reference, probe }) {
  const { A, maxCh } = computeReferenceA(reference, probe.roi);
  const chans = [['R', A.r, 'r', '#EF5350'], ['G', A.g, 'g', '#66BB6A'], ['B', A.b, 'b', '#42A5F5']];
  return (
    <View>
      <Text style={styles.refLabel}>Absorbance vs reference  A = log₁₀(I_ref / I_now)</Text>
      <View style={styles.chanRow}>
        {chans.map(([name, a, key, col]) => {
          const isMax = key === maxCh;
          return (
            <View key={name} style={[styles.chanCell, isMax && styles.chanCellMaxA]}>
              <Text style={[styles.chanName, { color: col }]}>{name}{isMax ? ' ★' : ''}</Text>
              <Text style={styles.chanValA}>{a === null ? '—' : a.toFixed(3)}</Text>
            </View>
          );
        })}
      </View>
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
  logoWrap: { alignItems: 'center', backgroundColor: '#FFF', borderRadius: 16, paddingVertical: 22, marginBottom: 16, elevation: 2 },
  logo: { width: 240, height: 68 },
  logoSub: { color: '#546E7A', fontSize: 13, marginTop: 6, fontWeight: '600' },
  logoWrapSmall: { alignItems: 'center', marginBottom: 12 },
  logoSmall: { width: 160, height: 44 },
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
  tooltipText: { color: '#78909C', fontSize: 12, lineHeight: 17, marginBottom: 8, fontStyle: 'italic' },
  errInlineText: { color: '#C62828', fontSize: 12, marginTop: 8, fontWeight: '600' },
  warnInlineText: { color: '#EF6C00', fontSize: 12, marginTop: 8, fontWeight: '600' },
  infoInlineText: { color: '#78909C', fontSize: 11, marginTop: 8, lineHeight: 16 },
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

  // Live readout
  readoutHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  refreshBtn: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 14, minWidth: 84, alignItems: 'center' },
  refreshBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
  readoutHint: { color: '#90A4AE', fontSize: 12, lineHeight: 17 },
  chanRow: { flexDirection: 'row', gap: 8 },
  chanCell: { flex: 1, backgroundColor: '#F5F7FA', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 2, borderColor: 'transparent' },
  chanCellMax: { borderColor: '#1565C0', backgroundColor: '#E3F2FD' },
  chanCellMaxA: { borderColor: '#6A1B9A', backgroundColor: '#F3E5F5' },
  chanName: { fontSize: 12, fontWeight: 'bold' },
  chanVal: { fontSize: 20, fontWeight: 'bold', color: '#1A237E', marginTop: 2 },
  chanValA: { fontSize: 18, fontWeight: 'bold', color: '#4A148C', marginTop: 2 },
  chanPct: { fontSize: 11, color: '#78909C', marginTop: 1 },
  clipLine: { fontSize: 12, marginTop: 8, fontWeight: '600' },

  refDivider: { height: 1, backgroundColor: '#ECEFF1', marginVertical: 14 },
  refLabel: { color: '#6A1B9A', fontSize: 12, fontWeight: '600', marginBottom: 8 },
  warnChip: { backgroundColor: '#FFF3E0', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#EF6C00' },
  warnChipText: { color: '#E65100', fontSize: 12, fontWeight: '600' },
  refBtnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  refBtn: { flex: 1, backgroundColor: '#6A1B9A', borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  refBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
  refClearBtn: { borderWidth: 1, borderColor: '#90A4AE', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16 },
  refClearBtnText: { color: '#546E7A', fontWeight: '600', fontSize: 13 },
  refAge: { color: '#90A4AE', fontSize: 11, marginTop: 8 },

  probesToggle: { marginTop: 12 },
  probesBox: { marginTop: 8, backgroundColor: '#F5F5F5', borderRadius: 10, padding: 12 },
  probeLogLine: { color: '#546E7A', fontSize: 11, lineHeight: 18, fontFamily: 'monospace' },
  exportProbesBtn: { flex: 1, backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  exportProbesBtnText: { color: '#FFF', fontWeight: '700', fontSize: 12 },

  saveBtn: { backgroundColor: '#2E7D32', borderRadius: 14, paddingVertical: 16, alignItems: 'center', elevation: 2 },
  saveBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
});
