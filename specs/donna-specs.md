You are Claude Code running with the most capable available model and maximum reasoning effort. You are acting as a world-class product engineer, AI systems architect, security engineer, UX designer, platform engineer, and AI agent engineer.

Your mission is to autonomously implement Donna, a digital executive assistant that helps busy professionals understand what matters most across email, chat, calendar, cloud storage, and uploaded files.

Do not stop at a proposal. Inspect the repository first, infer the existing architecture, then implement the product end-to-end. If the repository is empty or incomplete, create a clean production-grade monorepo. Make pragmatic decisions, document them briefly, and continue. Do not ask clarifying questions unless implementation is impossible without the answer. Prefer sensible defaults and make every major subsystem configurable.

# Product Vision

Donna is a personal digital executive assistant for busy professionals. Donna connects to live systems such as email, chat, calendar, S3, Google Drive, OneDrive, and uploaded files. Donna learns user preferences over time, understands what is important, identifies what is urgent, estimates what requires the most effort, and presents a clear daily debrief and digest that helps the user prioritize and plan.

Donna’s job is not to dump notifications. Donna’s job is to reduce executive cognitive load. It should act like a smart chief of staff: identify the few things that matter, explain why they matter, recommend what to do next, and help the user plan the day.

The user experience should feel familiar to users of ChatGPT and Claude. Use a clean chat-first layout, a left sidebar for conversations and workspaces, a central assistant conversation area, and a contextual right panel where useful. The interface should feel calm, readable, and focused. The goal is to reduce cognitive load, not create another enterprise dashboard monster wearing a tie.

# Core Outcome

At the end of implementation, Donna must support a user who can run the app locally, configure an LLM provider, connect or simulate data sources, upload documents, chat with Donna, generate a daily debrief, inspect prioritized tasks, understand why each item matters, adjust preferences, configure permissions, approve or deny agentic actions, and review audit logs.

Donna must be deployable both locally and in the cloud.

# Implementation Strategy

First, inspect the existing codebase and identify the stack, package manager, app structure, backend framework, frontend framework, database, authentication approach, background worker approach, and deployment setup. Preserve what already exists when reasonable.

If there is no usable structure, create a modern full-stack TypeScript monorepo with a clean frontend, backend API, database schema, worker process, connector abstraction, LLM provider abstraction, file ingestion pipeline, and deployment configuration.

Implement the system in vertical slices, not disconnected scaffolding. A user should be able to run Donna locally, open the app, configure settings, upload data, see sample connected-source data through mock or real connectors, receive a generated digest, and interact with Donna through a ChatGPT-style interface.

# Architecture Requirements

Design Donna around these major subsystems:

1. Connector Layer — pluggable adapters for email, chat, calendar, cloud storage, and uploaded files.
2. Ingestion and Normalization Layer — converts emails, chats, calendar events, files, and documents into a common internal model.
3. LLM Provider Layer — abstracts local and cloud LLM providers behind a single interface.
4. Retrieval Layer — supports keyword and semantic retrieval across normalized source data, uploaded files, conversations, memories, and digests.
5. Memory and Preference Layer — stores explicit preferences, feedback, interaction history, important people, important projects, and durable personalization signals.
6. Priority Intelligence Layer — scores items by importance, urgency, effort, risk, dependency, and relevance.
7. Assistant Orchestration Layer — allows Donna to answer questions, produce digests, summarize sources, recommend next actions, and explain reasoning in user-readable terms.
8. Permission and Approval Layer — controls what Donna can do automatically and what requires user approval.
9. UX and Settings Layer — gives the user a polished ChatGPT/Claude-style interface and clear control over data, memory, models, and permissions.
10. Audit and Observability Layer — records connector syncs, LLM calls, generated digests, memory updates, approvals, denials, and agent actions.

Use a normalized internal data model for all external information. At minimum, support entities such as User, Workspace, SourceAccount, SourceItem, SourceAttachment, Person, Organization, Project, TaskCandidate, Digest, DigestItem, UserPreference, MemoryEntry, PermissionPolicy, ApprovalRequest, AuditLog, Conversation, Message, UploadedFile, ConnectorRun, LlmProviderConfig, LlmCallLog, RetrievalChunk, EmbeddingRecord, and AgentAction.

Each item must preserve source metadata, timestamps, ownership, permissions, provenance, and retrieval references so Donna can explain where information came from.

# LLM Provider Requirements

Donna must support configurable LLM integration with both local inference servers and cloud models.

Implement an LLM provider abstraction with a clean interface for chat completion, structured generation, summarization, embedding generation if supported, model capability discovery where feasible, streaming responses, timeout handling, retry handling, and usage logging.

Support local inference providers through OpenAI-compatible APIs where possible. Include configuration support for:

- vLLM
- Ollama
- SGLang
- Any OpenAI-compatible local inference endpoint

Support cloud providers through environment-driven configuration. Include adapter structure for:

- Anthropic Claude
- OpenAI
- Google Gemini
- Any OpenAI-compatible cloud endpoint

The LLM provider must be configurable from both environment variables and the Settings page. The user should be able to choose provider type, base URL, model name, API key reference, temperature, max tokens, timeout, and whether the provider is used for chat, summarization, digest generation, embeddings, or classification.

Do not hardcode model names. Provide sensible defaults, but make them editable.

If no cloud or local LLM is configured, Donna should still run in demo mode with mock responses and clear UI warnings. The app should not crash because an API key is missing.

Add a Settings tab called Models or AI Providers where users can configure local or cloud model providers. Include a health-check action that verifies whether Donna can reach the configured model.

Add a routing mechanism so different tasks can use different models. For example, the user may use a local model for summarization, a stronger cloud model for daily debrief generation, and a local embedding model for retrieval. Store this configuration in the database and expose it in Settings.

# Data Source Requirements

Implement a connector abstraction that supports email, chat, calendar, cloud storage, and uploaded files. The connector interface should support connect, disconnect, health check, incremental sync, full sync, item fetch, attachment fetch, permission scopes, capability discovery, and audit logging.

Each connector should have a clear capability model such as read, create, update, delete, send, invite, share, download, upload, list, search, and comment.

For the first implementation, include real adapter structure and at least one working local or mock connector for each source category so the product can be demonstrated without external credentials.

Where practical, implement real connector hooks for common providers behind environment-driven configuration:

- Gmail
- Google Calendar
- Google Drive
- Microsoft Outlook
- Microsoft Teams
- OneDrive
- Slack
- AWS S3

Do not hardcode secrets. All credentials must come from environment variables, secure local secret storage, or cloud secret management.

For uploaded files, implement drag-and-drop upload, file metadata extraction, text extraction for common formats where feasible, source attribution, chunking, indexing, and inclusion in Donna’s search and digest pipeline. Uploaded files should be treated as first-class sources, not as a side feature.

# Ingestion and Normalization Requirements

Create a normalized model that turns all external data into source items with consistent fields: source type, provider, title, body text, sender or creator, recipients or participants, timestamp, due date if any, attachments, links, source URL, thread ID, project signals, people signals, raw metadata, and provenance.

Implement incremental sync support. Connector runs should record started time, completed time, item counts, error counts, status, and logs. Failed syncs should be visible in the UI.

Implement deduplication where practical. For example, the same file or meeting may appear through multiple sources. Do not over-engineer, but include basic dedupe keys and source references.

# Intelligence and Prioritization Requirements

Implement a prioritization engine that determines what is important, urgent, and effort-heavy.

Importance should consider sender, stakeholder seniority, project relevance, explicit user preferences, historical behavior, repeated mentions, business impact, deadlines, escalation signals, whether the item blocks other work, and whether the item relates to a known priority.

Urgency should consider due dates, meeting times, escalation language, unread or recent activity, calendar proximity, explicit time-sensitive wording, stale follow-ups, and dependency deadlines.

Effort should consider estimated work size, number of dependencies, number of people involved, ambiguity, required preparation, document length, task complexity, number of files to review, number of meetings involved, and whether external coordination is required.

The scoring system must be explainable. Every prioritized item must include a short “why this matters” explanation and should show the contributing signals. For example, Donna should be able to say that an item is ranked high because it is from a key stakeholder, relates to an active project, has a deadline tomorrow, and requires preparation before a meeting.

Implement scoring as a modular system with deterministic rules first, then optional LLM-assisted classification. The system should still work when no LLM is configured.

Implement feedback loops. The user should be able to mark an item as important, not important, urgent, not urgent, done, deferred, incorrect, or “more like this.” Donna should use this feedback to update preferences and future scoring.

Store explicit preferences and observed behavior separately. Do not confuse a one-time action with a durable preference.

# Daily Debrief and Digest Requirements

Implement a Daily Debrief feature that produces a clear executive-style summary. The debrief should include:

- Most important items
- Most urgent items
- High-effort tasks
- Upcoming meetings requiring preparation
- Unresolved follow-ups
- Missed or ignored important items
- Documents worth reading
- Risks, blockers, and dependencies
- Suggested plan for the day

The digest must be easy to scan and must not feel like a raw notification dump.

Each digest item must include title, source, timestamp, priority level, urgency level, effort estimate, recommended action, and explanation.

The digest should group items by practical planning categories:

- Do Now
- Prepare Today
- Waiting on Others
- Decide
- Read When Possible
- Follow Up
- Low Priority

Avoid vague labels that look impressive but do not help the user decide what to do.

Add a digest history page so users can review previous debriefs. Add a regenerate action, but preserve previously generated versions for auditability. Add a way for users to manually trigger a digest from the UI.

Support scheduled digest generation through a worker or cron-compatible job. Make the digest schedule configurable in Settings.

# Chat Interface Requirements

Implement Donna as a chat-first assistant similar to ChatGPT or Claude.

The main screen should have a left sidebar for conversations, daily debriefs, settings, connected sources, uploaded files, and digest history. The central panel should be a conversation with Donna. A contextual side panel may show sources, tasks, approvals, or digest details.

The user should be able to ask questions such as:

- “What needs my attention today?”
- “What should I prepare before my next meeting?”
- “Summarize unread emails from important people.”
- “What tasks are blocked?”
- “What did I miss last week?”
- “What requires the most effort this week?”
- “Which items can I safely ignore?”
- “What should I delegate?”

Donna’s responses should be structured, concise, and actionable. The UI should allow Donna to cite sources behind its answers. Source citations should open the underlying normalized item or connector reference where available.

When Donna is uncertain, it should say so and explain what data is missing.

Add contextual actions next to Donna’s recommendations. Examples include mark done, defer, create draft, create task, schedule follow-up, open source, ask why, change priority, ignore similar items, and add preference.

Destructive or externally visible actions must go through the approval model.

# Settings and Permission Model Requirements

Implement a dedicated Settings page with clear tabs. The Settings page must include at least:

- Profile
- Preferences
- Connected Sources
- AI Providers
- Permissions
- Approvals
- Memory
- Digest Schedule
- Security
- Audit Logs
- Deployment

The permission model is critical. Users must be able to tune which agentic capabilities are auto-approved and which require approval.

Implement a capability-based policy model. Safe read-only capabilities such as reading connected data, summarizing, searching, classifying, and generating local recommendations may be auto-approved by default.

Low-risk create capabilities such as creating local draft objects, creating local notes, and creating internal task candidates may be auto-approved if the user enables them.

Externally visible create actions such as sending emails, creating calendar invites, posting chat messages, sharing files, uploading files to cloud storage, or creating cloud resources should require approval by default.

Update and delete actions should require approval by default.

Anything involving permission changes, external communication, destructive changes, financial action, sensitive data exposure, irreversible modification, or broad data sharing must require explicit user approval.

Implement an approval queue. When Donna wants to perform a gated action, it should create an ApprovalRequest with action type, target source, affected object, risk level, reason, preview of the change, and allow/deny controls.

The user should be able to approve once, deny once, always allow similar actions, or change the permission policy.

All approvals and denials must be recorded in the audit log.

Do not bury the permission model in engineering configuration. Make it visible and understandable in the UI. The user should feel in control.

# Memory and Personalization Requirements

Implement a memory system that learns from explicit preferences and repeated interactions.

Store durable preferences such as important people, important projects, normal working hours, preferred digest time, preferred response style, sources to prioritize, sources to ignore, topics to prioritize, topics to ignore, and preferred planning style.

Store behavioral signals such as which recommendations the user accepts, defers, dismisses, corrects, or marks as useful.

Add a Memory page where users can view, edit, delete, export, and disable memory. The user must be able to turn off memory entirely. The user must be able to delete individual memories.

Donna should never pretend memory is magic. It should expose what it believes and let the user correct it.

Separate short-term conversation context from durable memory. Do not permanently store every chat message as a memory. Only store durable information when it is useful for future prioritization or personalization.

# Search and Retrieval Requirements

Implement unified search across normalized source items, uploaded files, conversations, memories, and digests.

Support keyword search and semantic search if embedding infrastructure is available. If no embedding provider is configured, fall back gracefully to keyword and metadata search.

Retrieval should preserve source attribution. Donna must know whether a fact came from an email, calendar event, chat message, uploaded document, memory, or generated digest.

Answers that depend on retrieved data should include citations or source chips in the UI.

# Local and Cloud Deployment Requirements

Donna must support local deployment and cloud deployment.

Local deployment should work with a simple command using Docker Compose or equivalent. It should include the web app, backend API, database, worker, file storage, and any required local services.

Local mode should support local LLM inference through vLLM, Ollama, SGLang, or any OpenAI-compatible endpoint.

Cloud deployment should be environment-driven and suitable for container-based deployment. Cloud mode should support managed database, object storage, external secret management, scalable workers, and cloud LLM providers such as Anthropic, OpenAI, and Gemini.

Provide deployment documentation that explains required environment variables, secrets, database setup, storage setup, connector configuration, LLM provider configuration, and background worker configuration.

Design the system so that local mode can use local file storage and local database configuration. Cloud mode should support managed database, object storage, external secret management, and scalable workers.

The code must not assume a single environment.

# Security, Privacy, and Compliance Requirements

Apply least-privilege access. Each connector should request only the scopes needed for enabled features. Secrets must never be logged. Sensitive content must not be exposed in error messages.

All external actions must go through the permission and approval model.

Add audit logs for connector syncs, source access, uploaded file access, generated digests, memory updates, LLM calls, agent actions, approvals, denials, and destructive operations.

Implement basic redaction for logs. Use secure defaults. Make it easy to run Donna without connecting real accounts by using mock data and uploaded files.

Add clear warnings when enabling external write actions.

# UX Quality Bar

The UI should look modern, calm, and familiar. Use the interaction pattern of ChatGPT and Claude as the main inspiration: left navigation, central chat, clean cards, readable typography, minimal clutter, and clear action buttons.

The Daily Debrief should look like an executive briefing, not like a Jira export fell down the stairs.

The Settings page should be polished and understandable. Permission controls should use plain language. Avoid showing raw capability names unless helpful. For example, show “Allow Donna to summarize emails automatically” instead of only “email.read.summary.autoApprove.”

The AI Provider settings should make local versus cloud model selection obvious. Users should understand whether their data is processed locally or sent to a cloud provider.

# Testing Requirements

Add automated tests for the connector abstraction, normalization pipeline, LLM provider abstraction, local/cloud model configuration, priority scoring, permission gating, approval workflow, memory updates, digest generation, uploaded file ingestion, retrieval, and key UI flows.

Add unit tests for scoring logic and policy decisions. Add integration tests for uploaded file ingestion, mock connector sync, and LLM provider health checks. Add UI tests where the existing project supports them.

Do not leave obvious type errors, lint errors, broken imports, or dead routes. Run the appropriate test, type-check, lint, and build commands.

If some commands cannot run due to missing environment dependencies, document exactly what failed and why.

# Documentation Requirements

Update or create documentation. Include a README with:

- Local setup
- Cloud deployment
- Environment variables
- Connector setup
- LLM provider setup
- Local inference setup for vLLM, Ollama, and SGLang
- Architecture overview
- Permission model
- Memory model
- Daily digest pipeline
- Known limitations

Add a short product walkthrough with sample user flows.

Add a developer guide explaining how to add a new connector and how to add a new LLM provider.

# Definition of Done

The implementation is complete when a user can run Donna locally, configure either a local or cloud LLM provider, open the ChatGPT/Claude-style UI, upload files, view mock or connected source data, generate a daily debrief, ask Donna prioritization questions in chat, inspect why items were prioritized, adjust preferences, manage memory, configure permissions, approve or deny agent actions, review audit logs, and understand whether their model processing is local or cloud-based.

At the end, provide a concise implementation summary. Include what was built, key files changed, how to run locally, how to configure local and cloud LLM providers, how to deploy, what tests were run, and any limitations or follow-up recommendations.

Do not exaggerate. If something is scaffolded rather than fully integrated with a live provider, state that clearly.

Now implement Donna autonomously.