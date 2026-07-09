import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import HomeScreen from './src/screens/HomeScreen';
import CameraScreen from './src/screens/CameraScreen';
import ROIScreen from './src/screens/ROIScreen';
import ResultScreen from './src/screens/ResultScreen';
import CalibrationScreen from './src/screens/CalibrationScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import PanelSetupScreen from './src/screens/PanelSetupScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import DeviceCalibrationScreen from './src/screens/DeviceCalibrationScreen';
import DeviceConnectScreen from './src/screens/DeviceConnectScreen';
import DeviceHomeScreen from './src/screens/DeviceHomeScreen';
import DeviceSetupScreen from './src/screens/DeviceSetupScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: '#1565C0' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: 'bold' },
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ title: 'Water Hardness Tester' }}
        />
        <Stack.Screen
          name="Camera"
          component={CameraScreen}
          options={{ title: 'Capture Sample', headerShown: false }}
        />
        <Stack.Screen
          name="ROI"
          component={ROIScreen}
          options={{ title: 'Select Sample Region' }}
        />
        <Stack.Screen
          name="Result"
          component={ResultScreen}
          options={{ title: 'Analysis Result' }}
        />
        <Stack.Screen
          name="Calibration"
          component={CalibrationScreen}
          options={{ title: 'Calibration' }}
        />
        <Stack.Screen
          name="History"
          component={HistoryScreen}
          options={{ title: 'Test History' }}
        />
        <Stack.Screen
          name="PanelSetup"
          component={PanelSetupScreen}
          options={{ title: 'Panel Setup', headerShown: false }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Settings' }}
        />
        <Stack.Screen
          name="DeviceCalibration"
          component={DeviceCalibrationScreen}
          options={{ title: 'Device Calibration' }}
        />
        <Stack.Screen
          name="DeviceConnect"
          component={DeviceConnectScreen}
          options={{ title: 'WiFi Device' }}
        />
        <Stack.Screen
          name="DeviceHome"
          component={DeviceHomeScreen}
          options={{ title: 'Measurement Box' }}
        />
        <Stack.Screen
          name="DeviceSetup"
          component={DeviceSetupScreen}
          options={{ title: 'Box ROI Setup' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
