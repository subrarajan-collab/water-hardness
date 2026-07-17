import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  connectAndVerify, getStatus, DEFAULT_IP, EXPECTED_API_VERSION,
  MIN_API_VERSION, RECOMMENDED_API_VERSION,
} from '../api/boxClient';
import { boxDeviceKey } from '../utils/deviceCalibration';

// Single source of truth for "which box are we talking to right now", shared
// across all four tabs (Setup connects/disconnects it; Calibration and
// Measurement read it to know what to measure; Results reads box_id to tag
// history). Without this, each tab would independently re-implement connect
// state or pass it through fragile cross-tab navigation params.
const BoxConnectionContext = createContext(null);

const LAST_IP_KEY = 'wifi_last_ip';

export function BoxConnectionProvider({ children }) {
  const [ip, setIp] = useState(DEFAULT_IP);
  const [status, setStatus] = useState(null);
  const [apiVersion, setApiVersion] = useState(null);
  const [apiVersionMatch, setApiVersionMatch] = useState(true);
  const [apiVersionOutdated, setApiVersionOutdated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [statusError, setStatusError] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem(LAST_IP_KEY).then((v) => { if (v) setIp(v); }).catch(() => {});
  }, []);

  const connect = useCallback(async (targetIp) => {
    setConnecting(true);
    setStatusError(null);
    try {
      const r = await connectAndVerify(targetIp);
      await AsyncStorage.setItem(LAST_IP_KEY, targetIp).catch(() => {});
      setIp(targetIp);
      setStatus(r.status);
      setApiVersion(r.apiVersion);
      setApiVersionMatch(r.apiVersionMatch);
      setApiVersionOutdated(!!r.apiVersionOutdated);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'Could not connect to the box.' };
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setStatus(null);
    setStatusError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!status) return;
    try {
      const s = await getStatus(ip);
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(e.message || 'Status refresh failed');
    }
  }, [ip, status]);

  const connected = !!status;
  const boxId = status?.box_id ?? null;
  const deviceKey = boxId ? boxDeviceKey(boxId) : null;
  const hasPreview = !!status?.capabilities?.preview;

  const value = {
    ip, setIp,
    status, setStatus,
    apiVersion, apiVersionMatch, apiVersionOutdated,
    EXPECTED_API_VERSION, MIN_API_VERSION, RECOMMENDED_API_VERSION,
    connecting, statusError,
    connected, boxId, deviceKey, hasPreview,
    connect, disconnect, refresh,
  };

  return (
    <BoxConnectionContext.Provider value={value}>
      {children}
    </BoxConnectionContext.Provider>
  );
}

export function useBoxConnection() {
  const ctx = useContext(BoxConnectionContext);
  if (!ctx) throw new Error('useBoxConnection must be used within BoxConnectionProvider');
  return ctx;
}
