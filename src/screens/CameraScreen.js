import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImageManipulator from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { analyzeImageColors, averageAnalysisResults, computeFrameMetrics } from '../utils/colorAnalysis';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ─── Device layouts ──────────────────────────────────────────────────────────
// 'bottle' (side-view): camera looks horizontally at a backlit bottle.
//   Water ROI = vertical rectangle on the bottle body; TWO reference patches
//   on bare lit panel, one each side of the bottle at the SAME height —
//   averaged to cancel the horizontal panel gradient.
// 'tube' (vertical): camera looks down the tube; circular ROI + one reference
//   patch above the ring.
const MODE_KEY = 'device_mode';

// Bottle layout (bottle spans ~20–25% of frame width)
const WATER_W = Math.round(SCREEN_W * 0.16);   // inside the liquid silhouette
const WATER_H = 260;
const PATCH = 72;                               // reference square side
const PATCH_OFFSET_X = Math.round(SCREEN_W * 0.30); // patch centres at ±30% width
const ALIGN_WARN_FRACTION = 0.04;               // warn if L/R differ by >4%

// Tube layout
const GUIDE_D = 220;

const TOTAL_SECONDS = 30;
const CAPTURE_EVERY_N_SECONDS = 2; // 1 frame every 2 s
const WARMUP_SECONDS = 5; // discard period: auto-exposure/AWB settling + LED warm-up

export default function CameraScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState('idle'); // idle | recording | processing
  const [countdown, setCountdown] = useState(TOTAL_SECONDS);
  const [framesCaptured, setFramesCaptured] = useState(0);
  const [pictureSize, setPictureSize] = useState(undefined);
  const [mode, setMode] = useState('bottle'); // 'bottle' | 'tube'

  const cameraRef = useRef(null);
  const framesRef = useRef([]);          // collected raw frame URIs
  const secondsRef = useRef(TOTAL_SECONDS);
  const intervalRef = useRef(null);
  const isTakingRef = useRef(false);     // debounce concurrent shots

  useEffect(() => {
    if (permission && !permission.granted) requestPermission();
  }, [permission]);

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY).then((m) => {
      if (m === 'tube' || m === 'bottle') setMode(m);
    }).catch(() => {});
  }, []);

  const switchMode = (m) => {
    setMode(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  };

  // Pick an explicit, consistent picture size (~1600 px wide) so pixel
  // geometry is identical across runs and devices.
  const onCameraReady = async () => {
    try {
      const sizes = await cameraRef.current?.getAvailablePictureSizesAsync();
      if (!sizes || sizes.length === 0) return;
      const parsed = sizes
        .map((s) => {
          const [w, h] = s.split('x').map(Number);
          return { s, w, h };
        })
        .filter((p) => Number.isFinite(p.w) && Number.isFinite(p.h));
      if (parsed.length === 0) return;
      parsed.sort((a, b) => Math.abs(a.w - 1600) - Math.abs(b.w - 1600));
      setPictureSize(parsed[0].s);
    } catch (_) {
      // fall back to device default
    }
  };

  // ─── ROI geometry (screen → photo mapping) ────────────────────────────────
  // The preview fills the screen in "cover" mode: the photo is scaled uniformly
  // until it covers SCREEN_W × SCREEN_H and the overflow is cropped equally.
  const screenRects = () => {
    if (mode === 'bottle') {
      return {
        water: {
          left: (SCREEN_W - WATER_W) / 2,
          top: (SCREEN_H - WATER_H) / 2,
          w: WATER_W, h: WATER_H,
        },
        bgL: {
          left: SCREEN_W / 2 - PATCH_OFFSET_X - PATCH / 2,
          top: SCREEN_H / 2 - PATCH / 2, // SAME height as water ROI centre
          w: PATCH, h: PATCH,
        },
        bgR: {
          left: SCREEN_W / 2 + PATCH_OFFSET_X - PATCH / 2,
          top: SCREEN_H / 2 - PATCH / 2,
          w: PATCH, h: PATCH,
        },
      };
    }
    // tube mode: circle + single patch above
    return {
      water: {
        left: (SCREEN_W - GUIDE_D) / 2,
        top: (SCREEN_H - GUIDE_D) / 2,
        w: GUIDE_D, h: GUIDE_D,
      },
      bgL: {
        left: SCREEN_W / 2 - PATCH / 2,
        top: Math.max(115, (SCREEN_H - GUIDE_D) / 2 - 62) - PATCH / 2,
        w: PATCH, h: PATCH,
      },
      bgR: null,
    };
  };

  const toPhotoRects = (imgW, imgH) => {
    const scale = Math.max(SCREEN_W / imgW, SCREEN_H / imgH);
    const dx = (imgW * scale - SCREEN_W) / 2;
    const dy = (imgH * scale - SCREEN_H) / 2;
    const conv = (r) => {
      if (!r) return null;
      const originX = Math.max(0, Math.round((r.left + dx) / scale));
      const originY = Math.max(0, Math.round((r.top + dy) / scale));
      return {
        originX,
        originY,
        width: Math.min(Math.round(r.w / scale), imgW - originX),
        height: Math.min(Math.round(r.h / scale), imgH - originY),
      };
    };
    const s = screenRects();
    return { water: conv(s.water), bgL: conv(s.bgL), bgR: conv(s.bgR) };
  };

  const cropAndAnalyze = async (uri, rect, resizeW, circular) => {
    const c = await ImageManipulator.manipulateAsync(
      uri,
      [
        { crop: rect },
        { resize: { width: resizeW } },
      ],
      { format: ImageManipulator.SaveFormat.JPEG, base64: false }
    );
    const data = await analyzeImageColors(c.uri, { circular });
    return { data, uri: c.uri };
  };

  // Analyse one raw frame → per-frame metrics (+ water crop uri for preview)
  const analyzeFrame = async (uri, rects) => {
    const water = await cropAndAnalyze(uri, rects.water, 120, mode === 'tube');
    const bgL = await cropAndAnalyze(uri, rects.bgL, 60, false);
    const bgR = rects.bgR ? await cropAndAnalyze(uri, rects.bgR, 60, false) : null;
    return {
      metrics: computeFrameMetrics(water.data, bgL.data, bgR ? bgR.data : null),
      water: water.data,
      bgL: bgL.data,
      bgR: bgR ? bgR.data : null,
      previewUri: water.uri,
    };
  };

  // ─── Pre-capture alignment probe (bottle mode) ────────────────────────────
  // Takes one photo and checks the two reference patches match within ~4%.
  // A mismatch means the bottle is off-centre or the panel is unevenly lit.
  const alignmentProbe = async () => {
    const photo = await cameraRef.current.takePictureAsync({
      quality: 0.7, base64: false, skipProcessing: true,
    });
    const probe = await ImageManipulator.manipulateAsync(photo.uri, [], {});
    const rects = toPhotoRects(probe.width, probe.height);
    const f = await analyzeFrame(photo.uri, rects);

    if (f.bgL.b < 20 || (f.bgR && f.bgR.b < 20)) {
      Alert.alert(
        'Reference patch dark',
        'Both dashed squares must sit on bare lit panel beside the bottle. Reposition and try again.'
      );
      return false;
    }
    if (f.metrics.refMismatch !== null && f.metrics.refMismatch > ALIGN_WARN_FRACTION) {
      const pct = (f.metrics.refMismatch * 100).toFixed(1);
      return new Promise((resolve) => {
        Alert.alert(
          'Alignment warning',
          `Left and right reference patches differ by ${pct}% (limit ${ALIGN_WARN_FRACTION * 100}%). ` +
          'The bottle may be off-centre or the panel unevenly lit. Recentre for best accuracy.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Measure anyway', onPress: () => resolve(true) },
          ]
        );
      });
    }
    return true;
  };

  // ─── Start 30-second recording ───────────────────────────────────────────
  const startRecording = async () => {
    if (mode === 'bottle') {
      setPhase('processing'); // brief spinner during the probe shot
      try {
        const ok = await alignmentProbe();
        if (!ok) { setPhase('idle'); return; }
      } catch (_) {
        // probe failure is not fatal — proceed to the run
      }
    }

    framesRef.current = [];
    secondsRef.current = TOTAL_SECONDS;
    isTakingRef.current = false;
    setFramesCaptured(0);
    setCountdown(TOTAL_SECONDS);
    setPhase('recording');

    intervalRef.current = setInterval(async () => {
      secondsRef.current -= 1;
      setCountdown(secondsRef.current);

      // Capture a frame every CAPTURE_EVERY_N_SECONDS, but discard the
      // warm-up window while auto-exposure/AWB settle and the LED warms up.
      const elapsed = TOTAL_SECONDS - secondsRef.current;
      if (elapsed > WARMUP_SECONDS && elapsed % CAPTURE_EVERY_N_SECONDS === 0 && !isTakingRef.current) {
        isTakingRef.current = true;
        try {
          const photo = await cameraRef.current.takePictureAsync({
            quality: 0.7,
            base64: false,
            skipProcessing: true,
          });
          framesRef.current.push(photo.uri);
          setFramesCaptured(framesRef.current.length);
        } catch (_) {
          // skip failed frame silently
        } finally {
          isTakingRef.current = false;
        }
      }

      // Time's up
      if (secondsRef.current <= 0) {
        clearInterval(intervalRef.current);
        processFrames();
      }
    }, 1000);
  };

  const stopEarly = () => {
    clearInterval(intervalRef.current);
    if (framesRef.current.length < 3) {
      Alert.alert('Too few frames', 'Hold for at least 6 seconds to capture enough frames.');
      setPhase('idle');
      return;
    }
    processFrames();
  };

  // ─── Process all captured frames ─────────────────────────────────────────
  const processFrames = async () => {
    setPhase('processing');

    const uris = framesRef.current;
    if (uris.length === 0) {
      Alert.alert('No frames captured', 'Please try again with better lighting.');
      setPhase('idle');
      return;
    }

    try {
      const probe = await ImageManipulator.manipulateAsync(uris[0], [], {});
      const rects = toPhotoRects(probe.width, probe.height);

      const analysisResults = [];
      let sampleUri = null;

      for (let i = 0; i < uris.length; i++) {
        const f = await analyzeFrame(uris[i], rects);

        if (i === Math.floor(uris.length / 2)) sampleUri = f.previewUri;

        // Gates on the first frame
        if (i === 0) {
          if (f.water.r + f.water.g + f.water.b < 30) {
            Alert.alert(
              'Water region dark',
              mode === 'bottle'
                ? 'The water rectangle is dark. Check the LED panel is on and the bottle is centred.'
                : 'The measurement circle is dark. Check the LED and centre the glowing disc in the ring.'
            );
            setPhase('idle');
            return;
          }
          if (f.bgL.b < 20 || (f.bgR && f.bgR.b < 20)) {
            Alert.alert(
              'Reference patch dark',
              'The dashed reference square(s) must sit on bare lit panel. Reposition and try again.'
            );
            setPhase('idle');
            return;
          }
        }

        analysisResults.push(f.metrics);
      }

      const averaged = averageAnalysisResults(analysisResults);

      navigation.navigate('Result', {
        analysisData: averaged,
        sampleUri: sampleUri ?? uris[0],
        frameCount: analysisResults.length,
        deviceMode: mode,
      });
    } catch (err) {
      Alert.alert('Processing error', err.message || 'Failed to analyse frames.');
      setPhase('idle');
    }
  };

  // ─── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => clearInterval(intervalRef.current);
  }, []);

  // ─── Render guards ────────────────────────────────────────────────────────
  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1565C0" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permText}>Camera permission is required.</Text>
        <TouchableOpacity style={styles.permButton} onPress={requestPermission}>
          <Text style={styles.permButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Processing overlay ───────────────────────────────────────────────────
  if (phase === 'processing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1565C0" />
        <Text style={styles.processingTitle}>
          {framesCaptured > 0 ? `Analysing ${framesCaptured} frames…` : 'Checking alignment…'}
        </Text>
        <Text style={styles.processingSubtitle}>
          Per-channel absorbance vs the panel reference
        </Text>
      </View>
    );
  }

  const progress = phase === 'recording'
    ? ((TOTAL_SECONDS - countdown) / TOTAL_SECONDS)
    : 0;

  const s = screenRects();

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        ref={cameraRef}
        facing="back"
        flash="off"
        enableTorch={false}
        autofocus="on"
        pictureSize={pictureSize}
        onCameraReady={onCameraReady}
      >
        {/* ── ROI overlays ── */}
        {/* Water region */}
        <View
          pointerEvents="none"
          style={[
            mode === 'bottle' ? styles.waterRect : styles.guideCircle,
            phase === 'recording' && styles.roiActive,
            {
              left: s.water.left, top: s.water.top,
              width: s.water.w, height: s.water.h,
            },
          ]}
        >
          {phase === 'recording' && (
            <View style={styles.countdownBadge}>
              <Text style={styles.countdownText}>{countdown}s</Text>
            </View>
          )}
        </View>

        {/* Reference patches */}
        <View
          pointerEvents="none"
          style={[styles.bgPatch, {
            left: s.bgL.left, top: s.bgL.top, width: s.bgL.w, height: s.bgL.h,
          }]}
        >
          <Text style={styles.bgPatchLabel}>panel{'\n'}ref L</Text>
        </View>
        {s.bgR && (
          <View
            pointerEvents="none"
            style={[styles.bgPatch, {
              left: s.bgR.left, top: s.bgR.top, width: s.bgR.w, height: s.bgR.h,
            }]}
          >
            <Text style={styles.bgPatchLabel}>panel{'\n'}ref R</Text>
          </View>
        )}

        <SafeAreaView style={styles.overlay}>

          {/* Top bar */}
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.backBtn} onPress={() => {
              clearInterval(intervalRef.current);
              navigation.goBack();
            }}>
              <Text style={styles.backBtnText}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.topTitle}>
              {phase === 'recording' ? 'Recording…' : 'Water Hardness Test'}
            </Text>
            <View style={{ width: 40 }} />
          </View>

          {/* Middle spacer (ROIs are absolutely positioned) */}
          <View style={styles.guideContainer}>
            {phase === 'recording' ? (
              <View style={styles.progressRow}>
                <View style={styles.progressBg}>
                  <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                </View>
                <Text style={styles.framesBadge}>
                  📸 {framesCaptured} frame{framesCaptured !== 1 ? 's' : ''} captured
                </Text>
              </View>
            ) : (
              <Text style={styles.guideText}>
                {mode === 'bottle'
                  ? 'Bottle in the centre rectangle.\nDashed squares on bare lit panel, both sides.'
                  : 'Glowing disc → in the ring.\nSmall square → on bare lit diffuser (no bottle).'}
              </Text>
            )}
          </View>

          {/* Bottom controls */}
          <View style={styles.bottomBar}>
            {phase === 'idle' ? (
              <>
                {/* Device mode toggle */}
                <View style={styles.modeRow}>
                  {[['bottle', '🍼 Bottle (side)'], ['tube', '🧪 Tube (top)']].map(([m, lbl]) => (
                    <TouchableOpacity
                      key={m}
                      style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
                      onPress={() => switchMode(m)}
                    >
                      <Text style={[styles.modeBtnText, mode === m && styles.modeBtnTextActive]}>
                        {lbl}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.hint}>
                  {mode === 'bottle'
                    ? 'LED panel on · Bottle centred · Patches on bare panel'
                    : 'LED on · Tube filled to 10 mL mark · Disc centred'}
                </Text>
                <TouchableOpacity
                  style={styles.startButton}
                  onPress={startRecording}
                  activeOpacity={0.85}
                >
                  <Text style={styles.startButtonIcon}>▶</Text>
                  <Text style={styles.startButtonText}>Start 30s Analysis</Text>
                </TouchableOpacity>
                <Text style={styles.subHint}>
                  5s warm-up · 13 frames · A = log₁₀(I_ref / I_water) per frame
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  Measuring — don't touch the phone or the device
                </Text>
                <TouchableOpacity
                  style={styles.stopButton}
                  onPress={stopEarly}
                  activeOpacity={0.85}
                >
                  <Text style={styles.stopButtonText}>■  Stop &amp; Analyse</Text>
                </TouchableOpacity>
                <Text style={styles.subHint}>
                  Or wait for the 30s countdown to finish
                </Text>
              </>
            )}
            <View style={{ height: 16 }} />
          </View>

        </SafeAreaView>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  center: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#E3F2FD', padding: 24,
  },
  permText: { fontSize: 16, color: '#37474F', textAlign: 'center', marginBottom: 20 },
  permButton: { backgroundColor: '#1565C0', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  permButtonText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
  processingTitle: { marginTop: 20, fontSize: 18, fontWeight: 'bold', color: '#1565C0' },
  processingSubtitle: { marginTop: 8, fontSize: 13, color: '#546E7A', textAlign: 'center' },

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
  topTitle: {
    color: '#FFF', fontSize: 16, fontWeight: 'bold',
    textShadowColor: '#000', textShadowRadius: 4,
  },

  guideContainer: { alignItems: 'center', justifyContent: 'flex-end', flex: 1, paddingBottom: 40 },

  waterRect: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#29B6F6',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  guideCircle: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#29B6F6',
    borderRadius: GUIDE_D / 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  roiActive: {
    borderColor: '#FF6F00',
    shadowColor: '#FF6F00',
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },
  countdownBadge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  countdownText: { color: '#FF6F00', fontSize: 30, fontWeight: 'bold' },

  bgPatch: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFEB3B',
    borderStyle: 'dashed',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bgPatchLabel: {
    color: '#FFEB3B', fontSize: 10, fontWeight: '600', textAlign: 'center',
    textShadowColor: '#000', textShadowRadius: 4,
  },

  progressRow: { alignItems: 'center', width: '80%' },
  progressBg: {
    width: '100%', height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#FF6F00', borderRadius: 3 },
  framesBadge: { color: '#FFF', fontSize: 13, marginTop: 8, textShadowColor: '#000', textShadowRadius: 4 },

  guideText: {
    color: '#FFF', fontSize: 13,
    textShadowColor: '#000', textShadowRadius: 6, textAlign: 'center',
  },

  bottomBar: { alignItems: 'center', paddingBottom: 16, paddingHorizontal: 24 },
  hint: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginBottom: 14, textAlign: 'center' },
  subHint: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 10, textAlign: 'center' },

  modeRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  modeBtn: {
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: 20, paddingVertical: 8, paddingHorizontal: 16,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modeBtnActive: { backgroundColor: '#1565C0', borderColor: '#1565C0' },
  modeBtnText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' },
  modeBtnTextActive: { color: '#FFF' },

  startButton: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1565C0', borderRadius: 14,
    paddingVertical: 16, paddingHorizontal: 36, elevation: 4,
  },
  startButtonIcon: { color: '#FFF', fontSize: 18 },
  startButtonText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },

  stopButton: {
    backgroundColor: '#B71C1C', borderRadius: 14,
    paddingVertical: 16, paddingHorizontal: 36, elevation: 4,
  },
  stopButtonText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
});
