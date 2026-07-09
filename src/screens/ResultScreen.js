import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, Image, ActivityIndicator, Alert,
} from 'react-native';
import { getHardnessLabel } from '../utils/colorAnalysis';
import { loadCalibrationPoints, saveTestResult } from '../utils/calibration';
import {
  loadDeviceCal, computeHardnessDeviceAware, masterCurveHash,
} from '../utils/deviceCalibration';
import { thumbUrl } from '../api/boxClient';

const APP_VERSION = require('../../package.json').version;

export default function ResultScreen({ route, navigation }) {
  const {
    analysisData, boxMeta, captureFor,
    deviceKey, skipDeviceLoad, preloadedDeviceCal, preloadedMaster,
  } = route.params;

  const [result, setResult]           = useState(null);
  const [hardnessPPM, setHardnessPPM] = useState(null);
  const [label, setLabel]             = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [saved, setSaved]             = useState(false);
  const [deviceCal, setDeviceCal]     = useState(null);
  const [deviceCalibrated, setDeviceCalibrated] = useState(false);
  const [masterHash, setMasterHash]   = useState(null);

  useEffect(() => {
    runAnalysis();
  }, []);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = analysisData;
      const calPoints = preloadedMaster ?? (await loadCalibrationPoints());
      const dCal = skipDeviceLoad ? (preloadedDeviceCal ?? null) : await loadDeviceCal(deviceKey);
      setDeviceCal(dCal);
      setMasterHash(masterCurveHash(calPoints));

      // Invert A_device = m·A_master + c, then look up ppm on the master
      // curve. Falls back to the master curve directly with no device factor.
      const res = computeHardnessDeviceAware(data, calPoints, dCal);
      const ppm = res?.ppm ?? null;
      setDeviceCalibrated(res?.deviceCalibrated ?? false);

      setResult(data);
      setHardnessPPM(ppm);
      setLabel(getHardnessLabel(data.blueDominance));
    } catch (e) {
      setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const saveResult = async () => {
    if (!result || saved) return;
    await saveTestResult({
      blueScore: result.blueScore,
      blueDominance: result.blueDominance,
      r: result.r, g: result.g, b: result.b,
      hardnessPPM,
      label: label?.label,
      frameCount: result.frameCount ?? null,
      rejectedFrames: result.rejectedFrames ?? 0,
      absorbanceStdDev: result.absorbanceStdDev ?? null,
      absorbance: result.absorbance ?? null,
      absorbanceR: result.absorbanceR ?? null,
      absorbanceG: result.absorbanceG ?? null,
      // Traceability: which box, factor, curve, and app version produced this
      boxId: boxMeta?.box_id ?? null,
      fwVersion: boxMeta?.fw_version ?? null,
      deviceKey: deviceKey ?? null,
      deviceFactor: deviceCal ? { m: deviceCal.m, c: deviceCal.c } : null,
      deviceCalibrated,
      masterCurveHash: masterHash,
      appVersion: APP_VERSION,
      // Box diagnostics
      satFraction: result.satFraction ?? null,
      darkLevel: result.darkLevel ?? null,
      blankAgeS: result.blankAgeS ?? null,
      deviceWarnings: result.warnings ?? null,
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
            <Text style={styles.loadingText}>Analysing…</Text>
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
                    boxIp: boxMeta?.ip, deviceKey, deviceLabel: boxMeta?.box_id,
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

            {/* ── Gate warnings from the box (prominent, not buried) ── */}
            {Array.isArray(result.warnings) && result.warnings.length > 0 && (
              <View style={styles.warnBanner}>
                <Text style={styles.warnBannerTitle}>⚠ Box warnings</Text>
                {result.warnings.map((w, i) => (
                  <Text key={i} style={styles.warnBannerText}>• {w}</Text>
                ))}
              </View>
            )}

            {/* ── Per-box calibration status ── */}
            {hardnessPPM !== null && !deviceCalibrated && (
              <TouchableOpacity
                style={styles.notCalBadge}
                onPress={() => navigation.navigate('DeviceCalibration', {
                  boxIp: boxMeta?.ip, deviceKey, deviceLabel: boxMeta?.box_id,
                })}
              >
                <Text style={styles.notCalBadgeText}>
                  ⚠ This box is not calibrated — using master curve directly. Tap to calibrate.
                </Text>
              </TouchableOpacity>
            )}

            {/* ── Frame summary ── */}
            {result.frameCount > 1 && (
              <View style={styles.avgBadge}>
                <Text style={styles.avgBadgeText}>
                  📊 Averaged over {result.frameCount} frames
                  {result.rejectedFrames > 0 ? ` (${result.rejectedFrames} outlier${result.rejectedFrames > 1 ? 's' : ''} rejected)` : ''}
                </Text>
              </View>
            )}

            {/* ── A_blue primary + ppm ── */}
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
                          {deviceCalibrated ? 'master curve + device factor ✓' : 'master curve (no device factor)'}
                        </Text>
                      </>
                    : <Text style={styles.uncalText}>Add calibration points for ppm reading</Text>
                  }
                </View>
              </View>
            </View>

            {/* ── Metrics ── */}
            <View style={styles.metricsCard}>
              <Text style={styles.metricsTitle}>Measurement</Text>

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

              {typeof result.absorbanceStdDev === 'number' && (
                <>
                  <View style={styles.metricRow}>
                    <Text style={styles.metricName}>Stability (σ across kept frames)</Text>
                    <Text style={[styles.metricValue, {
                      color: result.absorbanceStdDev < 0.01 ? '#2E7D32'
                        : result.absorbanceStdDev < 0.03 ? '#FF8F00' : '#C62828',
                    }]}>
                      {result.absorbanceStdDev.toFixed(4)}
                      {result.absorbanceStdDev < 0.01 ? ' ✓ Stable' : result.absorbanceStdDev < 0.03 ? ' ~ Fair' : ' ⚠ Unstable'}
                    </Text>
                  </View>
                  <View style={styles.barBg}>
                    <View style={[styles.barFill, {
                      width: `${Math.min(100, (result.absorbanceStdDev / 0.06) * 100)}%`,
                      backgroundColor: result.absorbanceStdDev < 0.01 ? '#2E7D32' : result.absorbanceStdDev < 0.03 ? '#FF8F00' : '#C62828',
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

            {/* ── Diagnostics (gates ✓/⚠) ── */}
            <View style={styles.metricsCard}>
              <Text style={styles.metricsTitle}>Diagnostics</Text>
              <View style={styles.metricRow}>
                <Text style={styles.metricName}>ROI saturation</Text>
                <Text style={[styles.metricValue, {
                  color: (result.satFraction ?? 0) < 0.01 ? '#2E7D32' : '#C62828',
                }]}>
                  {((result.satFraction ?? 0) * 100).toFixed(2)}%
                  {(result.satFraction ?? 0) < 0.01 ? ' ✓' : ' ⚠'}
                </Text>
              </View>
              {result.darkLevel && (
                <View style={styles.metricRow}>
                  <Text style={styles.metricName}>Dark level (R/G/B)</Text>
                  <Text style={styles.metricValue}>
                    {result.darkLevel.r?.toFixed?.(0)} / {result.darkLevel.g?.toFixed?.(0)} / {result.darkLevel.b?.toFixed?.(0)}
                  </Text>
                </View>
              )}
              <View style={styles.metricRow}>
                <Text style={styles.metricName}>Blank age</Text>
                <Text style={[styles.metricValue, {
                  color: (result.blankAgeS ?? -1) < 0 || (result.blankAgeS ?? 0) > 86400 ? '#C62828' : '#2E7D32',
                }]}>
                  {result.blankAgeS === null || result.blankAgeS === undefined ? '—'
                    : result.blankAgeS < 0 ? 'unknown ⚠'
                    : result.blankAgeS > 86400 ? `${(result.blankAgeS / 3600).toFixed(1)}h ⚠`
                    : `${Math.round(result.blankAgeS)}s ✓`}
                </Text>
              </View>
            </View>

            {/* ── Box view (best-effort live thumbnail, not persisted) ── */}
            {boxMeta?.ip && (
              <View style={styles.previewCard}>
                <Text style={styles.metricsTitle}>Box view (live)</Text>
                <Image source={{ uri: thumbUrl(boxMeta.ip) }} style={styles.preview} resizeMode="cover" />
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
                  absorbance: result.absorbance ?? null,
                })}
              >
                <Text style={styles.actionBtnText}>⚙️ Calibrate</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.newTestBtn} onPress={() => navigation.navigate('Home')}>
              <Text style={styles.newTestBtnText}>📡  New Measurement</Text>
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
  warnBanner: {
    backgroundColor: '#FFEBEE', borderRadius: 10, padding: 12,
    marginBottom: 14, borderLeftWidth: 4, borderLeftColor: '#C62828',
  },
  warnBannerTitle: { color: '#B71C1C', fontSize: 13, fontWeight: 'bold', marginBottom: 4 },
  warnBannerText: { color: '#B71C1C', fontSize: 12, lineHeight: 17 },
  ppmText: { color: '#1565C0', fontSize: 16, fontWeight: 'bold', marginTop: 4 },
  ppmSrc: { color: '#78909C', fontSize: 11, marginTop: 1 },
  uncalText: { color: '#FF8F00', fontSize: 12, marginTop: 4, fontStyle: 'italic' },

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
  preview: { width: '100%', height: 160, borderRadius: 8, marginTop: 8, backgroundColor: '#F0F0F0' },

  actionsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  actionBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', elevation: 2 },
  saveBtn: { backgroundColor: '#2E7D32' },
  savedBtn: { backgroundColor: '#546E7A' },
  calBtn: { backgroundColor: '#6A1B9A' },
  actionBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  newTestBtn: { backgroundColor: '#1565C0', borderRadius: 14, paddingVertical: 16, alignItems: 'center', elevation: 2 },
  newTestBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
});
