import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';

// Small status-colour pill for a pass/fail gate — green ok / amber warn / red
// fail, per the "consistent design" spec. Used for saturation, dark level,
// and blank-freshness so the three gates read at a glance instead of prose.
function GateBadge({ label, status }) {
  // status: 'ok' | 'warn' | 'fail'
  const color = status === 'ok' ? '#2E7D32' : status === 'warn' ? '#EF6C00' : '#C62828';
  const bg = status === 'ok' ? '#E8F5E9' : status === 'warn' ? '#FFF3E0' : '#FFEBEE';
  const icon = status === 'ok' ? '✓' : status === 'warn' ? '~' : '⚠';
  return (
    <View style={[gateStyles.pill, { backgroundColor: bg, borderColor: color }]}>
      <Text style={[gateStyles.pillText, { color }]}>{icon} {label}</Text>
    </View>
  );
}

const gateStyles = StyleSheet.create({
  pill: {
    borderRadius: 20, borderWidth: 1, paddingVertical: 6, paddingHorizontal: 12,
  },
  pillText: { fontSize: 12, fontWeight: '700' },
});

// Computes the three gate verdicts from a result object (mirrors the
// firmware's own gate thresholds: DARK_WARN=15, SAT_LIMIT_PCT=1%,
// BLANK_STALE_S=24h) so the badges agree with what /measure actually
// enforced.
export function gateVerdicts(result) {
  const satOk = (result.satFraction ?? 0) < 0.01;
  const dark = result.darkLevel;
  const darkOk = !dark || (dark.r <= 15 && dark.g <= 15 && dark.b <= 15);
  const age = result.blankAgeS;
  const blankOk = typeof age === 'number' && age >= 0 && age <= 86400;
  const blankUnknown = typeof age !== 'number' || age < 0;
  return {
    saturation: satOk ? 'ok' : 'fail',
    darkLevel: darkOk ? 'ok' : 'warn',
    blankFresh: blankOk ? 'ok' : blankUnknown ? 'fail' : 'warn',
  };
}

// Shared "here's what a measurement produced" block, used inline on the
// Measurement tab right after a run completes, and again in the Results tab
// detail view for a saved history entry. Both call sites pass the same
// shape: { result, hardnessPPM, label, deviceCalibrated, thumbUri }.
export default function ResultPanel({ result, hardnessPPM, label, deviceCalibrated, thumbUri }) {
  if (!result) return null;
  const gates = gateVerdicts(result);

  return (
    <View>
      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <View style={styles.warnBanner}>
          <Text style={styles.warnBannerTitle}>⚠ Box warnings</Text>
          {result.warnings.map((w, i) => (
            <Text key={i} style={styles.warnBannerText}>• {w}</Text>
          ))}
        </View>
      )}

      {result.frameCount > 1 && (
        <View style={styles.avgBadge}>
          <Text style={styles.avgBadgeText}>
            📊 Averaged over {result.frameCount} frames
            {result.rejectedFrames > 0 ? ` (${result.rejectedFrames} outlier${result.rejectedFrames > 1 ? 's' : ''} rejected)` : ''}
          </Text>
        </View>
      )}

      <View style={[styles.resultCard, { borderTopColor: label?.color || '#1565C0' }]}>
        <View style={styles.swatchRow}>
          <View style={[styles.swatch, { backgroundColor: `rgb(${result.r},${result.g},${result.b})` }]} />
          <View style={styles.labelCol}>
            <Text style={[styles.hardnessLabel, { color: label?.color }]}>{label?.label}</Text>
            <Text style={styles.rangeText}>{label?.range} (estimated)</Text>
            {typeof result.absorbance === 'number' && (
              <Text style={styles.absPrimary}>A_blue = {result.absorbance.toFixed(3)}</Text>
            )}
            {hardnessPPM !== null && hardnessPPM !== undefined ? (
              <>
                <Text style={styles.ppmText}>{hardnessPPM} ppm CaCO₃</Text>
                <Text style={styles.ppmSrc}>
                  {deviceCalibrated ? 'master curve + device factor ✓' : 'master curve (no device factor)'}
                </Text>
              </>
            ) : (
              <Text style={styles.uncalText}>Add calibration points for ppm reading</Text>
            )}
          </View>
        </View>
      </View>

      {/* Gate badges — the professional, at-a-glance replacement for prose */}
      <View style={styles.gateRow}>
        <GateBadge label="Saturation" status={gates.saturation} />
        <GateBadge label="Dark level" status={gates.darkLevel} />
        <GateBadge label="Blank fresh" status={gates.blankFresh} />
      </View>

      <View style={styles.metricsCard}>
        <Text style={styles.metricsTitle}>Measurement</Text>

        {(typeof result.absorbanceR === 'number' || typeof result.absorbanceG === 'number') && (
          <View style={styles.metricRow}>
            <Text style={styles.metricName}>A_red · A_green</Text>
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
              <Text style={styles.metricName}>Stability (σ)</Text>
              <Text style={[styles.metricValue, {
                color: result.absorbanceStdDev < 0.01 ? '#2E7D32'
                  : result.absorbanceStdDev < 0.03 ? '#EF6C00' : '#C62828',
              }]}>
                {result.absorbanceStdDev.toFixed(4)}
              </Text>
            </View>
            <View style={styles.barBg}>
              <View style={[styles.barFill, {
                width: `${Math.min(100, (result.absorbanceStdDev / 0.06) * 100)}%`,
                backgroundColor: result.absorbanceStdDev < 0.01 ? '#2E7D32' : result.absorbanceStdDev < 0.03 ? '#EF6C00' : '#C62828',
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

      {thumbUri && (
        <View style={styles.previewCard}>
          <Text style={styles.metricsTitle}>Box view</Text>
          <Image source={{ uri: thumbUri }} style={styles.preview} resizeMode="cover" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  warnBanner: {
    backgroundColor: '#FFEBEE', borderRadius: 10, padding: 12,
    marginBottom: 14, borderLeftWidth: 4, borderLeftColor: '#C62828',
  },
  warnBannerTitle: { color: '#B71C1C', fontSize: 13, fontWeight: 'bold', marginBottom: 4 },
  warnBannerText: { color: '#B71C1C', fontSize: 12, lineHeight: 17 },

  avgBadge: {
    backgroundColor: '#E8F5E9', borderRadius: 10, padding: 10,
    marginBottom: 14, borderLeftWidth: 4, borderLeftColor: '#2E7D32',
  },
  avgBadgeText: { color: '#2E7D32', fontSize: 13, fontWeight: '600' },

  resultCard: {
    backgroundColor: '#FFF', borderRadius: 16, padding: 20,
    marginBottom: 14, elevation: 3, borderTopWidth: 4,
  },
  swatchRow: { flexDirection: 'row', alignItems: 'center' },
  swatch: { width: 70, height: 70, borderRadius: 35, marginRight: 20, elevation: 2 },
  labelCol: { flex: 1 },
  hardnessLabel: { fontSize: 22, fontWeight: 'bold' },
  rangeText: { color: '#78909C', fontSize: 13, marginTop: 2 },
  absPrimary: { color: '#6A1B9A', fontSize: 20, fontWeight: 'bold', marginTop: 4 },
  ppmText: { color: '#1565C0', fontSize: 16, fontWeight: 'bold', marginTop: 4 },
  ppmSrc: { color: '#78909C', fontSize: 11, marginTop: 1 },
  uncalText: { color: '#EF6C00', fontSize: 12, marginTop: 4, fontStyle: 'italic' },

  gateRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },

  metricsCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 20, marginBottom: 14, elevation: 2 },
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

  previewCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 16, marginBottom: 14, elevation: 2 },
  preview: { width: '100%', height: 160, borderRadius: 8, marginTop: 8, backgroundColor: '#F0F0F0' },
});
