import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  PanResponder,
  Dimensions,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';

const { width: SCREEN_W } = Dimensions.get('window');

export default function ROIScreen({ route, navigation }) {
  const { photoUri } = route.params;

  const [imageLayout, setImageLayout] = useState(null);
  const [selection, setSelection] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [processing, setProcessing] = useState(false);

  const startPoint = useRef(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        startPoint.current = { x: locationX, y: locationY };
        setSelecting(true);
        setSelection({ x: locationX, y: locationY, width: 0, height: 0 });
      },

      onPanResponderMove: (evt) => {
        if (!startPoint.current) return;
        const { locationX, locationY } = evt.nativeEvent;
        const x = Math.min(startPoint.current.x, locationX);
        const y = Math.min(startPoint.current.y, locationY);
        const w = Math.abs(locationX - startPoint.current.x);
        const h = Math.abs(locationY - startPoint.current.y);
        setSelection({ x, y, width: w, height: h });
      },

      onPanResponderRelease: () => {
        setSelecting(false);
      },
    })
  ).current;

  const handleImageLayout = useCallback((e) => {
    const { width, height, x, y } = e.nativeEvent.layout;
    setImageLayout({ width, height, x, y });
  }, []);

  const analyzeSelection = async () => {
    if (!selection || selection.width < 20 || selection.height < 20) {
      Alert.alert('Too small', 'Please draw a larger selection over the liquid area.');
      return;
    }
    if (!imageLayout) return;

    setProcessing(true);
    try {
      // Get actual image dimensions to compute crop coordinates
      const imgInfo = await ImageManipulator.manipulateAsync(photoUri, [], {});
      const scaleX = imgInfo.width / imageLayout.width;
      const scaleY = imgInfo.height / imageLayout.height;

      const cropX = Math.round(selection.x * scaleX);
      const cropY = Math.round(selection.y * scaleY);
      const cropW = Math.round(selection.width * scaleX);
      const cropH = Math.round(selection.height * scaleY);

      // Crop and resize to a manageable size for pixel analysis
      const cropped = await ImageManipulator.manipulateAsync(
        photoUri,
        [
          {
            crop: {
              originX: Math.max(0, cropX),
              originY: Math.max(0, cropY),
              width: Math.min(cropW, imgInfo.width - cropX),
              height: Math.min(cropH, imgInfo.height - cropY),
            },
          },
          { resize: { width: 120 } }, // small for fast pixel reading
        ],
        { format: ImageManipulator.SaveFormat.JPEG, base64: false }
      );

      navigation.navigate('Result', {
        croppedUri: cropped.uri,
        originalUri: photoUri,
      });
    } catch (err) {
      Alert.alert('Error', 'Failed to process image: ' + err.message);
    } finally {
      setProcessing(false);
    }
  };

  const clearSelection = () => {
    setSelection(null);
    startPoint.current = null;
  };

  return (
    <View style={styles.container}>
      <Text style={styles.instructions}>
        Draw a rectangle over the liquid area in the test tube
      </Text>

      <View style={styles.imageContainer} onLayout={handleImageLayout} {...panResponder.panHandlers}>
        <Image
          source={{ uri: photoUri }}
          style={styles.image}
          resizeMode="contain"
        />

        {/* Selection overlay */}
        {selection && (
          <View
            style={[
              styles.selectionRect,
              {
                left: selection.x,
                top: selection.y,
                width: selection.width,
                height: selection.height,
              },
            ]}
          />
        )}

        {/* Corner guides */}
        {!selection && (
          <View style={styles.noSelectionHint}>
            <Text style={styles.noSelectionText}>Drag to select</Text>
          </View>
        )}
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        {selection && (
          <Text style={styles.selectionInfo}>
            Selection: {Math.round(selection.width)} × {Math.round(selection.height)} px
          </Text>
        )}

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.clearBtn} onPress={clearSelection}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.analyzeBtn, (!selection || processing) && styles.analyzeBtnDisabled]}
            onPress={analyzeSelection}
            disabled={!selection || processing}
          >
            {processing ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.analyzeBtnText}>Analyse →</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1A1A2E' },

  instructions: {
    color: '#BBDEFB', fontSize: 13, textAlign: 'center',
    paddingHorizontal: 20, paddingVertical: 12,
  },

  imageContainer: {
    flex: 1, position: 'relative', margin: 8,
    borderRadius: 12, overflow: 'hidden', backgroundColor: '#000',
  },
  image: { width: '100%', height: '100%' },

  selectionRect: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#29B6F6',
    backgroundColor: 'rgba(41, 182, 246, 0.15)',
  },

  noSelectionHint: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center', alignItems: 'center',
    pointerEvents: 'none',
  },
  noSelectionText: {
    color: 'rgba(255,255,255,0.4)', fontSize: 16, fontStyle: 'italic',
  },

  actions: {
    backgroundColor: '#1A1A2E', padding: 16, paddingBottom: 24,
  },
  selectionInfo: {
    color: '#90CAF9', fontSize: 12, textAlign: 'center', marginBottom: 8,
  },
  buttonRow: { flexDirection: 'row', gap: 12 },
  clearBtn: {
    flex: 1, borderWidth: 1, borderColor: '#546E7A',
    borderRadius: 12, paddingVertical: 14, alignItems: 'center',
  },
  clearBtnText: { color: '#90CAF9', fontSize: 15, fontWeight: '600' },
  analyzeBtn: {
    flex: 2, backgroundColor: '#1565C0', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  analyzeBtnDisabled: { backgroundColor: '#37474F' },
  analyzeBtnText: { color: '#FFF', fontSize: 15, fontWeight: 'bold' },
});
