import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';

import { BoxConnectionProvider } from './src/context/BoxConnectionContext';
import SetupScreen from './src/screens/SetupScreen';
import CalibrationScreen from './src/screens/CalibrationScreen';
import FullCalibrationScreen from './src/screens/FullCalibrationScreen';
import LinkBoxScreen from './src/screens/LinkBoxScreen';
import AccuracyCheckScreen from './src/screens/AccuracyCheckScreen';
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
        options={{ title: 'Calibration' }}
      />
      <CalibrationStack.Screen
        name="FullCalibration"
        component={FullCalibrationScreen}
        options={{ title: 'Full Calibration' }}
      />
      <CalibrationStack.Screen
        name="LinkBox"
        component={LinkBoxScreen}
        options={{ title: 'Link Box' }}
      />
      <CalibrationStack.Screen
        name="AccuracyCheck"
        component={AccuracyCheckScreen}
        options={{ title: 'Accuracy Check' }}
      />
    </CalibrationStack.Navigator>
  );
}

// Proper vector icons (filled when active, outline when idle) + a taller
// tab bar with bold, readable labels — replaces the small emoji tabs.
const TAB_ICONS = {
  SetupTab:       { active: 'settings',        idle: 'settings-outline' },
  CalibrationTab: { active: 'flask',           idle: 'flask-outline' },
  MeasurementTab: { active: 'speedometer',     idle: 'speedometer-outline' },
  ResultsTab:     { active: 'document-text',   idle: 'document-text-outline' },
};

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
            tabBarInactiveTintColor: '#78909C',
            tabBarStyle: {
              height: 68,
              paddingTop: 6,
              paddingBottom: 10,
              backgroundColor: '#FFFFFF',
              borderTopWidth: 1,
              borderTopColor: '#E0E6EB',
              elevation: 8,
            },
            tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
            tabBarIcon: ({ focused, color }) => (
              <Ionicons
                name={focused ? TAB_ICONS[route.name].active : TAB_ICONS[route.name].idle}
                size={26}
                color={color}
              />
            ),
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
