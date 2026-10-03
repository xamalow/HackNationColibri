import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { palette } from '../theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: palette.green,
          tabBarInactiveTintColor: palette.muted,
          tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.line, height: 66, paddingTop: 7, paddingBottom: 9 },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: ({ color, size }) => <Feather name="sun" color={color} size={size} /> }} />
        <Tabs.Screen name="evidence" options={{ title: 'Evidence', tabBarIcon: ({ color, size }) => <Feather name="file-text" color={color} size={size} /> }} />
        <Tabs.Screen name="outbox" options={{ title: 'Outbox', tabBarIcon: ({ color, size }) => <Feather name="send" color={color} size={size} /> }} />
      </Tabs>
    </>
  );
}
