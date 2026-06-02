import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CameraScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing] = useState(false);
  const cameraRef = useRef(null);

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission]);

  const capturePhoto = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.92,
        base64: false,
        skipProcessing: false,
      });
      navigation.navigate('ROI', { photoUri: photo.uri });
    } catch (err) {
      Alert.alert('Error', 'Failed to capture photo. Please try again.');
    } finally {
      setCapturing(false);
    }
  };

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

  return (
    <View style={styles.container}>
      <CameraView style={styles.camera} ref={cameraRef} facing="back">
        {/* Overlay guide */}
        <SafeAreaView style={styles.overlay}>
          {/* Top bar */}
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.backBtnText}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.topTitle}>Capture Sample</Text>
            <View style={{ width: 40 }} />
          </View>

          {/* Guide frame */}
          <View style={styles.guideContainer}>
            <View style={styles.guideFrame} />
            <Text style={styles.guideText}>
              Centre the test tube inside the frame
            </Text>
          </View>

          {/* Bottom controls */}
          <View style={styles.bottomBar}>
            <Text style={styles.hint}>
              Hold steady · Good lighting · Plain background
            </Text>
            <TouchableOpacity
              style={[styles.captureButton, capturing && styles.captureButtonDisabled]}
              onPress={capturePhoto}
              disabled={capturing}
              activeOpacity={0.8}
            >
              {capturing ? (
                <ActivityIndicator color="#1565C0" size="large" />
              ) : (
                <View style={styles.captureInner} />
              )}
            </TouchableOpacity>
            <View style={{ height: 20 }} />
          </View>
        </SafeAreaView>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#E3F2FD', padding: 24 },
  permText: { fontSize: 16, color: '#37474F', textAlign: 'center', marginBottom: 20 },
  permButton: { backgroundColor: '#1565C0', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  permButtonText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },

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
  topTitle: { color: '#FFF', fontSize: 16, fontWeight: 'bold', textShadowColor: '#000', textShadowRadius: 4 },

  guideContainer: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  guideFrame: {
    width: 200, height: 300, borderWidth: 2, borderColor: '#29B6F6',
    borderRadius: 16, backgroundColor: 'transparent',
  },
  guideText: {
    color: '#FFF', marginTop: 16, fontSize: 13,
    textShadowColor: '#000', textShadowRadius: 6, textAlign: 'center',
  },

  bottomBar: { alignItems: 'center', paddingBottom: 16 },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 16, textAlign: 'center' },
  captureButton: {
    width: 80, height: 80, borderRadius: 40, borderWidth: 4,
    borderColor: '#FFFFFF', backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center', alignItems: 'center',
  },
  captureButtonDisabled: { opacity: 0.5 },
  captureInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF' },
});
