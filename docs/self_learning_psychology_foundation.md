# Self-learning: psychology & behavioral-science foundation

This note grounds Donna's self-learning subsystem in established, mainstream
psychology and behavioral-science research. Every concept below maps to a
concrete mechanism in the implementation (`packages/core/src/learning/*` and
`apps/server/src/services/learning.ts` / `personalization.ts`). Where a
concept influences an algorithm, the code carries a short comment referencing
this document.

Two ground rules shape everything:

1. **Soft signals, never labels.** Psychological constructs are treated as
   probabilistic *behavioral tendencies* with confidence scores, provenance,
   and decay — never as fixed personality labels. Donna stores "tends to
   prefer concise replies to leadership (confidence 0.72, 14 observations)",
   not "user is an introvert".
2. **Explainable and correctable.** Every inference carries a "why Donna
   thinks this" explanation and can be confirmed, edited, pinned, marked
   wrong, or deleted by the user. The user is the authority on themselves;
   Donna's model is always subordinate to explicit user statements.

---

## 1. Big Five personality traits (cautious, probabilistic use)

**Research basis.** The five-factor model (openness, conscientiousness,
extraversion, agreeableness, neuroticism) is the most replicated trait
taxonomy in personality psychology (Costa & McCrae's NEO research program;
John & Srivastava's Big Five Inventory work; Goldberg's lexical studies).
Crucially, the literature itself stresses that traits are *distributions of
behavior across situations*, observed reliably only through repeated
measurement — single observations are weak evidence (Fleeson's density
distribution work on within-person variability).

**How Donna uses it.** Donna does **not** score the user on the Big Five and
never stores trait labels. The model is used only as a *design vocabulary*
for which behavioral tendencies are worth tracking as preferences:

- conscientiousness-adjacent signals → deadline sensitivity, structured vs.
  free-form output preferences, follow-up discipline;
- extraversion-adjacent signals → meeting density tolerance, breadth of
  correspondence (informational only, never inferred as a trait);
- agreeableness/communication signals → warmth vs. directness in drafts.

Each is stored as an independent, scoped `LearnedPreference` with its own
evidence trail — never aggregated into a personality profile. The
`privacy.ts` guard explicitly blocks anything resembling clinical or
trait-diagnostic statements.

**Code mapping:** `PREFERENCE_CATEGORIES` in `learning/types.ts` covers
behavioral-tendency categories (communication style, scheduling, priorities)
rather than trait dimensions; no category exists for "personality".

## 2. Revealed preference theory

**Research basis.** Originating in Samuelson's economics (1938) and widely
adopted in behavioral science: what people repeatedly *choose* under real
constraints is stronger evidence of preference than what they *say* in the
abstract — though stated and revealed preferences must be reconciled, not
either ignored.

**How Donna uses it.** This is the core of passive learning:

- Replies vs. ignores, approve vs. deny on agent actions, accept vs. rewrite
  of drafts, done vs. dismissed on tasks, attended vs. declined meetings are
  all *choices* and generate `LearningSignal`s.
- Repeated choices in the same direction raise confidence via a saturating
  evidence curve (`confidence.ts`); a single choice never produces an
  actionable preference.
- Explicit statements still rank **above** revealed behavior
  (`ORIGIN_WEIGHTS`: explicit > feedback > inferred), because the user's
  direct word is authoritative and revealed signals can be confounded
  (busyness, delegation, accident).

**Code mapping:** `extract.ts` (`extractActionDecisionSignals`,
`extractFeedbackSignals`, `extractDraftEditSignals`), `confidence.ts`
(`evidenceFactor` saturating curve).

## 3. Cognitive load theory

**Research basis.** Sweller's cognitive load theory: working memory is
sharply limited; extraneous load degrades performance; well-structured,
chunked information reduces load. Related HCI findings: under time pressure
people satisfice and skim (information-foraging research, Pirolli & Card).

**How Donna uses it.**

- Personalization defaults bias toward *concise, structured, scannable*
  output (summaries first, bullets, tables only for comparisons) unless
  learned preferences say otherwise.
- Calendar-density and response-latency signals feed a contextual "overload"
  hint: when the user's calendar is dense or replies are unusually delayed,
  the personalization engine recommends shorter outputs and fewer items per
  section — a *contextual* adjustment, not a stored trait.

**Code mapping:** `personalize.ts` (`resolvePersonalization` busy-context
rule), `extract.ts` (calendar-density signal).

## 4. Goal-setting theory

**Research basis.** Locke & Latham: specific, challenging goals with feedback
drive performance; goal conflict and blocked goals are distinct, detectable
states that change behavior and stress.

**How Donna uses it.**

- Explicit goals ("ship Atlas by the 18th", "hire two engineers this
  quarter") are extracted as `goal` signals with deadlines where present.
- Recurring topics in self-authored text across weeks are treated as
  candidate implicit goals (only surfaced as low-confidence preferences).
- "Blocked"/"waiting on" language attached to a tracked goal raises the
  priority weight of related items — a blocked goal matters more, not less.

**Code mapping:** `extract.ts` (`GOAL_RE`, `BLOCKED_RE` extraction),
inference category `priorities` in `infer.ts`.

## 5. Self-determination theory (SDT)

**Research basis.** Deci & Ryan: autonomy, competence, and relatedness are
basic psychological needs; supporting autonomy (choice, rationale,
non-controlling language) sustains intrinsic motivation; surveillance and
control undermine it.

**How Donna uses it.** SDT primarily shapes the *product behavior* of the
learning system rather than a specific score:

- **Autonomy:** every learned preference is user-controllable (confirm /
  edit / pin / mark wrong / delete); Donna phrases inferences as offers
  ("Based on these signals, I think… correct me anytime"), never as
  verdicts. Learning can be disabled globally.
- **Competence:** explanations show *why* a recommendation was made so the
  user stays in command of their own system.
- **Relatedness:** people the user invests in repeatedly (fast replies, high
  interaction counts) are learned as important relationships — with the
  evidence shown.

**Code mapping:** the corrections API (`applyUserCorrection`), the
`explanation` field required on every `LearnedPreference`, and the
`learning.enabled` setting.

## 6. Prospect theory / loss aversion

**Research basis.** Kahneman & Tversky: losses loom larger than equivalent
gains (loss aversion); people are risk-averse for gains and risk-seeking for
losses; framing matters.

**How Donna uses it.**

- Risk/loss/deadline/reputation language ("we could lose the account",
  "churn risk", "penalty", "miss the deadline", "escalating to") is
  extracted as loss-framed urgency signals and, when the user consistently
  *responds faster* to loss-framed items, Donna learns a preference like
  "prioritizes risk/loss items over upside opportunities" — with evidence.
- The digest's "Risks & Blockers" section ranking is boosted when this
  preference is active.

**Code mapping:** `extract.ts` (`LOSS_FRAME_RE`), `infer.ts` (risk-priority
inference), `personalize.ts` (risk-section emphasis).

## 7. Politeness theory & communication accommodation theory

**Research basis.** Brown & Levinson's politeness theory: face-threatening
acts are mitigated proportionally to social distance, power differential,
and imposition. Giles' communication accommodation theory (CAT): speakers
converge toward interlocutors' styles to build rapport and diverge to assert
identity. Together they predict that one person legitimately uses *different
registers for different audiences*.

**How Donna uses it.** This is why **audience scope** is first-class:

- Writing-style signals are always extracted *per audience bucket*
  (leadership, direct team, external client, vendor, personal) rather than
  globally — Donna never assumes the style used with a friend applies to a
  board member.
- Draft personalization returns audience-scoped style configs (formality,
  directness, greeting/sign-off conventions) with the matched scope shown.

**Code mapping:** `LearningScope.audience` in `types.ts`; `style.ts`
audience-bucketed analysis; `getPreferencesByContext` scope matching.

## 8. Affective computing basics (with epistemic humility)

**Research basis.** Picard's affective computing program established that
affect can be *estimated* from behavioral traces, but text-based emotion
detection is noisy and context-dependent; the field's own best practice is
to report uncertainty and avoid overclaiming (also reflected in sentiment
analysis literature: lexical methods capture valence/arousal coarsely).

**How Donna uses it.**

- Only coarse, lexically grounded markers: positive/negative valence,
  urgency, frustration markers, enthusiasm markers, hedging/uncertainty
  markers — each stored as a *signal about a message*, never as "the user
  is angry".
- Affect signals are capped at low strength and never produce a stored
  preference on their own; they only modulate context (e.g. repeated
  frustration markers around a topic increase that topic's attention
  weight).
- Sensitive affect inference (mood disorders, mental state) is blocked by
  the privacy guard.

**Code mapping:** `extract.ts` sentiment/urgency marker extraction with
`strength` caps; `privacy.ts` blocklist.

## 9. Habit formation & behavioral consistency

**Research basis.** Wood & Neal's habit research and Lally et al.'s habit
formation studies: habits are context-cued regularities built through
repetition over weeks; one-off actions are poor predictors. Behavioral
consistency across situations is the empirical basis for inferring stable
dispositions (consistent with Mischel's situationism critique: consistency
must be demonstrated, not assumed).

**How Donna uses it.** This is the backbone of confidence scoring:

- A preference's confidence increases only with *repeated* evidence, via a
  saturating curve — stable preference inference must rest on repeated
  revealed behavior, not isolated statements or single events.
- Evidence is time-weighted: recent behavior counts more (recency-weighted
  evidence), and unreinforced preferences *decay* toward a floor, modeling
  habit extinction and preference drift.
- One-off behaviors stay below the actionable-confidence threshold
  (`MIN_ACTIONABLE_CONFIDENCE`), visible to the user as "tentative".

**Code mapping:** `confidence.ts` (`evidenceFactor`, `decayConfidence`,
half-life policy), `MIN_ACTIONABLE_CONFIDENCE` in `types.ts`.

## 10. Context-dependent behavior

**Research basis.** Mischel & Shoda's cognitive-affective personality system
(CAPS): behavior follows stable *if-situation-then-behavior* signatures, not
global cross-situational constants. People genuinely differ between work,
family, finance, and health contexts.

**How Donna uses it.**

- Every signal and preference carries a `scope` (domain such as work /
  personal / finance, plus optional audience, project, channel). Preferences
  are matched by scope at personalization time; a global preference is only
  formed when evidence spans contexts.
- Contradiction handling prefers *splitting by context* over averaging:
  if the user writes tersely to the team but warmly to clients, Donna learns
  two scoped preferences rather than one muddy global one. Only when
  contradictory evidence occurs *within the same scope* does confidence
  drop.

**Code mapping:** `LearningScope` in `types.ts`; `detectContradictions` and
context-splitting in `infer.ts`; scope-specificity ranking in
`getPreferencesByContext`.

---

## Cross-cutting safeguards derived from the research

| Safeguard | Rationale | Mechanism |
|---|---|---|
| No sensitive inference | Protected-class/medical/political/religious/sexual inference is both ethically off-limits and scientifically unreliable from text | `privacy.ts` guard filters signals and preference statements before storage; tests assert non-storage |
| Tentative by default | Single observations are weak evidence (habit & trait research) | confidence starts low; saturating evidence curve; actionable threshold |
| Explicit beats inferred | Stated preferences are authoritative; revealed signals are confounded | origin weighting + explicit corrections override and pin |
| Decay | Preferences drift; stale models are worse than no model | exponential decay with per-category half-life, floor, and pin exemption |
| Context first | Cross-situational consistency cannot be assumed | scoped preferences, contradiction-driven context splitting |
| Explain everything | Autonomy support (SDT); trust calibration | mandatory `explanation`, provenance, evidence counts on every preference |
