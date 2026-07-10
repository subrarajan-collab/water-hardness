import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

// Minimal expand/collapse section. Used to tuck expert content (raw curve
// points, JSON export, box-link numbers, A-channel details) out of the main
// task flow without removing it.
export default function Accordion({ title, children, initiallyOpen = false }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.header} onPress={() => setOpen(!open)} activeOpacity={0.7}>
        <Text style={styles.title}>{open ? '▾' : '▸'}  {title}</Text>
      </TouchableOpacity>
      {open && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: '#FFF', borderRadius: 16, marginBottom: 16, elevation: 2, overflow: 'hidden' },
  header: { padding: 16 },
  title: { fontSize: 14, fontWeight: 'bold', color: '#546E7A' },
  body: { paddingHorizontal: 16, paddingBottom: 16 },
});
