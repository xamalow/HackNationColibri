import { File, FileMode, Paths } from 'expo-file-system';
import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getUiLang, setUiLangValue, type UiLang } from '../domain/w3';
import { palette } from '../theme';

/** Demo language toggle. Persisted as a 2-byte code in Documents (not a secret, not in the encrypted DB). */
const CODES: Record<UiLang, string> = { en: 'en', sw: 'sw', both: 'bo' };
const langFile = () => new File(Paths.document, 'ui-lang');

function loadSaved(): void {
  try {
    const f = langFile();
    if (!f.exists) return;
    const h = f.open(FileMode.ReadOnly);
    const code = String.fromCharCode(...h.readBytes(2));
    h.close();
    const lang = (Object.keys(CODES) as UiLang[]).find((l) => CODES[l] === code);
    if (lang) setUiLangValue(lang);
  } catch {
    // Unreadable: keep the default (English).
  }
}

function save(lang: UiLang): void {
  try {
    const f = langFile();
    if (!f.exists) f.create();
    const h = f.open(FileMode.ReadWrite);
    h.writeBytes(new Uint8Array([...CODES[lang]].map((c) => c.charCodeAt(0))));
    h.close();
  } catch {
    // Not saved: the choice still applies until the app restarts.
  }
}

loadSaved();

const LangContext = createContext<{ lang: UiLang; setLang: (lang: UiLang) => void }>({ lang: getUiLang(), setLang: () => {} });

export function LangProvider({ children }: PropsWithChildren) {
  const [lang, setState] = useState<UiLang>(getUiLang());
  const setLang = (next: UiLang) => {
    setUiLangValue(next);
    save(next);
    setState(next);
  };
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

/** Call in every screen so it re-renders when the language changes. */
export const useLang = () => useContext(LangContext);

const OPTIONS: [UiLang, string][] = [['en', 'EN'], ['sw', 'SW'], ['both', 'SW+EN']];

export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup">
      {OPTIONS.map(([value, label]) => (
        <Pressable key={value} onPress={() => setLang(value)} accessibilityRole="radio" accessibilityState={{ selected: lang === value }} hitSlop={6} style={[styles.option, lang === value && styles.on]}>
          <Text style={[styles.text, lang === value && styles.textOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', backgroundColor: '#E7E2D7', borderRadius: 99, padding: 3 },
  option: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 99, minWidth: 40, alignItems: 'center' },
  on: { backgroundColor: palette.green },
  text: { fontSize: 12, fontWeight: '800', color: palette.muted },
  textOn: { color: palette.white },
});
