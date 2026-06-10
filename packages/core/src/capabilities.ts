/**
 * Catalog of agentic capabilities Donna can exercise, with plain-language
 * labels, risk levels, and default policy effects. This single catalog drives
 * the policy engine defaults, the Settings UI, and approval previews.
 */
import type { PolicyEffect, RiskLevel } from './enums.js';

export interface CapabilityDef {
  /** Dotted capability id, e.g. `email.send`. */
  id: string;
  /** Plain-language label, e.g. "Send emails on your behalf". */
  label: string;
  description: string;
  group: 'read' | 'analyze' | 'create_local' | 'create_external' | 'modify' | 'destructive';
  risk: RiskLevel;
  defaultEffect: PolicyEffect;
  /** Whether the action is visible outside Donna (other people can see it). */
  externallyVisible: boolean;
}

export const CAPABILITY_CATALOG: CapabilityDef[] = [
  // ---- Safe read-only ----
  {
    id: 'source.read',
    label: 'Read connected data',
    description: 'Read emails, chats, calendar events, and files from connected sources.',
    group: 'read',
    risk: 'safe',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'source.summarize',
    label: 'Summarize your data',
    description: 'Summarize emails, documents, threads, and meetings.',
    group: 'analyze',
    risk: 'safe',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'search.query',
    label: 'Search your data',
    description: 'Run keyword and semantic searches across connected and uploaded data.',
    group: 'read',
    risk: 'safe',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'item.classify',
    label: 'Prioritize and classify items',
    description: 'Score importance, urgency, and effort, and categorize items.',
    group: 'analyze',
    risk: 'safe',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'recommendation.generate',
    label: 'Generate recommendations',
    description: 'Produce digests, plans, and next-step recommendations.',
    group: 'analyze',
    risk: 'safe',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  // ---- Low-risk local create ----
  {
    id: 'task.create',
    label: 'Create internal tasks',
    description: 'Create task candidates inside Donna (never visible outside).',
    group: 'create_local',
    risk: 'low',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'note.create',
    label: 'Create internal notes',
    description: 'Create local notes attached to items or projects.',
    group: 'create_local',
    risk: 'low',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'draft.create',
    label: 'Draft replies locally',
    description: 'Write draft emails/messages inside Donna for your review. Nothing is sent.',
    group: 'create_local',
    risk: 'low',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'memory.write',
    label: 'Save memories',
    description: 'Save durable preferences and facts Donna learns about you.',
    group: 'create_local',
    risk: 'low',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'preference.update',
    label: 'Update preferences from feedback',
    description: 'Adjust prioritization preferences based on your feedback.',
    group: 'create_local',
    risk: 'low',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  // ---- Externally visible create (require approval by default) ----
  {
    id: 'email.send',
    label: 'Send emails',
    description: 'Send an email from your connected account. Recipients will see it.',
    group: 'create_external',
    risk: 'high',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'email.reply',
    label: 'Reply to emails',
    description: 'Send a reply in an existing thread from your account.',
    group: 'create_external',
    risk: 'high',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'calendar.create_invite',
    label: 'Create calendar invites',
    description: 'Create events and send invites to attendees.',
    group: 'create_external',
    risk: 'high',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'chat.post',
    label: 'Post chat messages',
    description: 'Post messages to Slack/Teams channels or DMs as you.',
    group: 'create_external',
    risk: 'high',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'file.share',
    label: 'Share files',
    description: 'Change sharing/permissions on files in cloud storage.',
    group: 'create_external',
    risk: 'high',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'file.upload_external',
    label: 'Upload files to cloud storage',
    description: 'Upload files to connected cloud storage (Drive, OneDrive, S3).',
    group: 'create_external',
    risk: 'medium',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  // ---- Update / delete (require approval by default) ----
  {
    id: 'calendar.update',
    label: 'Modify calendar events',
    description: 'Reschedule, update, or respond to calendar events.',
    group: 'modify',
    risk: 'medium',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'email.modify',
    label: 'Modify emails',
    description: 'Archive, label, or mark emails read/unread in your mailbox.',
    group: 'modify',
    risk: 'medium',
    defaultEffect: 'require_approval',
    externallyVisible: false,
  },
  {
    id: 'source.delete',
    label: 'Delete items in connected sources',
    description: 'Delete emails, events, messages, or files in connected accounts.',
    group: 'destructive',
    risk: 'critical',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
  {
    id: 'permission.change',
    label: 'Change permissions or sharing',
    description: 'Modify access controls anywhere. Always requires your approval.',
    group: 'destructive',
    risk: 'critical',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
];

export const CAPABILITY_MAP: ReadonlyMap<string, CapabilityDef> = new Map(
  CAPABILITY_CATALOG.map((c) => [c.id, c]),
);

export function getCapabilityDef(id: string): CapabilityDef | undefined {
  return CAPABILITY_MAP.get(id);
}
