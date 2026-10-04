import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text, View, type ColorValue } from 'react-native';
import { LangProvider, useLang } from '../components/Lang';
import { getUiLang } from '../domain/w3';
import { palette } from '../theme';

export default function RootLayout() {
  return <LangProvider><AppTabs /></LangProvider>;
}

function AppTabs() {
  useLang();
  return (
    <>
      <StatusBar style="dark" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: palette.green,
          tabBarInactiveTintColor: palette.muted,
          tabBarStyle: { backgroundColor: palette.surface, borderTopWidth: 0, height: 88, paddingTop: 8, shadowColor: '#1A2620', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: -2 } },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '800' },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Leo', tabBarLabel: ({ color }) => <TabLabel sw="Leo" en="Today" color={color} />, tabBarIcon: ({ color, size }) => <Feather name="sun" color={color} size={size} /> }} />
        <Tabs.Screen name="ziara" options={{ title: 'Ziara', tabBarLabel: ({ color }) => <TabLabel sw="Ziara" en="Visits" color={color} />, tabBarIcon: ({ color, size }) => <Feather name="calendar" color={color} size={size} /> }} />
        <Tabs.Screen name="outbox" options={{ title: 'Ujumbe', tabBarLabel: ({ color }) => <TabLabel sw="Ujumbe" en="Messages" color={color} />,tabBarIcon: ({ color, size }) => <Feather name="send" color={color} size={size} /> }} />
        <Tabs.Screen name="shamba" options={{ title: 'Shamba', tabBarLabel: ({ color }) => <TabLabel sw="Shamba" en="Farm" color={color} />, tabBarIcon: ({ color, size }) => <Feather name="home" color={color} size={size} /> }} />
        <Tabs.Screen name="evidence" options={{ href: null }} />
        <Tabs.Screen name="device" options={{ href: null }} />
        <Tabs.Screen name="gemma" options={{ href: null }} />
      </Tabs>
    </>
  );
}

function TabLabel({ sw, en, color }: { sw: string; en: string; color: ColorValue }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ fontSize: 11, fontWeight: '800', color }}>{getUiLang() === 'en' ? en : sw}</Text>
      {getUiLang() === 'both' ? <Text style={{ fontSize: 9, color, opacity: 0.7 }}>{en}</Text> : null}
    </View>
  );
}
