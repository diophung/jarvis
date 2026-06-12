/**
 * i18next bootstrap. Importing this module initialises the shared instance
 * (side effect) and keeps <html lang/dir> in sync with the active language.
 * Resources are bundled (small UI catalog), so init is synchronous — no
 * Suspense/loading state needed.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  LOCALE_STORAGE_KEY,
  type Locale,
  SUPPORTED_LOCALES,
  isLocale,
  normalizeLocale,
} from './locales.js';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import vi from './locales/vi.json';
import zh from './locales/zh.json';

export const resources = {
  en: { translation: en },
  vi: { translation: vi },
  es: { translation: es },
  fr: { translation: fr },
  zh: { translation: zh },
  hi: { translation: hi },
} as const;

/** Stored choice → browser language → English. */
function detectInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to detection.
  }
  if (typeof navigator !== 'undefined') {
    const tags = navigator.languages ?? [navigator.language];
    for (const tag of tags) {
      const match = normalizeLocale(tag);
      if (match) return match;
    }
  }
  return DEFAULT_LOCALE;
}

function applyHtmlLang(locale: string): void {
  if (typeof document === 'undefined') return;
  const meta = LOCALE_META[locale as Locale];
  document.documentElement.lang = locale;
  document.documentElement.dir = meta?.dir ?? 'ltr';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectInitialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  interpolation: { escapeValue: false }, // React already escapes output
  returnNull: false,
  react: { useSuspense: false },
});

applyHtmlLang(i18n.language);
i18n.on('languageChanged', applyHtmlLang);

export default i18n;
