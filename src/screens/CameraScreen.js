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
import { analyzeImageColors, averageAnalysisResults, computeFrameMetrics } from '../utils/colorAnalysis';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Circular guide ring for the vertical (look-down-the-tube) device.
// The glowing disc of the tube must be centred inside this ring.
const GUIDE_D = 220; // on-screen diameter, px
const GUIDE_W = GUIDE_D;
const GUIDE_H = GUIDE_D;

// Background reference patch: a small square the user positions over BARE lit
// diffuser (no bottle). Its blue level is the incident light I_background.
// Scoring on log10(I_background / I_water) makes the reading immune to phone
// auto-exposure drift — a raw blue of 141 today would not mean 141 tomorrow.
const BG_SIZE = 80; // on-screen square side, px
const BG_CENTER_X = SCREEN_W / 2;
const BG_CENTER_Y = Math.max(115, (SCREEN_H - GUIDE_H) / 2 - 62); // above the ring

const TOTAL_SECONDS = 30;
const CAPTURE_EVERY_N_SECONDS = 2; // 1 frame every 2 s
const WARMUP_SECONDS = 5; // discard period: auto-exposure/AWB settling + LED warm-up

export default function CameraScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState('idle'); // idle | recording | processing
  const [countdown, setCountdown] = useState(TOTAL_SECONDS);
  const [framesCaptured, setFramesCaptured] = useState(0);
  const [pictureSize, setPictureSize] = useState(undefined);

  const cameraRef = useRef(null);
  const framesRef = useRef([]);          // collected raw frame URIs
  const secondsRef = useRef(TOTAL_SECONDS);
  const intervalRef = useRef(null);
  const isTakingRef = useRef(false);     // debounce concurrent shots

  useEffect(() => {
    if (permission && !permission.granted) requestPermission();
  }, [permission]);

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

  // ─── Start 30-second recording ───────────────────────────────────────────
  const startRecording = () => {
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
      // Get actual image dimensions from the first frame so we can map
      // the on-screen guide frame → image crop coordinates.
      const probe = await ImageManipulator.manipulateAsync(uris[0], [], {});
      const imgW = probe.width;
      const imgH = probe.height;

      // Map guide frame (centred on screen) to image pixel coordinates.
      // The preview fills the screen in "cover" mode: the photo is scaled
      // uniformly until it covers SCREEN_W × SCREEN_H, and the overflow is
      // cropped equally on both sides. Photo aspect (4:3) ≠ screen aspect,
      // so a plain imgW/SCREEN_W scale would land the ROI off-target.
      const scale = Math.max(SCREEN_W / imgW, SCREEN_H / imgH);
      const dx = (imgW * scale - SCREEN_W) / 2; // hidden preview margin (px, screen units)
      const dy = (imgH * scale - SCREEN_H) / 2;

      // screen point → photo point: (screen + hiddenMargin) / scale
      const toPhoto = (leftS, topS, sizeW, sizeH) => ({
        originX: Math.max(0, Math.round((leftS + dx) / scale)),
        originY: Math.max(0, Math.round((topS + dy) / scale)),
        width: Math.round(sizeW / scale),
        height: Math.round(sizeH / scale),
      });

      // Water disc ROI (centred guide ring)
      const guideLeft = (SCREEN_W - GUIDE_W) / 2;
      const guideTop  = (SCREEN_H - GUIDE_H) / 2;
      const wc = toPhoto(guideLeft, guideTop, GUIDE_W, GUIDE_H);
      wc.width = Math.min(wc.width, imgW - wc.originX);
      wc.height = Math.min(wc.height, imgH - wc.originY);

      // Background reference ROI (bare diffuser patch above the ring)
      const bc = toPhoto(BG_CENTER_X - BG_SIZE / 2, BG_CENTER_Y - BG_SIZE / 2, BG_SIZE, BG_SIZE);
      bc.width = Math.min(bc.width, imgW - bc.originX);
      bc.height = Math.min(bc.height, imgH - bc.originY);

      // Analyse each frame: water disc + background reference → absorbance
      const analysisResults = [];
      let sampleUri = null;

      for (let i = 0; i < uris.length; i++) {
        const waterCrop = await ImageManipulator.manipulateAsync(
          uris[i],
          [
            { crop: { originX: wc.originX, originY: wc.originY, width: wc.width, height: wc.height } },
            { resize: { width: 120 } },
          ],
          { format: ImageManipulator.SaveFormat.JPEG, base64: false }
        );
        const bgCrop = await ImageManipulator.manipulateAsync(
          uris[i],
          [
            { crop: { originX: bc.originX, originY: bc.originY, width: bc.width, height: bc.height } },
            { resize: { width: 60 } },
          ],
          { format: ImageManipulator.SaveFormat.JPEG, base64: false }
        );

        if (i === Math.floor(uris.length / 2)) sampleUri = waterCrop.uri; // middle frame preview

        const water = await analyzeImageColors(waterCrop.uri, { circular: true });
        const background = await analyzeImageColors(bgCrop.uri);

        // Gate on the first frame.
        if (i === 0) {
          if (water.r + water.g + water.b < 30) {
            Alert.alert(
              'No glow detected',
              'The measurement circle is dark. Check that the LED is on and slide the phone until the bright disc is centred in the ring.'
            );
            setPhase('idle');
            return;
          }
          if (background.b < 20) {
            Alert.alert(
              'Reference patch dark',
              'The small reference square must sit over BARE lit diffuser (no bottle). Slide the phone so the square shows the plain glowing background, then try again.'
            );
            setPhase('idle');
            return;
          }
        }

        analysisResults.push(computeFrameMetrics(water, background));
      }

      const averaged = averageAnalysisResults(analysisResults);

      navigation.navigate('Result', {
        analysisData: averaged,
        sampleUri: sampleUri ?? uris[0],
        frameCount: analysisResults.length,
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
        <Text style={styles.processingTitle}>Analysing {framesCaptured} frames…</Text>
        <Text style={styles.processingSubtitle}>Computing absorbance vs the diffuser reference</Text>
      </View>
    );
  }

  // ─── Progress ring helper ─────────────────────────────────────────────────
  const progress = phase === 'recording'
    ? ((TOTAL_SECONDS - countdown) / TOTAL_SECONDS)
    : 0;

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
        {/* Background reference patch — user keeps this over BARE lit diffuser */}
        <View
          pointerEvents="none"
          style={[
            styles.bgPatch,
            {
              left: BG_CENTER_X - BG_SIZE / 2,
              top: BG_CENTER_Y - BG_SIZE / 2,
              width: BG_SIZE,
              height: BG_SIZE,
            },
          ]}
        >
          <Text style={styles.bgPatchLabel}>diffuser{'\n'}reference</Text>
        </View>

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

          {/* Guide frame + countdown */}
          <View style={styles.guideContainer}>
            <View style={[
              styles.guideFrame,
              phase === 'recording' && styles.guideFrameActive,
            ]}>
              {phase === 'recording' && (
                <View style={styles.countdownBadge}>
                  <Text style={styles.countdownText}>{countdown}s</Text>
                </View>
              )}
            </View>

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
                Glowing disc → in the ring.{'\n'}
                Small square → on bare lit diffuser (no bottle).
              </Text>
            )}
          </View>

          {/* Bottom controls */}
          <View style={styles.bottomBar}>
            {phase === 'idle' ? (
              <>
                <Text style={styles.hint}>
                  LED on · Tube filled to 10 mL mark · Disc centred
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
                  5s warm-up · 13 frames · absorbance vs diffuser reference
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

  guideContainer: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  guideFrame: {
    width: GUIDE_W,
    height: GUIDE_H,
    borderWidth: 3,
    borderColor: '#29B6F6',
    borderRadius: GUIDE_D / 2,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  guideFrameActive: {
    borderColor: '#FF6F00',
    borderWidth: 3,
    shadowColor: '#FF6F00',
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },
  countdownBadge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  countdownText: { color: '#FF6F00', fontSize: 36, fontWeight: 'bold' },

  progressRow: { alignItems: 'center', marginTop: 16, width: '80%' },
  progressBg: {
    width: '100%', height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#FF6F00', borderRadius: 3 },
  framesBadge: { color: '#FFF', fontSize: 13, marginTop: 8, textShadowColor: '#000', textShadowRadius: 4 },

  guideText: {
    color: '#FFF', marginTop: 16, fontSize: 13,
    textShadowColor: '#000', textShadowRadius: 6, textAlign: 'center',
  },

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

  bottomBar: { alignItems: 'center', paddingBottom: 16, paddingHorizontal: 24 },
  hint: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginBottom: 14, textAlign: 'center' },
  subHint: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 10, textAlign: 'center' },

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
