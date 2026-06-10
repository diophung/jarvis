# Donna in 10 minutes

A hands-on tour of the product, start to finish, using only the zero-config demo setup. Every label and button below is the real UI.

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173.

## 1. First boot

You're signed in automatically (local auth mode) and a demo workspace has already been seeded: four connected sources — **Work Email (demo)**, **Team Chat (demo)**, **Calendar (demo)**, **Cloud Drive (demo)** — populated with a coherent scenario. You're playing *Alex Chen, VP Product at Meridian Labs*: the Atlas launch is six days out, a budget decision is due Friday, a vendor migration is blocked on a security review, and an email from a key customer got buried three days ago.

Across the top you'll see an amber banner:

> **Demo mode — no AI provider configured. Responses are mocked.** Set up a local or cloud model →

Leave it for now — everything in this tour works in demo mode. The sidebar gives you the map: **New chat**, **Daily Debrief**, **Priorities**, **Search**, **Approvals**, then under *Your data*: **Connected Sources**, **Uploaded Files**, **Digest History**, and at the bottom **Memory**, **Audit Log**, **Settings**.

## 2. Generate your first Daily Debrief

Click **Daily Debrief**. You'll see "No debrief yet" — click **Generate my debrief**.

A few seconds later you get an executive briefing, not a dashboard:

- A header with the date, a `manual` badge, and a model badge — in demo mode it reads **rule-based**, because the whole debrief was produced by deterministic rules.
- A summary card, then sections in priority order: **Meetings Needing Prep**, **Risks & Blockers**, **Most Urgent**, **Most Important**, **Missed or Ignored**, **Unresolved Follow-ups**, **High-Effort Work**, **Worth Reading** (only non-empty sections appear).
- A **Suggested plan for today** card at the bottom, and a footer like *"Considered 28 items · ignored 9 low-signal items"*.

## 3. Read an item — and ask why

Each item card shows the title, where it came from, **priority / urgency / effort** pills, a planning-category badge (Do Now, Decide, Follow Up, …), a recommended action ("→ Reply today."), and a one-line explanation.

Now click **Why this matters** on any card. It expands into the actual scoring signals with weights, for example:

```
+30  Sender importance: vip — from Sarah Okafor (key stakeholder)
+15  Active project — relates to Atlas Launch
+12  Blocking others — someone is waiting on you
 +8  Mentions a deadline
```

This is the heart of Donna: every score is explainable, down to the rule and the weight. Click the item's title to open the underlying source — the full email or event, with sender, participants, timestamp, and provider.

Note the **Regenerate** button: debriefs are never overwritten. **Digest History** in the sidebar keeps every version.

## 4. Chat: "What needs my attention today?"

Click **New chat**. The hero greets you by name and offers suggested prompts. Click **"What needs my attention today?"**

The answer streams in, grouped by planning category, with bold item titles, scores, and why-lines — built from the same scored data as the debrief. In demo mode the answer ends with an italic footer telling you it was generated without an AI model.

Two things to try:

- **Citations.** Numbered chips appear under the answer. Click one — it opens the cited source item in a modal, so every claim traces back to a real email, message, or event.
- **Suggested actions.** Below the last answer you'll find action chips like **Mark done**, **Defer to later**, **Open the source**, and **Why this priority?**. They're real: *Mark done* updates the task, *Why this priority?* asks Donna to explain.

## 5. Give feedback and watch the rescoring

Open **Priorities** in the sidebar. Tasks are grouped by planning category, most actionable first. Each card has a score, the three pills, a **Why?** disclosure, and a row of icon actions: Done, Defer, then feedback — **Important**, **Not important**, **Urgent**, **Not urgent**, **Incorrect**, **More like this**.

Pick something Donna over-rated (a newsletter-ish item works well) and click **Not important** (the down arrow). You'll see *"Thanks — noted."*

Now click **Rescore** at the top right. The item's score drops, and if you open **Why?** you'll find a new negative signal:

```
-15  Marked not important before — you marked similar items not important
```

The feedback also recorded the sender into a derived preference list, so *future* mail from them starts lower too. The same feedback works in reverse: **Important** boosts a sender, **More like this** promotes the item's topic keywords.

## 6. Upload a PDF and search it

Open **Uploaded Files**. Drag a PDF (or DOCX, TXT, MD, CSV, JSON, HTML — up to 25 MB) onto the drop zone, or click **Browse files**.

The file shows **Processing**, then **Ready** with an **Indexed for search** badge. Click **View text** to see exactly what Donna extracted.

Now open **Search** and type a phrase from the document. Results appear as you type, with type filters (Emails & messages, Uploaded files, Memories, Digests) and a mode badge: **keyword** in demo mode, **semantic+keyword** once you've configured an embedding-capable provider. Uploaded files are first-class sources — they're also considered in your next debrief.

## 7. Ask Donna to send an email

Back in chat, type:

```
Send an email to Daniel Reyes about the security review
```

Donna composes a draft, shows it to you quoted in the reply — and does **not** send it. Instead you get an amber notice:

> Donna needs your approval for this action. **Review in Approvals**

`email.send` is an externally visible capability, and those ask first by default. Notice the **Approvals** item in the sidebar now has a badge.

## 8. The approval queue

Open **Approvals**. The pending card shows everything you need to decide:

- the capability in plain language (**Send emails**) with a risk badge,
- the reason (*User asked: "Send an email to Daniel Reyes…"*),
- a full preview — summary and the exact email body,
- the target provider/account and when the request expires (7 days),
- an **Always allow this** checkbox (with a warning that future sends will run without asking), an optional note, and **Deny** / **Approve** buttons.

Click **Approve**. The action executes against the demo email connector — which pretends to send and reports back, so the card is replaced by a result banner reading *"Done — Mock email sent to …"*. The **Decided** tab keeps the history of every approval, denial, and expiry.

## 9. The audit log

Open **Audit Log**. Everything you just did is here as an immutable trail: `connector.sync` from the seed, `digest.generated`, `feedback.recorded`, `approval.created`, `approval.approved`, `agent.action.executed`. Filter by event type or actor (user / agent / system / worker), and expand any row for its metadata. When a real model is configured you'll also see `llm.call` entries — metadata only (model, latency, token counts), never message content.

## 10. Settings tour

Open **Settings** — "Your data, your models, your rules."

- **Profile** — your name, email, and workspace.
- **Preferences** — the levers behind scoring: VIP email addresses, per-person importance, projects with keywords and priority, topics to prioritize or ignore, source preferences, working hours, and Donna's response style (concise/detailed).
- **AI Providers** — leave demo mode here. Click **Add provider** and pick a preset: Anthropic Claude, OpenAI, Google Gemini, or local **Ollama** (`http://localhost:11434/v1`), **vLLM** (`http://localhost:8000/v1`), **SGLang** (`http://localhost:30000/v1`). Each provider card has a **Check health** button and an explicit data-location badge — *"Runs locally — data stays on your machine"* vs *"Cloud — data is sent to …"*. Below, **Task routing** lets you assign a different provider/model to chat, summarization, digest generation, classification, and embeddings.
- **Permissions** — every capability Donna has, grouped (Reading & analysis, Local drafts & notes, External actions, Changes & deletions), each with *Allowed automatically / Ask me first / Never allow*.
- **Digest Schedule** — when the worker writes your debrief (presets like "Every morning at 7:00" or a custom cron), plus **Generate one now**.
- **Security** — auth mode and a prominent reminder to set a real `DONNA_SECRET` before exposing Donna beyond your machine.
- **Deployment** — what this instance is running (database, storage driver, data directory) and an env-var reference.

Finally, peek at **Memory** in the sidebar: everything Donna believes about you, each entry labeled **you told Donna**, **inferred · N% sure**, or **from your feedback** — editable, deletable, exportable as JSON, and with a master switch to turn memory off entirely. Try typing *"Remember that I prefer meetings before noon"* in chat, then watch it appear here.

---

That's the loop: sources in → explainable priorities → debrief and chat with citations → actions only with your approval → everything audited. To go further, add a model in **Settings → AI Providers** and connect real sources — see the README and `docs/connectors.md`.
