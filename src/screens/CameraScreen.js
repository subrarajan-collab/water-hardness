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
import { analyzeImageColors, averageAnalysisResults } from '../utils/colorAnalysis';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Guide frame dimensions (must match the guideFrame style below)
const GUIDE_W = 200;
const GUIDE_H = 300;

const TOTAL_SECONDS = 30;
const CAPTURE_EVERY_N_SECONDS = 2; // 1 frame every 2 s → 15 frames total

export default function CameraScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState('idle'); // idle | recording | processing
  const [countdown, setCountdown] = useState(TOTAL_SECONDS);
  const [framesCaptured, setFramesCaptured] = useState(0);

  const cameraRef = useRef(null);
  const framesRef = useRef([]);          // collected raw frame URIs
  const secondsRef = useRef(TOTAL_SECONDS);
  const intervalRef = useRef(null);
  const isTakingRef = useRef(false);     // debounce concurrent shots

  useEffect(() => {
    if (permission && !permission.granted) requestPermission();
  }, [permission]);

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

      // Capture a frame every CAPTURE_EVERY_N_SECONDS
      const elapsed = TOTAL_SECONDS - secondsRef.current;
      if (elapsed % CAPTURE_EVERY_N_SECONDS === 0 && !isTakingRef.current) {
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
      // The camera preview fills the whole screen (SCREEN_W × SCREEN_H).
      const scaleX = imgW / SCREEN_W;
      const scaleY = imgH / SCREEN_H;

      const guideLeft = (SCREEN_W - GUIDE_W) / 2;
      const guideTop  = (SCREEN_H - GUIDE_H) / 2;

      const cropX = Math.max(0, Math.round(guideLeft * scaleX));
      const cropY = Math.max(0, Math.round(guideTop  * scaleY));
      const cropW = Math.min(Math.round(GUIDE_W * scaleX), imgW - cropX);
      const cropH = Math.min(Math.round(GUIDE_H * scaleY), imgH - cropY);

      // Analyse each frame
      const analysisResults = [];
      let sampleUri = null;

      for (let i = 0; i < uris.length; i++) {
        const cropped = await ImageManipulator.manipulateAsync(
          uris[i],
          [
            { crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } },
            { resize: { width: 120 } },
          ],
          { format: ImageManipulator.SaveFormat.JPEG, base64: false }
        );
        if (i === Math.floor(uris.length / 2)) sampleUri = cropped.uri; // middle frame as preview
        const data = await analyzeImageColors(cropped.uri);
        analysisResults.push(data);
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
        <Text style={styles.processingSubtitle}>Averaging blue intensity across all captures</Text>
      </View>
    );
  }

  // ─── Progress ring helper ─────────────────────────────────────────────────
  const progress = phase === 'recording'
    ? ((TOTAL_SECONDS - countdown) / TOTAL_SECONDS)
    : 0;

  return (
    <View style={styles.container}>
      <CameraView style={styles.camera} ref={cameraRef} facing="back">
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
                Centre the test tube inside the frame
              </Text>
            )}
          </View>

          {/* Bottom controls */}
          <View style={styles.bottomBar}>
            {phase === 'idle' ? (
              <>
                <Text style={styles.hint}>
                  Hold steady · Good lighting · Plain background
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
                  Captures 15 frames · averages blue intensity
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  Keep the test tube steady in the frame
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
    borderWidth: 2,
    borderColor: '#29B6F6',
    borderRadius: 16,
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
