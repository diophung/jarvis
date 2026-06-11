/**
 * Contextual personalization: resolve a personalization config for a task
 * (digest, drafting, ranking, …) from the user's learned preferences.
 * Pure — the server PersonalizationService supplies the preferences and any
 * live context (e.g. calendar density).
 *
 * Every applied preference is returned with a reason: personalization must be
 * explainable ("a good assistant says: here is why — correct me anytime").
 */
import { MIN_ACTIONABLE_CONFIDENCE, type AppliedPreference, type LearnedPreference, type LearningScope, type PersonalizationConfig, type PersonalizationRequest, type PersonalizationResult } from './types.js';

const BUSY_MAX_ITEMS = 5;

function defaultConfig(task: PersonalizationRequest['task']): PersonalizationConfig {
  // Cognitive load theory: default to structured, scannable output for
  // scanning tasks; prose for composition tasks.
  const structured = task === 'digest' || task === 'task_ranking' || task === 'summarization';
  return {
    verbosity: 'balanced',
    structure: structured ? 'bullets' : 'prose',
    tone: 'neutral',
    directness: 'direct',
    emphasize: [],
    deemphasize: [],
    riskFirst: false,
    maxItemsPerSection: null,
  };
}

/**
 * Scope match: every field set on the preference's scope must match the
 * request. Specificity = number of matched fields, so an audience-specific
 * style beats a global one (context-dependent behavior: most specific
 * context wins).
 */
function scopeMatch(scope: LearningScope, req: PersonalizationRequest): number | null {
  let specificity = 0;
  const checks: Array<[keyof LearningScope, string | undefined]> = [
    ['audience', req.audience],
    ['domain', req.domain],
    ['channel', req.channel],
    ['personEmail', req.personEmail?.toLowerCase()],
  ];
  for (const [field, reqValue] of checks) {
    const prefValue = scope[field];
    if (prefValue === undefined) continue;
    if (reqValue === undefined || prefValue !== reqValue) return null;
    specificity += 1;
  }
  return specificity;
}

/** A preference influences behavior only when actionable: confident enough, pinned, or explicit. */
function isActionable(pref: LearnedPreference): boolean {
  if (pref.status !== 'active') return false;
  return (
    pref.confidence >= MIN_ACTIONABLE_CONFIDENCE || pref.pinned === 1 || pref.origin === 'explicit'
  );
}

export function resolvePersonalization(
  preferences: LearnedPreference[],
  req: PersonalizationRequest,
): PersonalizationResult {
  const config = defaultConfig(req.task);
  const applied: AppliedPreference[] = [];

  const matched = preferences
    .map((pref) => ({ pref, specificity: scopeMatch(pref.scope, req) }))
    .filter((m): m is { pref: LearnedPreference; specificity: number } => m.specificity !== null)
    .filter((m) => isActionable(m.pref))
    // Ascending specificity, then ascending confidence: the most specific,
    // most confident preference is applied last and wins conflicts.
    .sort(
      (a, b) =>
        a.specificity - b.specificity ||
        a.pref.confidence - b.pref.confidence ||
        a.pref.updatedAt.localeCompare(b.pref.updatedAt),
    );

  const reasonFor = (pref: LearnedPreference, effect: string): string => {
    const scopeBits = Object.entries(pref.scope)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    const why =
      pref.origin === 'explicit'
        ? 'you asked for this directly'
        : pref.origin === 'feedback'
          ? `learned from your feedback (${pref.evidenceCount} observations)`
          : `inferred from ${pref.evidenceCount} repeated behaviors`;
    return `${effect} because ${why}${scopeBits === '' ? '' : ` [scope: ${scopeBits}]`} (confidence ${pref.confidence.toFixed(2)})`;
  };

  const apply = (pref: LearnedPreference, effect: string, mutate: () => void): void => {
    mutate();
    applied.push({
      preferenceId: pref.id,
      statement: pref.statement,
      confidence: pref.confidence,
      origin: pref.origin,
      reason: reasonFor(pref, effect),
    });
  };

  for (const { pref } of matched) {
    if (pref.key === 'style.length') {
      const verbosity = pref.value === 'concise' ? 'concise' : 'detailed';
      apply(pref, `Set verbosity to ${verbosity}`, () => {
        config.verbosity = verbosity;
      });
    } else if (pref.key === 'style.directness') {
      const directness = pref.value === 'direct' ? 'direct' : 'softened';
      apply(pref, `Set directness to ${directness}`, () => {
        config.directness = directness;
      });
    } else if (pref.key === 'style.formality') {
      const tone = pref.value === 'formal' ? 'formal' : pref.value === 'casual' ? 'casual' : 'neutral';
      apply(pref, `Set tone to ${tone}`, () => {
        config.tone = tone;
      });
    } else if (pref.key === 'format.structure' && pref.value === 'bullets') {
      apply(pref, 'Use bullet-point structure', () => {
        config.structure = 'bullets';
      });
    } else if (pref.key.startsWith('topic.priority:')) {
      const topic = pref.key.slice('topic.priority:'.length);
      if (pref.value === 'high') {
        apply(pref, `Emphasize topic "${topic}"`, () => {
          if (!config.emphasize.includes(topic)) config.emphasize.push(topic);
        });
      } else {
        apply(pref, `De-emphasize topic "${topic}"`, () => {
          if (!config.deemphasize.includes(topic)) config.deemphasize.push(topic);
        });
      }
    } else if (pref.key.startsWith('person.priority:')) {
      const email = pref.key.slice('person.priority:'.length);
      if (pref.value === 'high') {
        apply(pref, `Emphasize messages from ${email}`, () => {
          if (!config.emphasize.includes(email)) config.emphasize.push(email);
        });
      } else {
        apply(pref, `De-emphasize messages from ${email}`, () => {
          if (!config.deemphasize.includes(email)) config.deemphasize.push(email);
        });
      }
    } else if (pref.key === 'risk.attention' && pref.value === 'prioritizes_risk') {
      // Prospect theory: this user attends to losses/risks first.
      apply(pref, 'Rank risk/loss-framed items first', () => {
        config.riskFirst = true;
      });
    } else if (pref.key === 'schedule.load' && pref.value === 'overloaded') {
      apply(pref, 'Keep briefings short (dense calendar pattern)', () => {
        if (config.verbosity === 'balanced') config.verbosity = 'concise';
        config.maxItemsPerSection = config.maxItemsPerSection ?? BUSY_MAX_ITEMS;
      });
    }
    // goal.*, workflow.*, action.trust:* inform other surfaces (digest copy,
    // approval suggestions); they do not change output formatting here.
  }

  // Live overload hint (cognitive load theory): when the user is busy right
  // now, prefer concise structured output regardless of stored preferences —
  // a contextual adjustment, never a stored trait.
  if (req.userBusy === true) {
    config.verbosity = 'concise';
    if (config.structure === 'prose' && req.task !== 'email_draft') config.structure = 'bullets';
    config.maxItemsPerSection = Math.min(config.maxItemsPerSection ?? BUSY_MAX_ITEMS, BUSY_MAX_ITEMS);
  }

  return { config, applied };
}
