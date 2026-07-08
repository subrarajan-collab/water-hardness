import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, Image, ActivityIndicator, Alert,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import { analyzeImageColors, getHardnessLabel } from '../utils/colorAnalysis';
import { loadCalibrationPoints, saveTestResult } from '../utils/calibration';
import {
  loadDeviceCal, computeHardnessDeviceAware, masterCurveHash, getDeviceModel,
} from '../utils/deviceCalibration';

const APP_VERSION = require('../../package.json').version;

// Camera output lives in the app cache, which Android may clear at any time.
// Copy the preview into the persistent document directory before saving history.
async function persistImage(uri) {
  if (!uri) return null;
  try {
    const dir = FileSystem.documentDirectory + 'results/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const dest = dir + Date.now() + '.jpg';
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri; // fall back to the volatile uri rather than losing the entry
  }
}

export default function ResultScreen({ route, navigation }) {
  // New averaged-video path: { analysisData, sampleUri, frameCount }
  // Old single-frame path:    { croppedUri, originalUri }
  const { analysisData, sampleUri, frameCount, croppedUri, originalUri, captureFor } = route.params;

  const [result, setResult]           = useState(null);
  const [hardnessPPM, setHardnessPPM] = useState(null);
  const [label, setLabel]             = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [saved, setSaved]             = useState(false);
  const [ppmSource, setPpmSource]     = useState(null); // 'absorbance' | 'blue' | null
  const [deviceCal, setDeviceCal]     = useState(null);
  const [deviceCalibrated, setDeviceCalibrated] = useState(false);
  const [masterHash, setMasterHash]   = useState(null);

  // Determine which image to display as the analysed-region preview
  const previewUri = sampleUri ?? croppedUri ?? null;

  useEffect(() => {
    runAnalysis();
  }, []);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      let data;

      if (analysisData) {
        // ── New path: averaged data already computed in CameraScreen ──
        data = analysisData;
      } else {
        // ── Legacy path: single cropped image ──
        data = await analyzeImageColors(croppedUri);
      }

      const calPoints = await loadCalibrationPoints();
      const dCal = await loadDeviceCal();
      setDeviceCal(dCal);
      setMasterHash(masterCurveHash(calPoints));

      // Device-aware pipeline: invert A_device = m·A_master + c, then look up
      // ppm on the master curve. Falls back to the master curve directly.
      const res = computeHardnessDeviceAware(data, calPoints, dCal);
      const ppm = res?.ppm ?? null;
      setDeviceCalibrated(res?.deviceCalibrated ?? false);

      const lbl = getHardnessLabel(data.blueDominance);
      // Detect whether ppm came from the exposure-immune absorbance curve
      const usingAbs =
        typeof data.absorbance === 'number' &&
        calPoints.length >= 2 &&
        calPoints.every((p) => typeof p.absorbance === 'number');
      setResult(data);
      setHardnessPPM(ppm);
      setLabel(lbl);
      setPpmSource(ppm !== null ? (usingAbs ? 'absorbance' : 'blue') : null);
    } catch (e) {
      setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const saveResult = async () => {
    if (!result || saved) return;
    const persistedUri = await persistImage(previewUri);
    await saveTestResult({
      blueScore: result.blueScore,
      blueDominance: result.blueDominance,
      r: result.r, g: result.g, b: result.b,
      hardnessPPM,
      label: label?.label,
      imageUri: persistedUri,
      frameCount: result.frameCount ?? 1,
      rejectedFrames: result.rejectedFrames ?? 0,
      blueScoreStdDev: result.blueScoreStdDev,
      absorbance: result.absorbance ?? null,
      absorbanceR: result.absorbanceR ?? null,
      absorbanceG: result.absorbanceG ?? null,
      transmittance: result.transmittance ?? null,
      bgBlue: result.bgBlue ?? null,
      refMismatch: result.refMismatch ?? null,
      // Raw per-frame patch + ROI values (kept frames), for offline analysis
      frames: result.frames ?? null,
      ppmSource,
      // Traceability: which device, factor, curve and app produced this number
      deviceModel: getDeviceModel(),
      deviceFactor: deviceCal ? { m: deviceCal.m, c: deviceCal.c } : null,
      deviceCalibrated,
      masterCurveHash: masterHash,
      appVersion: APP_VERSION,
    });
    setSaved(true);
    Alert.alert('Saved', 'Result added to history.');
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#1565C0" />
            <Text style={styles.loadingText}>Analysing colour intensity…</Text>
          </View>

        ) : error ? (
          <View style={styles.loadingBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={runAnalysis}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>

        ) : result ? (
          <>
            {/* ── Device-calibration flow handoff ── */}
            {captureFor && typeof result.absorbance === 'number' && (
              <TouchableOpacity
                style={styles.captureForBtn}
                onPress={() =>
                  navigation.navigate('DeviceCalibration', {
                    captured: { for: captureFor, absorbance: result.absorbance },
                  })
                }
              >
                <Text style={styles.captureForBtnText}>
                  {captureFor === 'device-blank' ? `✓ Use as BLANK (A = ${result.absorbance.toFixed(3)})`
                    : captureFor === 'device-standard' ? `✓ Use as STANDARD (A = ${result.absorbance.toFixed(3)})`
                    : `✓ Use as VALIDATION run (A = ${result.absorbance.toFixed(3)})`}
                </Text>
              </TouchableOpacity>
            )}

            {/* ── Per-phone calibration status ── */}
            {hardnessPPM !== null && !deviceCalibrated && (
              <TouchableOpacity
                style={styles.notCalBadge}
                onPress={() => navigation.navigate('DeviceCalibration')}
              >
                <Text style={styles.notCalBadgeText}>
                  ⚠ Not calibrated for this phone — using master curve directly. Tap to calibrate.
                </Text>
              </TouchableOpacity>
            )}

            {/* ── Averaged badge (only for multi-frame results) ── */}
            {result.frameCount > 1 && (
              <View style={styles.avgBadge}>
                <Text style={styles.avgBadgeText}>
                  📊 Averaged over {result.frameCount} frames
                  {result.rejectedFrames > 0 ? ` (${result.rejectedFrames} outlier${result.rejectedFrames > 1 ? 's' : ''} rejected)` : ''}
                  {result.blueScoreStdDev !== undefined
                    ? `  ·  σ = ${result.blueScoreStdDev}`
                    : ''}
                </Text>
              </View>
            )}

            {/* ── Colour swatch + label ── */}
            <View style={[styles.resultCard, { borderTopColor: label?.color }]}>
              <View style={styles.swatchRow}>
                <View style={[styles.swatch, { backgroundColor: `rgb(${result.r},${result.g},${result.b})` }]} />
                <View style={styles.labelCol}>
                  <Text style={[styles.hardnessLabel, { color: label?.color }]}>{label?.label}</Text>
                  <Text style={styles.rangeText}>{label?.range} (estimated)</Text>
                  {typeof result.absorbance === 'number' && (
                    <Text style={styles.absPrimary}>A_blue = {result.absorbance.toFixed(3)}</Text>
                  )}
                  {hardnessPPM !== null
                    ? <>
                        <Text style={styles.ppmText}>{hardnessPPM} ppm CaCO₃</Text>
                        <Text style={styles.ppmSrc}>
                          {ppmSource === 'absorbance'
                            ? (deviceCalibrated ? 'absorbance curve + device factor ✓' : 'absorbance curve (no device factor)')
                            : 'from raw blue (drift-prone)'}
                        </Text>
                      </>
                    : <Text style={styles.uncalText}>Add calibration points for ppm reading</Text>
                  }
                </View>
              </View>
            </View>

            {/* ── Metrics ── */}
            <View style={styles.metricsCard}>
              <Text style={styles.metricsTitle}>Colour Analysis</Text>

              {/* Absorbance (exposure-immune) — the PRIMARY metric */}
              {typeof result.absorbance === 'number' && (
                <>
                  <View style={styles.metricRow}>
                    <Text style={[styles.metricName, { fontWeight: '700', color: '#1565C0', fontSize: 14 }]}>
                      Absorbance  A_blue = log₁₀(I_ref / I_water)
                    </Text>
                    <Text style={[styles.metricValue, { fontSize: 18 }]}>{result.absorbance.toFixed(3)}</Text>
                  </View>
                  <View style={styles.barBg}>
                    <View style={[styles.barFill, {
                      width: `${Math.min(100, (result.absorbance / 1.5) * 100)}%`,
                      backgroundColor: '#6A1B9A',
                    }]} />
                  </View>

                  {(typeof result.absorbanceR === 'number' || typeof result.absorbanceG === 'number') && (
                    <View style={styles.metricRow}>
                      <Text style={styles.metricName}>A_red · A_green (per channel)</Text>
                      <Text style={styles.metricValue}>
                        {typeof result.absorbanceR === 'number' ? result.absorbanceR.toFixed(3) : '—'}
                        {' · '}
                        {typeof result.absorbanceG === 'number' ? result.absorbanceG.toFixed(3) : '—'}
                      </Text>
                    </View>
                  )}
                  <View style={styles.metricRow}>
                    <Text style={styles.metricName}>Blue Transmittance (water / ref)</Text>
                    <Text style={styles.metricValue}>
                      {typeof result.transmittance === 'number' ? `${(result.transmittance * 100).toFixed(1)}%` : '—'}
                    </Text>
                  </View>
                  <View style={styles.metricRow}>
                    <Text style={styles.metricName}>Reference Blue · Water Blue</Text>
                    <Text style={styles.metricValue}>{result.bgBlue} · {result.blueScore}</Text>
                  </View>
                  {typeof result.refMismatch === 'number' && (
                    <View style={styles.metricRow}>
                      <Text style={styles.metricName}>L/R patch mismatch</Text>
                      <Text style={[styles.metricValue, {
                        color: result.refMismatch <= 0.04 ? '#2E7D32' : '#C62828',
                      }]}>
                        {(result.refMismatch * 100).toFixed(1)}%
                        {result.refMismatch <= 0.04 ? ' ✓' : ' ⚠'}
                      </Text>
                    </View>
                  )}
                  {typeof result.absorbanceStdDev === 'number' && (
                    <Text style={styles.absNote}>
                      Absorbance σ = {result.absorbanceStdDev.toFixed(3)} across frames — immune to auto-exposure drift.
                    </Text>
                  )}
                  <View style={styles.absDivider} />
                </>
              )}

              {/* Raw values — secondary once absorbance is available */}
              <View style={styles.metricRow}>
                <Text style={styles.metricName}>
                  Blue Score (0–255){typeof result.absorbance === 'number' ? ' — secondary' : ''}
                </Text>
                <Text style={styles.metricValue}>{result.blueScore}</Text>
              </View>
              <View style={styles.barBg}>
                <View style={[styles.barFill, { width: `${(result.blueScore / 255) * 100}%`, backgroundColor: '#1565C0' }]} />
              </View>

              <View style={styles.metricRow}>
                <Text style={styles.metricName}>Blue Dominance</Text>
                <Text style={styles.metricValue}>{result.blueDominance}%</Text>
              </View>
              <View style={styles.barBg}>
                <View style={[styles.barFill, { width: `${result.blueDominance}%`, backgroundColor: '#29B6F6' }]} />
              </View>

              {/* Stability indicator (std dev) */}
              {result.blueScoreStdDev !== undefined && (
                <>
                  <View style={styles.metricRow}>
                    <Text style={styles.metricName}>Reading Stability (σ)</Text>
                    <Text style={[
                      styles.metricValue,
                      { color: result.blueScoreStdDev < 5 ? '#2E7D32' : result.blueScoreStdDev < 12 ? '#FF8F00' : '#C62828' },
                    ]}>
                      {result.blueScoreStdDev}
                      {'  '}
                      {result.blueScoreStdDev < 5 ? '✓ Stable' : result.blueScoreStdDev < 12 ? '~ Fair' : '⚠ Unstable'}
                    </Text>
                  </View>
                  <View style={styles.barBg}>
                    <View style={[styles.barFill, {
                      width: `${Math.min(100, (result.blueScoreStdDev / 30) * 100)}%`,
                      backgroundColor: result.blueScoreStdDev < 5 ? '#2E7D32' : result.blueScoreStdDev < 12 ? '#FF8F00' : '#C62828',
                    }]} />
                  </View>
                </>
              )}

              <View style={styles.rgbRow}>
                {[['R', result.r, '#EF5350'], ['G', result.g, '#66BB6A'], ['B', result.b, '#42A5F5']].map(([ch, val, col]) => (
                  <View key={ch} style={styles.rgbItem}>
                    <View style={[styles.rgbDot, { backgroundColor: col }]} />
                    <Text style={styles.rgbLabel}>{ch}</Text>
                    <Text style={styles.rgbVal}>{val}</Text>
                  </View>
                ))}
              </View>
            </View>

            {/* ── Preview frame ── */}
            {previewUri && (
              <View style={styles.previewCard}>
                <Text style={styles.metricsTitle}>
                  {result.frameCount > 1 ? 'Sample Frame (mid-recording)' : 'Analysed Region'}
                </Text>
                <Image source={{ uri: previewUri }} style={styles.preview} resizeMode="contain" />
                <Text style={styles.pixelCount}>
                  {result.pixelCount.toLocaleString()} pixels analysed per frame
                  {result.frameCount > 1 ? ` · ${result.frameCount} frames` : ''}
                </Text>
              </View>
            )}

            {/* ── Actions ── */}
            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.saveBtn, saved && styles.savedBtn]}
                onPress={saveResult}
                disabled={saved}
              >
                <Text style={styles.actionBtnText}>{saved ? '✓ Saved' : '💾 Save'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.calBtn]}
                onPress={() => navigation.navigate('Calibration', {
                  blueScore: result.blueScore,
                  absorbance: result.absorbance ?? null,
                })}
              >
                <Text style={styles.actionBtnText}>⚙️ Calibrate</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.newTestBtn} onPress={() => navigation.navigate('Camera')}>
              <Text style={styles.newTestBtnText}>📷  New Test</Text>
            </TouchableOpacity>
          </>
        ) : null}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },

  loadingBox: { alignItems: 'center', paddingVertical: 80 },
  loadingText: { marginTop: 16, color: '#546E7A', fontSize: 15 },
  errorText: { color: '#C62828', fontSize: 15, textAlign: 'center', marginBottom: 20 },
  retryBtn: { backgroundColor: '#1565C0', borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
  retryBtnText: { color: '#FFF', fontWeight: 'bold' },

  avgBadge: {
    backgroundColor: '#E8F5E9', borderRadius: 10, padding: 10,
    marginBottom: 14, borderLeftWidth: 4, borderLeftColor: '#2E7D32',
  },
  avgBadgeText: { color: '#2E7D32', fontSize: 13, fontWeight: '600' },

  resultCard: {
    backgroundColor: '#FFF', borderRadius: 16, padding: 20,
    marginBottom: 16, elevation: 3, borderTopWidth: 4,
  },
  swatchRow: { flexDirection: 'row', alignItems: 'center' },
  swatch: { width: 70, height: 70, borderRadius: 35, marginRight: 20, elevation: 2 },
  labelCol: { flex: 1 },
  hardnessLabel: { fontSize: 22, fontWeight: 'bold' },
  rangeText: { color: '#78909C', fontSize: 13, marginTop: 2 },
  absPrimary: { color: '#6A1B9A', fontSize: 20, fontWeight: 'bold', marginTop: 4 },
  captureForBtn: {
    backgroundColor: '#6A1B9A', borderRadius: 12, padding: 14,
    marginBottom: 14, alignItems: 'center', elevation: 3,
  },
  captureForBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  notCalBadge: {
    backgroundColor: '#FFF3E0', borderRadius: 10, padding: 10,
    marginBottom: 14, borderLeftWidth: 4, borderLeftColor: '#EF6C00',
  },
  notCalBadgeText: { color: '#E65100', fontSize: 12, fontWeight: '600' },
  ppmText: { color: '#1565C0', fontSize: 16, fontWeight: 'bold', marginTop: 4 },
  ppmSrc: { color: '#78909C', fontSize: 11, marginTop: 1 },
  uncalText: { color: '#FF8F00', fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  absDivider: { height: 1, backgroundColor: '#E0E0E0', marginVertical: 12 },
  absNote: { color: '#78909C', fontSize: 11, marginTop: 2, marginBottom: 4, lineHeight: 15 },

  metricsCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 20, marginBottom: 16, elevation: 2 },
  metricsTitle: { fontSize: 15, fontWeight: 'bold', color: '#1565C0', marginBottom: 14 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  metricName: { color: '#546E7A', fontSize: 13 },
  metricValue: { color: '#1A237E', fontSize: 13, fontWeight: 'bold' },
  barBg: { height: 10, backgroundColor: '#E3F2FD', borderRadius: 5, marginBottom: 14, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 5 },
  rgbRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 4 },
  rgbItem: { alignItems: 'center', gap: 4 },
  rgbDot: { width: 16, height: 16, borderRadius: 8 },
  rgbLabel: { color: '#78909C', fontSize: 11 },
  rgbVal: { color: '#1A237E', fontSize: 16, fontWeight: 'bold' },

  previewCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 16, marginBottom: 16, elevation: 2 },
  preview: { width: '100%', height: 120, borderRadius: 8, marginTop: 8, backgroundColor: '#F0F0F0' },
  pixelCount: { color: '#90A4AE', fontSize: 11, textAlign: 'center', marginTop: 6 },

  actionsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  actionBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32' },
  savedBtn: { backgroundColor: '#546E7A' },
  calBtn: { backgroundColor: '#6A1B9A' },
  actionBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  newTestBtn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 16, alignItems: 'center', elevation: 2 },
  newTestBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
});
