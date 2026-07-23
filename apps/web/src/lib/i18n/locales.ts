/** Supported UI locales and their display metadata. */

export const SUPPORTED_LOCALES = ['en', 'vi', 'es', 'fr', 'zh', 'hi'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** localStorage key holding the user's chosen locale (for instant first paint). */
export const LOCALE_STORAGE_KEY = 'jarvis.locale';

/** Preference key the locale is mirrored to on the server (per-user). */
export const LOCALE_PREFERENCE_KEY = 'ui.locale';

export interface LocaleMeta {
  /** English name of the language. */
  label: string;
  /** Endonym — the language's name in itself; what users scan the picker for. */
  nativeName: string;
  /** Writing direction. All current locales are LTR, but the plumbing is here. */
  dir: 'ltr' | 'rtl';
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { label: 'English', nativeName: 'English', dir: 'ltr' },
  vi: { label: 'Vietnamese', nativeName: 'Tiếng Việt', dir: 'ltr' },
  es: { label: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  fr: { label: 'French', nativeName: 'Français', dir: 'ltr' },
  zh: { label: 'Chinese (Simplified)', nativeName: '中文', dir: 'ltr' },
  hi: { label: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Best-effort match of a BCP-47 tag (e.g. "fr-CA", "zh-Hans") to a supported
 * locale, falling back to the primary subtag. Returns null when nothing fits.
 */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (isLocale(lower)) return lower;
  const base = lower.split('-')[0];
  return isLocale(base) ? base : null;
}
