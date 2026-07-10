import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

const PLOT_W = 300;
const PLOT_H = 160;
const PAD = 8;

// Lightweight scatter plot of (A_blue, ppm) calibration points — no charting
// library, just absolutely-positioned dots inside a fixed box, connected
// implicitly by rendering them in sorted order along a light guide grid.
export default function CurvePlot({ points }) {
  const pts = (points || []).filter((p) => typeof p.absorbance === 'number');
  if (pts.length < 2) {
    return (
      <View style={styles.emptyBox}>
        <Text style={styles.emptyText}>Add 2+ points to see the curve</Text>
      </View>
    );
  }

  const sorted = [...pts].sort((a, b) => a.absorbance - b.absorbance);
  const xs = sorted.map((p) => p.absorbance);
  const ys = sorted.map((p) => p.hardness);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = 0, yMax = Math.max(...ys) * 1.1 || 1;

  const toX = (a) => PAD + (xMax > xMin ? ((a - xMin) / (xMax - xMin)) * (PLOT_W - 2 * PAD) : (PLOT_W - 2 * PAD) / 2);
  const toY = (ppm) => PLOT_H - PAD - ((ppm - yMin) / (yMax - yMin || 1)) * (PLOT_H - 2 * PAD);

  return (
    <View>
      <View style={styles.plotBox}>
        {/* guide lines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <View key={f} style={[styles.gridLine, { top: PAD + f * (PLOT_H - 2 * PAD) }]} />
        ))}
        {/* connecting segments (simple straight lines via rotated views) */}
        {sorted.slice(1).map((p, i) => {
          const p0 = sorted[i];
          const x1 = toX(p0.absorbance), y1 = toY(p0.hardness);
          const x2 = toX(p.absorbance), y2 = toY(p.hardness);
          const dx = x2 - x1, dy = y2 - y1;
          const length = Math.sqrt(dx * dx + dy * dy);
          const angle = Math.atan2(dy, dx) * (180 / Math.PI);
          // RN rotates around the element's own centre (no transformOrigin
          // support), so position the segment CENTRED on the midpoint
          // between the two points rather than anchored at the start point.
          const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
          return (
            <View
              key={i}
              style={[styles.segment, {
                left: midX - length / 2, top: midY - 1, width: length,
                transform: [{ rotate: `${angle}deg` }],
              }]}
            />
          );
        })}
        {/* points */}
        {sorted.map((p, i) => (
          <View key={i} style={[styles.dot, { left: toX(p.absorbance) - 5, top: toY(p.hardness) - 5 }]} />
        ))}
      </View>
      <View style={styles.axisRow}>
        <Text style={styles.axisText}>A_blue: {xMin.toFixed(3)} – {xMax.toFixed(3)}</Text>
        <Text style={styles.axisText}>ppm: 0 – {yMax.toFixed(0)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyBox: {
    height: 100, borderRadius: 12, backgroundColor: '#F5F5F5',
    justifyContent: 'center', alignItems: 'center', marginBottom: 4,
  },
  emptyText: { color: '#90A4AE', fontSize: 13 },
  plotBox: {
    width: PLOT_W, height: PLOT_H, backgroundColor: '#F5F5F5', borderRadius: 12,
    alignSelf: 'center', overflow: 'hidden',
  },
  gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#E0E0E0' },
  segment: { position: 'absolute', height: 2, backgroundColor: '#6A1B9A' },
  dot: {
    position: 'absolute', width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#1565C0', borderWidth: 2, borderColor: '#FFF',
  },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingHorizontal: 4 },
  axisText: { color: '#78909C', fontSize: 11 },
});
