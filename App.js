import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';

import { BoxConnectionProvider } from './src/context/BoxConnectionContext';
import SetupScreen from './src/screens/SetupScreen';
import CalibrationScreen from './src/screens/CalibrationScreen';
import DeviceCalibrationScreen from './src/screens/DeviceCalibrationScreen';
import MeasurementScreen from './src/screens/MeasurementScreen';
import ResultsScreen from './src/screens/ResultsScreen';

const ACCENT = '#1565C0';

const Tab = createBottomTabNavigator();
const CalibrationStack = createNativeStackNavigator();

// Calibration is the only tab that needs a sub-screen (the guided per-box
// device-factor flow), so it gets its own tiny stack; the other three tabs
// are single screens directly on the bottom tab navigator.
function CalibrationTabNavigator() {
  return (
    <CalibrationStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: ACCENT },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: 'bold' },
      }}
    >
      <CalibrationStack.Screen
        name="CalibrationHome"
        component={CalibrationScreen}
        options={{ title: 'Master Curve' }}
      />
      <CalibrationStack.Screen
        name="DeviceCalibration"
        component={DeviceCalibrationScreen}
        options={{ title: 'Calibrate This Box' }}
      />
    </CalibrationStack.Navigator>
  );
}

const TAB_ICONS = {
  SetupTab: '🎛',
  CalibrationTab: '📈',
  MeasurementTab: '📡',
  ResultsTab: '📋',
};

function TabIcon({ route, focused }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[route.name]}</Text>;
}

export default function App() {
  return (
    <BoxConnectionProvider>
      <NavigationContainer>
        <StatusBar style="light" />
        <Tab.Navigator
          initialRouteName="SetupTab"
          screenOptions={({ route }) => ({
            headerStyle: { backgroundColor: ACCENT },
            headerTintColor: '#FFFFFF',
            headerTitleStyle: { fontWeight: 'bold' },
            tabBarActiveTintColor: ACCENT,
            tabBarInactiveTintColor: '#90A4AE',
            tabBarIcon: ({ focused }) => <TabIcon route={route} focused={focused} />,
          })}
        >
          <Tab.Screen name="SetupTab" component={SetupScreen} options={{ title: 'Setup', tabBarLabel: 'Setup' }} />
          <Tab.Screen
            name="CalibrationTab"
            component={CalibrationTabNavigator}
            options={{ headerShown: false, title: 'Calibration', tabBarLabel: 'Calibration' }}
          />
          <Tab.Screen name="MeasurementTab" component={MeasurementScreen} options={{ title: 'Measurement', tabBarLabel: 'Measure' }} />
          <Tab.Screen name="ResultsTab" component={ResultsScreen} options={{ title: 'Results', tabBarLabel: 'Results' }} />
        </Tab.Navigator>
      </NavigationContainer>
    </BoxConnectionProvider>
  );
}
