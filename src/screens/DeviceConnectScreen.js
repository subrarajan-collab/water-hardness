import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { connectAndVerify, DEFAULT_IP, EXPECTED_API_VERSION } from '../api/boxClient';

const LAST_IP_KEY = 'wifi_last_ip';

export default function DeviceConnectScreen({ navigation }) {
  const [ip, setIp] = useState(DEFAULT_IP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem(LAST_IP_KEY).then((v) => { if (v) setIp(v); }).catch(() => {});
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { status, apiVersion, apiVersionMatch } = await connectAndVerify(ip);
      await AsyncStorage.setItem(LAST_IP_KEY, ip).catch(() => {});
      if (!apiVersionMatch) {
        setError(
          `Firmware API v${apiVersion} does not match this app (expects v${EXPECTED_API_VERSION}). ` +
          'Some features may fail — update the box firmware or the app.'
        );
        // still proceed — the box is reachable, this is a warning not a hard stop
      }
      navigation.navigate('DeviceHome', { ip, status });
    } catch (e) {
      // e.kind: 'network' (unreachable) or 'http' (box responded, wrong route)
      setError(e.message || 'Could not connect to the box.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>📡 Connect to a measurement box</Text>
        <Text style={styles.infoText}>
          Power the AQUA-BOX, then on this phone join its WiFi network “AQUA-BOX”.
          The box is at {DEFAULT_IP} by default.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Box IP address</Text>
        <TextInput
          style={styles.input}
          value={ip}
          onChangeText={setIp}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          placeholder={DEFAULT_IP}
          placeholderTextColor="#90A4AE"
        />
        <TouchableOpacity
          style={[styles.connectBtn, busy && styles.btnDisabled]}
          onPress={connect}
          disabled={busy}
        >
          {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.connectBtnText}>Connect</Text>}
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.errBox}>
          <Text style={styles.errText}>{error}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#E3F2FD' },
  content: { padding: 20, paddingBottom: 40 },
  infoCard: {
    backgroundColor: '#E8EAF6', borderRadius: 16, padding: 16, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#3949AB',
  },
  infoTitle: { fontWeight: 'bold', color: '#3949AB', marginBottom: 6, fontSize: 15 },
  infoText: { color: '#37474F', fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginBottom: 16, elevation: 2 },
  fieldLabel: { fontSize: 12, color: '#546E7A', fontWeight: '600', marginBottom: 6 },
  input: {
    backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: '#1A237E', borderWidth: 1, borderColor: '#E0E0E0', marginBottom: 14,
  },
  connectBtn: { backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  connectBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
  btnDisabled: { backgroundColor: '#B0BEC5' },
  errBox: {
    backgroundColor: '#FFF3E0', borderRadius: 12, padding: 14,
    borderLeftWidth: 4, borderLeftColor: '#EF6C00',
  },
  errText: { color: '#E65100', fontSize: 13, lineHeight: 19 },
});
