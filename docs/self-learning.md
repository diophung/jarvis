# Self-learning subsystem

Jarvis's self-learning subsystem turns the user's real activity — email, chat,
calendar, feedback, draft edits, approval decisions, explicit commands — into
**learned preferences**: inspectable, correctable, decaying statements about
how the user works, each with provenance, confidence, and a "why Jarvis thinks
this" explanation. Those preferences then personalize Jarvis's outputs (chat
replies, drafts, the daily debrief, prioritization) and every personalization
decision is returned with its reasons.

The product contract: *"Based on these signals, I think this matters to you.
Here is why. Correct me anytime."* Never: *"I know you better than you know
yourself."*

Companion docs:

- [self_learning_psychology_foundation.md](./self_learning_psychology_foundation.md)
  — the behavioral-science grounding; every mechanism below maps to a concept
  there.
- [api-contract.md](./api-contract.md) — the `/api/learning/*` REST surface.
- [architecture.md](./architecture.md) — how the subsystem fits the system map.

## Architecture

The repo's standing split applies: **everything in
`packages/core/src/learning` is pure and deterministic** (no clock, no IO —
all time math takes `now`), and `apps/server` owns persistence, wiring, and
the API.

```
                          packages/core/src/learning (pure)
            ┌─────────────────────────────────────────────────────┐
            │ types.ts       contracts: LearningSignal,           │
            │                LearnedPreference, scopes, configs   │
            │ privacy.ts     sensitive-attribute guard            │
            │ style.ts       writing-style + draft-edit analysis  │
            │ extract.ts     signal extractors                    │
            │ confidence.ts  evidence/recency/decay math          │
            │ infer.ts       signals -> preferences engine        │
            │ personalize.ts preferences -> output config+reasons │
            └─────────────────────────────────────────────────────┘
                    ▲ data in                 │ results out
                    │                         ▼
            apps/server/src/services/learning.ts  (IO, audit, API)
            apps/server/src/services/personalization.ts
                    ▲                         │
   feedback.ts ─────┤                         ├──> assistant.ts (chat context)
   assistant.ts ────┤ (hooks)                 ├──> digest.ts (narrative style)
   routes/learning ─┤                         └──> routes/learning.ts (UI API)
   worker-loop.ts ──┘ (hourly learn, daily decay)
```

### Data flow: observe → signal → preference → personalization

1. **Ingestion** (existing): connectors sync email/chat/calendar/storage into
   `source_items`; uploads, feedback, approvals, and chat already have their
   own stores. The learning subsystem reads these — it needs no new
   connectors, and real providers plug in through the existing `Connector`
   interface.
2. **Signal extraction** (`extract.ts`, run by
   `learning.extractFromSources` hourly or on demand): deterministic
   extractors turn observations into normalized `LearningSignal` rows:
   - *Self-authored* email/chat → writing-style signals (length, directness,
     formality, structure), scoped by **audience** (leadership / team /
     external / personal, classified from the people table and email
     domains), plus goals, commitments, delegation, and low-strength
     sentiment markers.
   - *Thread reply behavior* → revealed preference: fast replies raise a
     person's priority, ignored direct messages lower it (weakly); fast
     replies to loss/risk-framed content feed a `risk.attention` signal.
   - *Calendar density* → overload context signals.
   - *Approval decisions* → `action.trust:<capability>` signals.
   - *Explicit feedback* (important / not important / more-like-this …) →
     high-strength person/topic signals, hooked synchronously from the
     feedback service.
   - *Draft edits* (`POST /api/learning/draft-feedback`) → strong style
     signals from diffing the AI draft against the user's edit.
   - *Explicit commands* in chat ("keep replies short", "jane@acme.com is
     high priority") → maximum-strength explicit signals, applied
     immediately.
3. **Privacy guard** (`privacy.ts`): every signal and preference statement is
   checked before persistence; anything touching health, politics, religion,
   sexuality, ethnicity, immigration status, union membership, or criminal
   history is **dropped, never stored** — including via the explicit API
   (400 `sensitive_attribute`). The guard only restricts what the *learning*
   store keeps; it does not censor the user's data or chat.
4. **Inference** (`infer.ts`, run by `learning.runInference`): pending
   signals are grouped by `(key, scope)`, weighted by strength × recency, and
   aggregated into `learned_preferences`. Single weak observations never
   create a preference; groups without clear dominance stay pending.
5. **Personalization** (`personalize.ts` via the personalization service):
   given a task + context (audience, channel, domain, person), scope-matching
   actionable preferences produce an output config (verbosity, structure,
   tone, directness, emphasize/deemphasize lists, risk-first ranking, item
   caps) plus an `applied[]` list with a reason per preference. Live calendar
   density adds a `userBusy` hint that tightens output without storing a
   trait. Consumers today: assistant chat context, digest narrative.

## Memory schema

Two tables (migration `0003_self_learning`, same portable SQL subset as the
rest of the schema):

**`learning_signals`** — append-only observations (short/medium-term memory):

| column | meaning |
|---|---|
| `kind` | signal family (`writing_style`, `reply_behavior`, `feedback`, `explicit_statement`, `action_decision`, `goal`, `commitment`, `loss_frame`, `sentiment`, `calendar_density`, `delegation`, …) |
| `key` / `value` | aggregation key (e.g. `style.length`, `person.priority:jane@acme.com`) and observed value bucket (`concise`, `high`, `approved`, …) |
| `strength` | 0..1 weight of this single observation (sentiment capped at 0.2; explicit = 1) |
| `scope` | JSON `LearningScope` — domain / audience / channel / project / person |
| `detail`, `source` | human-readable observation + provenance (`sourceType`, `refId`, `observedAt`, `note`) |
| `processed` | 0 until consumed by inference; pending signals older than 180 days are pruned |

**`learned_preferences`** — the long-term user model:

| column | meaning |
|---|---|
| `category` | `communication_style`, `format`, `people`, `topics`, `priorities`, `scheduling`, `decision_style`, `workflow` |
| `key`, `value`, `statement` | aggregation identity + the human-readable tendency statement |
| `scope`, `scope_key` | context the preference applies in; `(workspace, user, key, scope_key)` is unique |
| `origin` | `explicit` (user said so) > `feedback` (direct UI feedback) > `inferred` (repeated behavior) |
| `status` | `active`, `rejected` (user marked wrong — never re-learned from behavior), `retired` (decayed out) |
| `confidence`, `evidence_count`, `evidence_weight`, `contradiction_count` | scoring state (below) |
| `pinned`, `decay_half_life_days`, `last_reinforced_at` | decay policy; pinned = exempt |
| `explanation`, `sources`, `contradictions`, `user_note` | mandatory "why", capped evidence refs both ways, user annotation |

Memory tiers: per-request context (assembled fresh, never stored) →
`learning_signals` (raw observations, prunable) → `learned_preferences`
(durable, decaying, user-governed). The pre-existing `memory_entries` table
remains the free-form notebook; learned preferences are the structured,
evidence-backed behavioral model.

## Preference inference rules

All in `packages/core/src/learning/{confidence,infer}.ts`, fully unit-tested:

- **Repetition required.** Confidence = `base(origin) + (max(origin) −
  base) × (1 − e^−(weight−1)/4)`. A single passive observation contributes
  nothing beyond the origin base (inferred base 0.25, below the actionable
  threshold). Explicit base is 0.9; inferred confidence is capped at 0.8 —
  behavioral inference never reaches certainty.
- **Actionable threshold.** Preferences influence behavior only at
  confidence ≥ 0.45, or when pinned, or explicit. Below that they are shown
  as "tentative — not used yet".
- **Recency.** Evidence weight = strength × recency (full weight for a week,
  ~90-day fade). Recent behavior matters more than old behavior.
- **Creation gate.** A new preference needs weighted evidence ≥ 1.0 *and*
  ≥ 60% dominance of its group; otherwise signals stay pending.
- **Contradictions (same scope).** Opposing observations increment
  `contradiction_count`, divide confidence by `(1 + 0.3 × n)`, and are kept
  as visible contradicting evidence. If opposing behavior reaches 1.5× the
  accumulated support, a non-explicit, unpinned preference **flips** (with
  an explanation noting the flip). Explicit preferences never flip from
  behavior.
- **Context splits (different scope).** Same key with different values in
  different scopes is *not* a contradiction — it becomes separate scoped
  preferences (terse with the team, warm with clients). The contradiction
  report surfaces splits for transparency.
- **Explicit > everything.** An explicit statement overrides accumulated
  behavior immediately, re-origins the preference as explicit, and
  reactivates rejected/retired preferences (the user changed their mind).
- **Rejected stays rejected.** Behavior signals matching a `rejected`
  preference are discarded, never re-learned.
- **Decay.** Confidence halves per half-life since last reinforcement
  (explicit 365d, feedback 180d, inferred 90d; floor 0.05). Unpinned,
  non-explicit preferences below 0.12 are retired by the daily worker job.
- **Merging.** Same key+value preferences whose scopes nest are merged into
  the broader scope, summing evidence.

## Privacy model

1. **No hidden profiling** — every learned preference is listable at
   `GET /api/learning` and on the Learned Preferences page; every creation,
   correction, deletion, and learning run is written to `audit_logs`.
2. **Provenance everywhere** — signals and preferences carry source type,
   ref, timestamp, and a human-readable note; `explain` returns the trail.
3. **User control** — confirm / edit / pin / mark wrong / delete per
   preference; one switch disables learning entirely (extraction, hooks, and
   personalization all gate on it).
4. **Sensitive attributes are never inferred or stored** — the privacy guard
   filters signals, statements, and explicit submissions; tests assert
   non-storage against realistic medical-thread fixtures.
5. **Tendencies, not labels** — statements are phrased as "Tends to…", capped
   confidence, never aggregated into a personality profile.
6. **Local/tenant-isolated** — learning is row-scoped to the workspace in the
   app database; nothing is sent to external models for training. LLM calls
   that *use* preferences (digest narrative, chat) go through the existing
   audited router and include only preference statements, never raw signals.
7. **Deletion is real** — deleting a preference also deletes its evidence
   signals; pending signals expire after 180 days.

## Example flows

**Passive style learning.** Alex sends four terse updates to the CEO over two
weeks → four `style.length=concise` signals scoped `audience=leadership` →
inference creates "Tends to prefer concise messages when writing to
leadership" (inferred, ~0.5 confidence) → drafting an email to leadership
returns `verbosity: concise` with the reason "inferred from 4 repeated
behaviors [scope: audience=leadership] (confidence 0.50)". Writing to a
friend is unaffected.

**Explicit command.** Alex types "keep summaries short" in chat → the
assistant hook stores an explicit `style.length=concise` signal and runs
inference immediately → an explicit preference (0.9) exists before the next
reply; the memory service separately keeps the free-form note.

**Correction.** The Learned Preferences page shows "Tends to deprioritize
messages from daniel@northwind.io" with its evidence (two unanswered
threads). Alex clicks *mark wrong* → status `rejected`, confidence 0, and
future ignored-thread signals for Daniel are discarded instead of re-learned.

**Draft edit.** Jarvis drafts a hedge-heavy email; Alex rewrites it tersely
and the UI posts both versions to `draft-feedback` → strong (0.7) signals for
`style.length=concise` and `style.directness=direct` scoped to that audience.

## Operations

- Worker (`worker-loop.ts`): per workspace, `learnNow` (extract → infer →
  merge) at most hourly; `decayConfidence` daily; both audit and both skip
  when learning is disabled. Watermarks live in `app_settings`
  (`learning.lastExtractedAt`, `learning.lastRunAt`, `learning.lastDecayAt`).
- Extraction is idempotent: signals are fingerprinted
  (`kind|key|value|sourceType|refId`) and deduped against stored signals, so
  re-running over an overlapping window never double-counts.
- Caps: 2000 items / 1000 signals per run, 20 stored evidence refs per
  preference.

## Future work

- **Project scoping** — signals carry a `projectId` scope slot that
  extraction does not populate yet; linking via the existing
  `source_items.project_ids` would enable per-project preferences.
- **Commitment tracking** — commitment signals are extracted and stored but
  not yet surfaced as follow-up nudges ("you said you'd send the plan").
- **Sentiment-informed topic attention** — sentiment signals are stored as
  informational only; repeated frustration around a topic could justify a
  cautious attention boost.
- **Scoring-engine integration** — `task_ranking` personalization
  (emphasize/deemphasize, risk-first) is computed but the deterministic
  scoring engine does not consume it yet; wiring it in would close the loop
  on calendar/task prioritization.
- **Approval auto-allow suggestions** — `action.trust` preferences could
  suggest (never apply) policy changes like "always allow email drafts".
- **Embedding-based topic clustering** — topics are keyword slugs; the
  existing embedding infrastructure could cluster them semantically.
- **LLM-assisted extraction** — a routed `classification` model could
  propose additional candidate signals, clamped the way scoring refinement
  is today (deterministic rules stay in charge).
