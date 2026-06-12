/**
 * Locale state for the UI. `useLocale` reads/writes the active language;
 * `LocaleBootstrap` reconciles the server-stored preference once on load.
 *
 * Source of truth at runtime is the i18next instance. On change we also write
 * localStorage (instant first paint next time) and the per-user preference
 * (`ui.locale`) so the choice follows the account across devices.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import {
  DEFAULT_LOCALE,
  type Locale,
  LOCALE_PREFERENCE_KEY,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  isLocale,
} from './locales.js';

function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // localStorage may be unavailable (private mode); the server copy still persists.
  }
}

export function useLocale() {
  const { i18n } = useTranslation();
  const qc = useQueryClient();
  const locale: Locale = isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;

  const savePreference = useMutation({
    mutationFn: (next: Locale) =>
      api.put(`/api/preferences/${LOCALE_PREFERENCE_KEY}`, { value: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preferences'] }),
  });

  const setLocale = (next: Locale) => {
    if (next === locale) return;
    void i18n.changeLanguage(next);
    rememberLocale(next);
    savePreference.mutate(next);
  };

  return { locale, setLocale, locales: SUPPORTED_LOCALES };
}

/**
 * Applies the account's saved locale once after preferences load. Renders
 * nothing; mount it inside the authenticated shell. Auth pages (no session)
 * fall back to localStorage / browser language detection from i18n init.
 */
export function LocaleBootstrap() {
  const { i18n } = useTranslation();
  const applied = useRef(false);
  const { data } = useQuery({
    queryKey: ['preferences'],
    queryFn: () => api.get<{ items: { key: string; value: unknown }[] }>('/api/preferences'),
  });

  useEffect(() => {
    if (applied.current || !data) return;
    applied.current = true;
    const pref = data.items.find((p) => p.key === LOCALE_PREFERENCE_KEY)?.value;
    if (isLocale(pref) && pref !== i18n.language) {
      void i18n.changeLanguage(pref);
      rememberLocale(pref);
    }
  }, [data, i18n]);

  return null;
}
