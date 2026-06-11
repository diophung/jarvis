/**
 * Privacy guard for the learning pipeline.
 *
 * Donna must never infer or store sensitive attributes (protected classes,
 * health, politics, religion, sexuality, immigration status, union
 * membership, criminal history). Text-based inference of these is both
 * ethically off-limits and scientifically unreliable, so the guard errs on
 * the side of dropping a learning signal rather than storing it.
 *
 * Scope: this filters only what the LEARNING subsystem persists (signals and
 * preference statements). It does not censor the user's own data or chat —
 * Donna can still help with a medical email; it just won't learn from it.
 */

export const SENSITIVE_CATEGORIES = [
  'health',
  'political',
  'religious',
  'sexual',
  'ethnicity',
  'immigration',
  'union',
  'criminal',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const PATTERNS: Record<SensitiveCategory, RegExp> = {
  health:
    /\b(diagnos\w*|cancer|oncolog\w*|cardiolog\w*|chemotherapy|radiation therapy|depress\w*|anxiety|adhd|autis\w*|bipolar|therap(y|ist)|medication|prescription|pregnan\w*|fertilit\w*|miscarriage|disabilit\w*|chronic (pain|illness)|mental health|psychiatr\w*|hiv|aids\b|diabet\w*|hospital|clinic\b|surgery|surgical|vaccin\w*|symptom\w*|illness)\b/i,
  political:
    /\b(democrat\w*|republican\w*|conservative party|labour party|liberal party|political(ly)?|election vote|voted? for|ballot|left[- ]wing|right[- ]wing|maga\b|socialis\w*|libertarian)\b/i,
  religious:
    /\b(christian\w*|catholic\w*|protestant|muslim\w*|islam\w*|jewish|judaism|hindu\w*|buddhis\w*|atheis\w*|agnostic|church service|mosque|synagogue|bible study|quran|worship)\b/i,
  sexual:
    /\b(sexual orientation|sexualit\w*|gay\b|lesbian|bisexual|queer|lgbtq?\w*|transgender|gender identity|coming out)\b/i,
  ethnicity:
    /\b(ethnicit\w*|racial\w*|my race\b|skin color|nationality of|ethnic background)\b/i,
  immigration:
    /\b(immigration status|visa status|undocumented|green card|asylum|deportation|citizenship application)\b/i,
  union: /\b(union member\w*|labor union|trade union|unioniz\w*|collective bargaining)\b/i,
  criminal:
    /\b(criminal record|convicted|felony|misdemeanor|arrest(ed)?|incarcerat\w*|parole|probation officer)\b/i,
};

/**
 * Returns the sensitive category a text touches, or null when clean.
 * Used to drop learning signals/preferences before they are ever stored.
 */
export function detectSensitiveContent(text: string): SensitiveCategory | null {
  for (const category of SENSITIVE_CATEGORIES) {
    if (PATTERNS[category].test(text)) return category;
  }
  return null;
}

/**
 * True when a learning artifact (signal or preference) is safe to persist.
 * Checks every free-text field that could leak sensitive content into the
 * learning store.
 */
export function isSafeToLearn(fields: Array<string | null | undefined>): boolean {
  for (const field of fields) {
    if (field == null || field === '') continue;
    if (detectSensitiveContent(field) !== null) return false;
  }
  return true;
}
