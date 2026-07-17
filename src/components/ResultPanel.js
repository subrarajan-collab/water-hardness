import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import Accordion from './Accordion';
import { classifyHardness, blankAgeText } from '../utils/readiness';

// Gate verdicts mirror the firmware's own thresholds (DARK_WARN=15,
// SAT_LIMIT_PCT=1%, BLANK_STALE_S=24h) so what we display agrees with what
// /measure actually enforced.
export function gateVerdicts(result) {
  const satOk = (result.satFraction ?? 0) < 0.01;
  const dark = result.darkLevel;
  const darkOk = !dark || (dark.r <= 15 && dark.g <= 15 && dark.b <= 15);
  const age = result.blankAgeS;
  const blankOk = typeof age === 'number' && age >= 0 && age <= 86400;
  return { satOk, darkOk, blankOk };
}

// One plain-language line summarising measurement quality — the specific
// problem and what to do about it, never a cause code.
function gateLine(result) {
  const { satOk, darkOk, blankOk } = gateVerdicts(result);
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (satOk && darkOk && blankOk && warnings.length === 0) {
    return { text: '✓ Measurement clean', color: '#2E7D32' };
  }
  if (!satOk) return { text: '⚠ Too much light reached the sensor — re-run Set regions & exposure in Setup', color: '#C62828' };
  if (!darkOk) return { text: '⚠ Outside light is leaking into the box — check the enclosure is fully closed', color: '#EF6C00' };
  if (!blankOk) return { text: '⚠ Reference water is old — capture a new one, then measure again', color: '#EF6C00' };
  return { text: `⚠ ${warnings[0]}`, color: '#EF6C00' };
}

// Shared result block. Primary = ppm (large) + hardness class chip + gate
// line. Everything numeric/expert lives in the "Details" accordion.
// When hardnessPPM is null the panel shows an explicit "not calibrated"
// banner and promotes absorbance as the only number available.
export default function ResultPanel({ result, hardnessPPM, deviceCalibrated, thumbUri, masterHash }) {
  if (!result) return null;
  const cls = classifyHardness(hardnessPPM);
  const gate = gateLine(result);
  const hasPpm = hardnessPPM !== null && hardnessPPM !== undefined;

  return (
    <View>
      {/* Primary reading */}
      <View style={[styles.primaryCard, { borderTopColor: cls?.color || '#90A4AE' }]}>
        {hasPpm ? (
          <>
            <View style={styles.ppmRow}>
              <Text style={styles.ppmBig}>{hardnessPPM}</Text>
              <Text style={styles.ppmUnit}> mg/L CaCO₃</Text>
            </View>
            {cls && (
              <View style={[styles.classChip, { backgroundColor: cls.color }]}>
                <Text style={styles.classChipText}>{cls.label} · {cls.range}</Text>
              </View>
            )}
            {!deviceCalibrated && (
              <Text style={styles.linkNote}>
                Box not linked to the calibration — reading may be less accurate. Link it in the Calibration tab.
              </Text>
            )}
          </>
        ) : (
          <>
            <View style={styles.notCalBanner}>
              <Text style={styles.notCalBannerText}>
                Not calibrated — no ppm. Showing light absorbance only.{'\n'}
                Run a calibration in the Calibration tab to get hardness readings.
              </Text>
            </View>
            <View style={styles.ppmRow}>
              <Text style={styles.ppmBig}>
                {typeof result.absorbance === 'number' ? result.absorbance.toFixed(3) : '—'}
              </Text>
              <Text style={styles.ppmUnit}> absorbance</Text>
            </View>
          </>
        )}
        <Text style={[styles.gateLine, { color: gate.color }]}>{gate.text}</Text>
      </View>

      {/* Expert details, tucked away */}
      <Accordion title="Details">
        <Row name="Absorbance (blue)" value={fmt(result.absorbance, 3)} />
        <Row name="Absorbance (red · green)" value={`${fmt(result.absorbanceR, 3)} · ${fmt(result.absorbanceG, 3)}`} />
        <Row
          name="Repeatability (σ)"
          value={typeof result.absorbanceStdDev === 'number'
            ? result.absorbanceStdDev.toFixed(4)
            : '— needs box fw 1.3+'}
        />
        <Row
          name="Frames used"
          value={result.frameCount != null
            ? `${result.frameCount}${result.rejectedFrames ? ` (${result.rejectedFrames} rejected)` : ''}`
            : '—'}
        />
        <Row name="Sample colour (R/G/B)" value={`${result.r} / ${result.g} / ${result.b}`} />
        <Row name="Sensor clipping" value={`${((result.satFraction ?? 0) * 100).toFixed(2)}%`} />
        {result.darkLevel && (
          <Row name="Dark level (R/G/B)" value={`${fmt(result.darkLevel.r, 0)} / ${fmt(result.darkLevel.g, 0)} / ${fmt(result.darkLevel.b, 0)}`} />
        )}
        <Row name="Reference water age" value={blankAgeText(result.blankAgeS)} />
        {masterHash && <Row name="Calibration version" value={masterHash} />}
        {Array.isArray(result.warnings) && result.warnings.length > 0 && (
          <Text style={styles.warnList}>Warnings: {result.warnings.join(' · ')}</Text>
        )}
        {thumbUri && (
          <Image source={{ uri: thumbUri }} style={styles.preview} resizeMode="cover" />
        )}
      </Accordion>
    </View>
  );
}

function fmt(v, d) {
  return typeof v === 'number' ? v.toFixed(d) : '—';
}

function Row({ name, value }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricName}>{name}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  primaryCard: {
    backgroundColor: '#FFF', borderRadius: 16, padding: 22,
    marginBottom: 16, elevation: 3, borderTopWidth: 4, alignItems: 'center',
  },
  ppmRow: { flexDirection: 'row', alignItems: 'baseline' },
  ppmBig: { fontSize: 52, fontWeight: 'bold', color: '#1A237E' },
  ppmUnit: { fontSize: 15, color: '#78909C', fontWeight: '600' },
  classChip: { borderRadius: 20, paddingVertical: 7, paddingHorizontal: 16, marginTop: 10 },
  classChipText: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
  linkNote: { color: '#EF6C00', fontSize: 12, marginTop: 10, textAlign: 'center', lineHeight: 17 },

  notCalBanner: {
    backgroundColor: '#FFF3E0', borderRadius: 10, padding: 12, marginBottom: 12,
    borderLeftWidth: 4, borderLeftColor: '#EF6C00', alignSelf: 'stretch',
  },
  notCalBannerText: { color: '#E65100', fontSize: 13, lineHeight: 19, fontWeight: '600' },

  gateLine: { fontSize: 13, fontWeight: '700', marginTop: 14, textAlign: 'center' },

  metricRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 },
  metricName: { color: '#546E7A', fontSize: 13 },
  metricValue: { color: '#1A237E', fontSize: 13, fontWeight: 'bold' },
  warnList: { color: '#EF6C00', fontSize: 12, marginTop: 6 },
  preview: { width: '100%', height: 150, borderRadius: 8, marginTop: 12, backgroundColor: '#F0F0F0' },
});
