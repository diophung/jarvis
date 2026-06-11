/**
 * Writing-style analysis over user-authored text, and draft-edit diffing.
 * Deterministic lexical heuristics only — no LLM required, fully explainable.
 *
 * Style is always learned per audience (politeness theory / communication
 * accommodation: register varies legitimately by audience); the caller
 * attaches the audience scope.
 */

export interface StyleObservation {
  /** 'concise' (<~40 words or short sentences), 'detailed' (long), or null when ambiguous. */
  length: 'concise' | 'detailed' | null;
  /** 'direct' (few hedges) vs 'softened' (hedge-dense); null when too short to judge. */
  directness: 'direct' | 'softened' | null;
  /** 'formal' vs 'casual' from greeting/sign-off/contraction markers; null when unclear. */
  formality: 'formal' | 'casual' | null;
  /** 'bullets' when the text leans on list structure; null otherwise. */
  structure: 'bullets' | null;
  wordCount: number;
  avgSentenceWords: number;
  hedgeCount: number;
}

const HEDGES = [
  'maybe',
  'perhaps',
  'i think',
  'i guess',
  'i feel like',
  'sort of',
  'kind of',
  'possibly',
  'would it be possible',
  'if you get a chance',
  'no worries if not',
  'just wanted to',
  'just checking',
  'i was wondering',
] as const;

const FORMAL_MARKERS = [
  'dear ',
  'sincerely',
  'best regards',
  'kind regards',
  'regards,',
  'to whom it may concern',
  'please find attached',
  'per our conversation',
] as const;

const CASUAL_MARKERS = [
  'hey ',
  'hey,',
  'hi!',
  'thanks!',
  'cheers',
  'btw',
  'fyi',
  'lol',
  'gonna',
  'wanna',
  ':)',
  '👍',
] as const;

function countOccurrences(haystack: string, needles: readonly string[]): number {
  let count = 0;
  for (const needle of needles) {
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
  }
  return count;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MIN_WORDS_TO_JUDGE = 8;
const CONCISE_WORD_LIMIT = 60;
const DETAILED_WORD_THRESHOLD = 180;
const SHORT_SENTENCE_WORDS = 12;
const LONG_SENTENCE_WORDS = 24;

/** Analyze one user-authored text. Returns null judgements rather than guessing. */
export function analyzeWritingStyle(text: string): StyleObservation {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/).filter((w) => w !== '');
  const sentences = splitSentences(trimmed);
  const avgSentenceWords =
    sentences.length === 0 ? 0 : Math.round((words.length / sentences.length) * 10) / 10;
  const hedgeCount = countOccurrences(lower, HEDGES);

  const tooShort = words.length < MIN_WORDS_TO_JUDGE;

  let length: StyleObservation['length'] = null;
  if (!tooShort) {
    if (words.length <= CONCISE_WORD_LIMIT && avgSentenceWords <= SHORT_SENTENCE_WORDS + 4) {
      length = 'concise';
    } else if (words.length >= DETAILED_WORD_THRESHOLD || avgSentenceWords >= LONG_SENTENCE_WORDS) {
      length = 'detailed';
    }
  }

  let directness: StyleObservation['directness'] = null;
  if (!tooShort) {
    const hedgesPer100Words = (hedgeCount / words.length) * 100;
    if (hedgesPer100Words >= 2.5) directness = 'softened';
    else if (hedgeCount === 0 && words.length >= 15) directness = 'direct';
  }

  const formalHits = countOccurrences(lower, FORMAL_MARKERS);
  const casualHits = countOccurrences(lower, CASUAL_MARKERS);
  let formality: StyleObservation['formality'] = null;
  if (formalHits > casualHits && formalHits > 0) formality = 'formal';
  else if (casualHits > formalHits && casualHits > 0) formality = 'casual';

  const lines = trimmed.split('\n').map((l) => l.trim());
  const bulletLines = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l)).length;
  const structure: StyleObservation['structure'] =
    bulletLines >= 3 && bulletLines >= lines.length * 0.3 ? 'bullets' : null;

  return {
    length,
    directness,
    formality,
    structure,
    wordCount: words.length,
    avgSentenceWords,
    hedgeCount,
  };
}

// ---------- Draft edits ----------

export interface DraftEditObservation {
  /** Style dimensions the user's edit moved, with the direction they moved to. */
  changes: Array<{
    dimension: 'length' | 'directness' | 'formality' | 'structure';
    to: string;
    note: string;
  }>;
}

/**
 * Compare an AI-generated draft with the user's edited version. Edits are
 * among the strongest passive style evidence we have (revealed preference:
 * the user actively chose to change the output).
 */
export function analyzeDraftEdit(original: string, edited: string): DraftEditObservation {
  const changes: DraftEditObservation['changes'] = [];
  const before = analyzeWritingStyle(original);
  const after = analyzeWritingStyle(edited);

  const lengthRatio = before.wordCount === 0 ? 1 : after.wordCount / before.wordCount;
  if (lengthRatio <= 0.7 && before.wordCount >= 30) {
    changes.push({
      dimension: 'length',
      to: 'concise',
      note: `Shortened the draft from ${before.wordCount} to ${after.wordCount} words`,
    });
  } else if (lengthRatio >= 1.4 && after.wordCount >= 30) {
    changes.push({
      dimension: 'length',
      to: 'detailed',
      note: `Expanded the draft from ${before.wordCount} to ${after.wordCount} words`,
    });
  }

  if (before.hedgeCount > after.hedgeCount && before.hedgeCount - after.hedgeCount >= 2) {
    changes.push({
      dimension: 'directness',
      to: 'direct',
      note: `Removed ${before.hedgeCount - after.hedgeCount} hedging phrases`,
    });
  } else if (after.hedgeCount - before.hedgeCount >= 2) {
    changes.push({
      dimension: 'directness',
      to: 'softened',
      note: `Added ${after.hedgeCount - before.hedgeCount} softening phrases`,
    });
  }

  if (before.formality !== after.formality && after.formality !== null) {
    changes.push({
      dimension: 'formality',
      to: after.formality,
      note: `Rewrote the draft in a more ${after.formality} register`,
    });
  }

  if (before.structure !== after.structure && after.structure === 'bullets') {
    changes.push({
      dimension: 'structure',
      to: 'bullets',
      note: 'Restructured prose into bullet points',
    });
  }

  return { changes };
}
