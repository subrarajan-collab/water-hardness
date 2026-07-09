import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import HomeScreen from './src/screens/HomeScreen';
import ResultScreen from './src/screens/ResultScreen';
import CalibrationScreen from './src/screens/CalibrationScreen';
import DeviceCalibrationScreen from './src/screens/DeviceCalibrationScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import BoxSetupScreen from './src/screens/BoxSetupScreen';

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
          options={{ title: 'AQUA-BOX Water Hardness' }}
        />
        <Stack.Screen
          name="Result"
          component={ResultScreen}
          options={{ title: 'Measurement Result' }}
        />
        <Stack.Screen
          name="Calibration"
          component={CalibrationScreen}
          options={{ title: 'Master Curve' }}
        />
        <Stack.Screen
          name="DeviceCalibration"
          component={DeviceCalibrationScreen}
          options={{ title: 'Calibrate This Box' }}
        />
        <Stack.Screen
          name="History"
          component={HistoryScreen}
          options={{ title: 'Test History' }}
        />
        <Stack.Screen
          name="BoxSetup"
          component={BoxSetupScreen}
          options={{ title: 'Box Setup' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
