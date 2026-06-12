import '@testing-library/jest-dom/vitest';
// Initialise the shared i18next instance so components using useTranslation()
// resolve to real (English) strings in tests without an explicit provider.
import { afterEach } from 'vitest';
import i18n from '../lib/i18n/index.js';
import { LOCALE_STORAGE_KEY } from '../lib/i18n/locales.js';

afterEach(async () => {
  // The i18n instance is a singleton; reset it so a language change in one test
  // can't leak into the next.
  if (i18n.language !== 'en') await i18n.changeLanguage('en');
  try {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // ignore
  }
});
