/**
 * Jarvis's demo world. A coherent, narrative mock dataset used by the mock
 * connectors so the entire product works — and demos well — with zero external
 * credentials.
 *
 * Narrative: the user is Alex Chen, VP Product at Meridian Labs.
 *  - "Atlas Launch" is 6 days out and high stakes.
 *  - The Q3 budget needs a decision from Alex by Friday.
 *  - The vendor migration is blocked on a security review.
 *  - A key customer (Daniel Reyes, Northwind) sent an important email 3 days
 *    ago that got buried.
 *  - Legal needs contract redlines signed off by tomorrow.
 *
 * Everything is generated RELATIVE to the `now` passed in, so demos always
 * look fresh. The function is pure: same `now` in, identical dataset out.
 */
import type { PersonImportance, PersonRef, RawSourceItem } from '@jarvis/core';

export interface DemoPerson {
  name: string;
  emails: string[];
  importance: PersonImportance;
  title: string;
  /** Chat handle, for chat-sourced items. */
  handle?: string;
  /** True for the demo user themself (Alex Chen). */
  isSelf?: boolean;
}

export interface DemoProject {
  name: string;
  description: string;
  keywords: string[];
  priority: 'high' | 'normal' | 'low';
  /** Days from `now` until the project due date (null = no deadline). */
  dueAtOffsetDays: number | null;
}

export interface DemoDataset {
  emails: RawSourceItem[];
  chatMessages: RawSourceItem[];
  calendarEvents: RawSourceItem[];
  storageFiles: RawSourceItem[];
  /**
   * Items that "arrive" right around `now` — served by the mock connectors on
   * the first incremental sync after a full sync, to demonstrate incremental
   * cursor semantics.
   */
  incremental: {
    email: RawSourceItem[];
    chat: RawSourceItem[];
    calendar: RawSourceItem[];
    storage: RawSourceItem[];
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const DEMO_SELF: DemoPerson = {
  name: 'Alex Chen',
  emails: ['alex.chen@meridianlabs.com'],
  importance: 'normal',
  title: 'VP Product, Meridian Labs',
  handle: 'alex',
  isSelf: true,
};

const SARAH: DemoPerson = {
  name: 'Sarah Okafor',
  emails: ['sarah.okafor@meridianlabs.com'],
  importance: 'vip',
  title: 'CEO, Meridian Labs',
  handle: 'sarah',
};

const DANIEL: DemoPerson = {
  name: 'Daniel Reyes',
  emails: ['daniel.reyes@northwind.io'],
  importance: 'vip',
  title: 'VP Engineering, Northwind (key customer)',
  handle: 'daniel.reyes',
};

const PRIYA: DemoPerson = {
  name: 'Priya Sharma',
  emails: ['priya.sharma@meridianlabs.com'],
  importance: 'high',
  title: 'Director of Engineering, Meridian Labs',
  handle: 'priya',
};

const TOM: DemoPerson = {
  name: 'Tom Müller',
  emails: ['tom.muller@meridianlabs.com'],
  importance: 'high',
  title: 'Engineering Manager, Infrastructure',
  handle: 'tom',
};

const JIN: DemoPerson = {
  name: 'Jin Park',
  emails: ['jin.park@meridianlabs.com'],
  importance: 'high',
  title: 'General Counsel, Meridian Labs',
  handle: 'jin',
};

const MAYA: DemoPerson = {
  name: 'Maya Lindqvist',
  emails: ['maya.lindqvist@meridianlabs.com'],
  importance: 'high',
  title: 'CFO, Meridian Labs',
  handle: 'maya',
};

const ELENA: DemoPerson = {
  name: 'Elena Vasquez',
  emails: ['elena.vasquez@cloudpier.com'],
  importance: 'normal',
  title: 'Account Manager, CloudPier (vendor)',
  handle: 'elena.vasquez',
};

const PRODUCT_WEEKLY: DemoPerson = {
  name: 'Product Weekly',
  emails: ['newsletter@productweekly.io'],
  importance: 'low',
  title: 'Newsletter',
};

const GITHUB: DemoPerson = {
  name: 'GitHub Notifications',
  emails: ['notifications@github.com'],
  importance: 'low',
  title: 'Automated notifications',
};

const LINKEDIN: DemoPerson = {
  name: 'LinkedIn',
  emails: ['messages-noreply@linkedin.com'],
  importance: 'ignore',
  title: 'Automated notifications',
};

const TECHBRIEF: DemoPerson = {
  name: 'TechBrief Daily',
  emails: ['digest@techbrief.news'],
  importance: 'low',
  title: 'Newsletter',
};

const FIGMA: DemoPerson = {
  name: 'Figma',
  emails: ['noreply@figma.com'],
  importance: 'ignore',
  title: 'Automated notifications',
};

/** Everyone in the demo world, including Alex (isSelf) and noise senders. */
export const DEMO_PEOPLE: DemoPerson[] = [
  DEMO_SELF,
  SARAH,
  DANIEL,
  PRIYA,
  TOM,
  JIN,
  MAYA,
  ELENA,
  PRODUCT_WEEKLY,
  GITHUB,
  LINKEDIN,
  TECHBRIEF,
  FIGMA,
];

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const DEMO_PROJECTS: DemoProject[] = [
  {
    name: 'Atlas Launch',
    description:
      'GA launch of the Atlas platform. Highest-stakes initiative this quarter; Northwind is the anchor customer for the rollout.',
    keywords: ['atlas', 'launch', 'readiness', 'go/no-go', 'rollout', 'ga'],
    priority: 'high',
    dueAtOffsetDays: 6,
  },
  {
    name: 'Q3 Budget',
    description:
      'Q3 budget allocation. Decision needed from Alex between growth and efficiency scenarios before the board pre-read goes out Friday.',
    keywords: ['budget', 'q3', 'headcount', 'forecast', 'scenario', 'board'],
    priority: 'high',
    dueAtOffsetDays: 4,
  },
  {
    name: 'Vendor Migration',
    description:
      'Migration from legacy hosting to CloudPier. Currently blocked: cutover cannot start until the CloudPier security review completes.',
    keywords: ['vendor', 'migration', 'cloudpier', 'cutover', 'security review'],
    priority: 'normal',
    dueAtOffsetDays: 14,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function ref(p: DemoPerson): PersonRef {
  const personRef: PersonRef = { name: p.name };
  const email = p.emails[0];
  if (email !== undefined) personRef.email = email;
  if (p.handle !== undefined) personRef.handle = p.handle;
  return personRef;
}

/** Demo channels (threadExternalId for chat messages). */
export const DEMO_CHANNELS = [
  { id: 'demo-channel-atlas', name: 'atlas-launch' },
  { id: 'demo-channel-leadership', name: 'leadership' },
  { id: 'demo-channel-vendor-migration', name: 'vendor-migration' },
] as const;

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export function createDemoDataset(now: Date): DemoDataset {
  const nowMs = now.getTime();
  const ago = (ms: number): string => new Date(nowMs - ms).toISOString();
  /** Local wall-clock time at `dayOffset` days from now (e.g. today 14:00). */
  const at = (dayOffset: number, hour: number, minute = 0): string => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };

  // -------------------------------------------------------------------------
  // Emails (~20)
  // -------------------------------------------------------------------------
  const emails: RawSourceItem[] = [
    // BEAT: urgent contract from legal, due tomorrow, with attachment.
    {
      externalId: 'demo-email-001',
      category: 'email',
      title: 'Northwind MSA — redlines need your sign-off by tomorrow EOD',
      bodyText: [
        'Alex,',
        '',
        "Northwind's counsel came back on the MSA this morning and they accepted most of our positions, but there are three open redlines I cannot close without you: the liability cap (they want 2x annual fees, we proposed 1x), the SLA service-credit schedule, and the data-residency addendum for their EU subsidiary.",
        '',
        'I have attached v4 with their changes tracked and my comments inline on each open item. My recommendation: concede on the service credits (cost exposure is small and modeled), hold at 1.5x on the liability cap as a compromise, and accept the residency addendum as written since it mirrors what we already do for Helios.',
        '',
        'Their counsel needs our consolidated response by tomorrow end of day or signature slips past the Atlas launch date, which Daniel explicitly does not want. Can you review my comments and confirm the positions today or first thing tomorrow?',
        '',
        'Thanks,',
        'Jin',
      ].join('\n'),
      sender: ref(JIN),
      participants: [ref(DEMO_SELF), ref(JIN)],
      timestamp: ago(2 * HOUR),
      dueAt: at(1, 17, 0),
      threadExternalId: 'demo-thread-msa',
      labels: ['inbox', 'legal', 'urgent'],
      attachments: [
        {
          filename: 'Northwind-MSA-v4-redline.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 482_133,
          externalRef: 'demo-attachment-msa-v4',
        },
      ],
      isRead: false,
    },
    // BEAT: CEO asks for a decision on Q3 budget by Friday.
    {
      externalId: 'demo-email-002',
      category: 'email',
      title: 'Q3 budget: I need your call by Friday',
      bodyText: [
        'Alex,',
        '',
        "Maya's two scenarios are both workable, which means this is now a product strategy decision, not a finance one. Scenario A funds the two additional Atlas platform squads and pushes the margin target out a quarter. Scenario B holds margin and delays the self-serve tier until Q1.",
        '',
        'I want your recommendation, with reasoning, by Friday — the board pre-read goes out that evening and I am not sending it with an open question on the biggest line item. If you want to talk it through, grab 30 minutes on my calendar Thursday.',
        '',
        'For what it is worth, I lean A, but you own the roadmap consequences either way. Decide.',
        '',
        'Sarah',
      ].join('\n'),
      sender: ref(SARAH),
      participants: [ref(DEMO_SELF), ref(SARAH), ref(MAYA)],
      timestamp: ago(1 * DAY + 3 * HOUR),
      dueAt: at(4, 17, 0),
      threadExternalId: 'demo-thread-q3-budget',
      labels: ['inbox', 'budget'],
      isRead: false,
    },
    // BEAT: important unread email from key customer, 3 days ago, buried.
    {
      externalId: 'demo-email-003',
      category: 'email',
      title: 'Re: Atlas rollout timeline for Northwind — concerns from our side',
      bodyText: [
        'Alex,',
        '',
        'I want to flag something before it becomes a problem. My platform team ran the Atlas beta against our staging workloads last week, and ingest latency at our peak volume is roughly 40% above the numbers your team quoted in the April review. If that holds in production, we cannot move our primary pipeline over in the first wave.',
        '',
        'We are still committed to the launch partnership — our exec sponsor has already socialized it internally — but I need two things from you: a realistic read on whether the latency gap closes before GA, and a fallback rollout plan where we phase the pipeline migration over four weeks instead of one.',
        '',
        'I would rather solve this quietly with you this week than raise it formally at the QBR. Can you get me 30 minutes with whoever owns ingest performance?',
        '',
        'Daniel',
      ].join('\n'),
      sender: ref(DANIEL),
      participants: [ref(DEMO_SELF), ref(DANIEL)],
      timestamp: ago(3 * DAY + 2 * HOUR),
      threadExternalId: 'demo-thread-northwind-rollout',
      labels: ['inbox', 'customer'],
      isRead: false,
    },
    // BEAT: stale follow-up — Alex asked Priya a question 5 days ago, no reply.
    {
      externalId: 'demo-email-004',
      category: 'email',
      title: 'API rate-limit capacity plan for Atlas GA?',
      bodyText: [
        'Priya,',
        '',
        'Before I lock the launch-week comms, I need your read on capacity: if Northwind and the other wave-one customers all onboard in the same week, do we have headroom on the API gateway, or do we need to raise the per-tenant rate limits and add a node to the ingest pool?',
        '',
        'Specifically: (1) what is our projected peak RPS in launch week, (2) what is the current ceiling, and (3) if we need hardware, what is the lead time? I would rather over-provision for two weeks than throttle a flagship customer on day one.',
        '',
        'No need for a doc — bullet points by Wednesday is fine.',
        '',
        'Alex',
      ].join('\n'),
      sender: ref(DEMO_SELF),
      participants: [ref(DEMO_SELF), ref(PRIYA)],
      timestamp: ago(5 * DAY + 1 * HOUR),
      threadExternalId: 'demo-thread-capacity',
      labels: ['sent'],
      isRead: true,
    },
    // BEAT: blocked vendor migration — Tom blocked on security review.
    {
      externalId: 'demo-email-005',
      category: 'email',
      title: 'Vendor migration status: blocked on CloudPier security review',
      bodyText: [
        'Alex,',
        '',
        'Weekly status on the migration, and the headline is not great: we are fully blocked. The cutover runbook is done, the data sync tooling is tested, and my team is ready — but CloudPier still has not returned the completed security review questionnaire, and per our own policy we cannot move production data until it clears.',
        '',
        'I escalated to Elena twice this week. She says their security team is "two to three days out", but she said the same thing last Tuesday. Every day this slips compresses the cutover window against the Atlas launch freeze, and if we lose another week we will have to choose between delaying the migration a full month or running the cutover during launch week, which I strongly do not recommend.',
        '',
        'Ask: a nudge from you to their account exec, or approval to bring in our own auditor and bill it against the contract. Either unblocks us.',
        '',
        'Tom',
      ].join('\n'),
      sender: ref(TOM),
      participants: [ref(DEMO_SELF), ref(TOM), ref(PRIYA)],
      timestamp: ago(1 * DAY + 6 * HOUR),
      threadExternalId: 'demo-thread-vendor-migration',
      labels: ['inbox', 'vendor'],
      isRead: true,
    },
    {
      externalId: 'demo-email-006',
      category: 'email',
      title: 'Atlas launch readiness: open items before the 14:00 review',
      bodyText: [
        'Alex,',
        '',
        "Ahead of this afternoon's readiness review, here is where we stand. Green: core platform, billing integration, docs, and the migration tooling. Yellow: ingest performance under Northwind-scale load (we have a fix candidate in review) and the on-call rotation for launch week, which still has two unstaffed slots.",
        '',
        'Red: nothing, as of this morning. But I want to walk through the ingest fix in detail at 14:00 because if it does not land by Thursday we need to talk about flagging it to Northwind proactively.',
        '',
        'The deck is in the shared drive (Atlas-Launch-Readiness-Review.pptx). Please skim the risk register on slides 7–9 before the meeting — that is where I need your decisions.',
        '',
        'Priya',
      ].join('\n'),
      sender: ref(PRIYA),
      participants: [ref(DEMO_SELF), ref(PRIYA), ref(TOM)],
      timestamp: ago(4 * HOUR),
      threadExternalId: 'demo-thread-atlas-readiness',
      labels: ['inbox', 'atlas'],
      isRead: false,
    },
    // BEAT companion: pointer to the long strategy doc (read when possible).
    {
      externalId: 'demo-email-007',
      category: 'email',
      title: '2026 platform strategy draft — read when you can',
      bodyText: [
        'Alex,',
        '',
        'I finished the first full draft of the 2026 platform strategy. No action needed and no deadline — but when you have a quiet hour, I would value your markup before I share it with the wider exec team next month.',
        '',
        'It is long (about 14 pages). The sections I most want your eyes on are the build-vs-partner analysis for the data plane and the pricing architecture for the self-serve tier, since both have roadmap consequences you will feel before anyone else does.',
        '',
        'It is in the shared drive as 2026-Platform-Strategy-Draft.docx. Comments in the doc are fine.',
        '',
        'Sarah',
      ].join('\n'),
      sender: ref(SARAH),
      participants: [ref(DEMO_SELF), ref(SARAH)],
      timestamp: ago(2 * DAY + 5 * HOUR),
      threadExternalId: 'demo-thread-strategy',
      labels: ['inbox'],
      isRead: true,
    },
    {
      externalId: 'demo-email-008',
      category: 'email',
      title: 'Migration cutover window — please confirm dates',
      bodyText: [
        'Hi Alex,',
        '',
        'I wanted to confirm the proposed cutover window for the migration: we have provisionally reserved our migration engineers for the week after next. To hold that slot I need written confirmation from your side by the end of this week.',
        '',
        'I know Tom has raised the security review timing — our security team has committed to returning the completed questionnaire shortly, and I am pushing to accelerate it. I do not want the review to cost you the reserved window.',
        '',
        'Best regards,',
        'Elena Vasquez',
        'CloudPier',
      ].join('\n'),
      sender: ref(ELENA),
      participants: [ref(DEMO_SELF), ref(ELENA), ref(TOM)],
      timestamp: ago(2 * DAY + 1 * HOUR),
      threadExternalId: 'demo-thread-vendor-migration',
      labels: ['inbox', 'vendor'],
      isRead: true,
    },
    {
      externalId: 'demo-email-009',
      category: 'email',
      title: 'Q3 budget scenarios — model attached',
      bodyText: [
        'Alex,',
        '',
        'As discussed in exec staff, attached is the final model with both Q3 scenarios. Scenario A: +2 platform squads, opex up 8.5%, margin target moves to Q4. Scenario B: flat headcount, margin holds, self-serve tier slips to Q1.',
        '',
        'The sensitivity tab is worth your time — the break-even on Scenario A assumes Atlas expansion revenue lands within 15% of the sales forecast, which historically has been optimistic. If you discount the forecast by 25%, A and B converge in Q1 anyway.',
        '',
        'Sarah wants a recommendation from you by Friday for the board pre-read. Happy to walk through the model whenever.',
        '',
        'Maya',
      ].join('\n'),
      sender: ref(MAYA),
      participants: [ref(DEMO_SELF), ref(MAYA), ref(SARAH)],
      timestamp: ago(2 * DAY + 7 * HOUR),
      dueAt: at(4, 17, 0),
      threadExternalId: 'demo-thread-q3-budget',
      labels: ['inbox', 'budget'],
      attachments: [
        {
          filename: 'Q3-Budget-Scenarios.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sizeBytes: 88_412,
          externalRef: 'demo-attachment-budget-model',
        },
      ],
      isRead: true,
    },
    {
      externalId: 'demo-email-010',
      category: 'email',
      title: 'Re: Atlas launch readiness: dry run scheduled',
      bodyText: [
        'Team,',
        '',
        'Quick update on launch logistics: the full dry run of the cutover-and-announce sequence is scheduled for Thursday morning. Tom owns infra steps, I own the product checklist, and marketing has the comms timeline.',
        '',
        'Alex — the only thing I need from you before Thursday is sign-off on the rollback criteria (slide 9 of the readiness deck). If we agree on those, the go/no-go on launch day becomes mechanical instead of a debate.',
        '',
        'Priya',
      ].join('\n'),
      sender: ref(PRIYA),
      participants: [ref(DEMO_SELF), ref(PRIYA), ref(TOM)],
      timestamp: ago(1 * DAY + 1 * HOUR),
      threadExternalId: 'demo-thread-atlas-readiness',
      labels: ['inbox', 'atlas'],
      isRead: true,
    },
    {
      externalId: 'demo-email-011',
      category: 'email',
      title: 'Northwind MSA — first pass at their redlines',
      bodyText: [
        'Alex,',
        '',
        'Heads-up that Northwind legal sent their first redline pass on the MSA. Most of it is standard, but they are pushing on the liability cap and service credits. I will consolidate and come back to you with the open items once I have been through the whole document.',
        '',
        'No action needed from you yet — this is just so the deadline does not surprise you. Their counsel wants to close before the launch date.',
        '',
        'Jin',
      ].join('\n'),
      sender: ref(JIN),
      participants: [ref(DEMO_SELF), ref(JIN)],
      timestamp: ago(3 * DAY + 6 * HOUR),
      threadExternalId: 'demo-thread-msa',
      labels: ['inbox', 'legal'],
      isRead: true,
    },
    {
      externalId: 'demo-email-012',
      category: 'email',
      title: 'Atlas beta feedback from our platform team',
      bodyText: [
        'Alex,',
        '',
        'Sharing the consolidated feedback from our beta group, as promised. Overall sentiment is positive — the API ergonomics and the migration tooling got specific praise. The full write-up is attached as a PDF.',
        '',
        'Two themes to watch: ingest latency at high volume (my team is still quantifying this, more soon) and the audit-log export format, which our compliance team found awkward. Neither is launch-blocking from our side as of today.',
        '',
        'Daniel',
      ].join('\n'),
      sender: ref(DANIEL),
      participants: [ref(DEMO_SELF), ref(DANIEL)],
      timestamp: ago(6 * DAY + 4 * HOUR),
      threadExternalId: 'demo-thread-northwind-rollout',
      labels: ['inbox', 'customer'],
      attachments: [
        {
          filename: 'Northwind-Atlas-Beta-Feedback.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 214_887,
          externalRef: 'demo-attachment-beta-feedback',
        },
      ],
      isRead: true,
    },
    {
      externalId: 'demo-email-013',
      category: 'email',
      title: 'Board deck feedback — looks good, two tweaks',
      bodyText: [
        'Alex,',
        '',
        'Reviewed your product section for the board deck. It is in good shape. Two tweaks: lead with the Northwind partnership rather than the feature list, and move the competitive slide to the appendix — we want the conversation on momentum, not on the competition.',
        '',
        'Send the revised slides to my EA by Wednesday and you are done.',
        '',
        'Sarah',
      ].join('\n'),
      sender: ref(SARAH),
      participants: [ref(DEMO_SELF), ref(SARAH)],
      timestamp: ago(4 * DAY + 2 * HOUR),
      threadExternalId: 'demo-thread-board-deck',
      labels: ['inbox'],
      isRead: true,
    },
    {
      externalId: 'demo-email-014',
      category: 'email',
      title: 'CloudPier contract renewal — updated pricing',
      bodyText: [
        'Hi Alex,',
        '',
        'Ahead of the renewal conversation next month, here is the updated pricing for the expanded footprint after the migration. The committed-use discount improves at the next tier, which you would reach based on the projected workload.',
        '',
        'No urgency on this — I know the migration is the priority. I will put time on your calendar after the cutover completes.',
        '',
        'Best,',
        'Elena',
      ].join('\n'),
      sender: ref(ELENA),
      participants: [ref(DEMO_SELF), ref(ELENA)],
      timestamp: ago(5 * DAY + 3 * HOUR),
      threadExternalId: 'demo-thread-cloudpier-renewal',
      labels: ['inbox', 'vendor'],
      isRead: true,
    },
    {
      externalId: 'demo-email-015',
      category: 'email',
      title: 'On-call coverage for launch week — two slots still open',
      bodyText: [
        'Alex,',
        '',
        'FYI from the infra side: the launch-week on-call rotation still has two unstaffed overnight slots. I have asked for volunteers and will pay back the time, but if nobody bites by Thursday I will need either your or Priya\'s call on making it mandatory for the platform team.',
        '',
        'Not urgent today, but it becomes urgent at the readiness review.',
        '',
        'Tom',
      ].join('\n'),
      sender: ref(TOM),
      participants: [ref(DEMO_SELF), ref(TOM), ref(PRIYA)],
      timestamp: ago(22 * HOUR),
      threadExternalId: 'demo-thread-oncall',
      labels: ['inbox', 'atlas'],
      isRead: true,
    },
    // BEAT: newsletters / notification noise (low priority).
    {
      externalId: 'demo-email-016',
      category: 'email',
      title: 'Product Weekly #214: pricing pages that convert, platform moats, and more',
      bodyText: [
        'This week in Product Weekly:',
        '',
        '1. Teardown: six pricing pages that convert, and the one pattern they share.',
        '2. Essay: why platform moats are usually distribution moats wearing a costume.',
        '3. Interview: a CPO on killing a flagship feature and living to tell the tale.',
        '',
        'Plus jobs, tools, and the usual link dump. Read online or unsubscribe below.',
      ].join('\n'),
      sender: ref(PRODUCT_WEEKLY),
      participants: [ref(DEMO_SELF)],
      timestamp: ago(1 * DAY + 9 * HOUR),
      labels: ['inbox', 'newsletter'],
      isRead: false,
    },
    {
      externalId: 'demo-email-017',
      category: 'email',
      title: '[meridian/atlas] 14 new commits pushed to release/atlas-ga',
      bodyText: [
        'Branch: release/atlas-ga',
        '',
        '14 new commits were pushed by priya-sharma and 3 others. Highlights: ingest batching fix (#2841), rate-limit config surface (#2845), docs for migration CLI (#2850).',
        '',
        'View the full comparison on GitHub. You are receiving this because you are watching this repository.',
      ].join('\n'),
      sender: ref(GITHUB),
      participants: [ref(DEMO_SELF)],
      timestamp: ago(7 * HOUR),
      labels: ['inbox', 'notification'],
      isRead: false,
    },
    {
      externalId: 'demo-email-018',
      category: 'email',
      title: 'You have 12 new notifications and 3 connection requests',
      bodyText: [
        'Alex, people are noticing you.',
        '',
        'You appeared in 9 searches this week. Three people sent you connection requests, and your post about platform pricing reached 4,200 impressions.',
        '',
        'See your notifications on LinkedIn.',
      ].join('\n'),
      sender: ref(LINKEDIN),
      participants: [ref(DEMO_SELF)],
      timestamp: ago(2 * DAY + 11 * HOUR),
      labels: ['inbox', 'notification'],
      isRead: false,
    },
    {
      externalId: 'demo-email-019',
      category: 'email',
      title: 'TechBrief Daily: infra spending rebounds, AI agents eat the SDLC',
      bodyText: [
        'Good morning. Here is what matters in tech today.',
        '',
        'INFRA: Cloud infrastructure spending grew 19% year over year, led by AI workloads. The interesting subplot: committed-use discounts are getting more aggressive as providers fight for multi-year lock-in.',
        '',
        'TOOLS: A new crop of agentic dev tools claims to automate half the SDLC. The demos are impressive; the postmortems will be educational.',
        '',
        'Read the full brief online.',
      ].join('\n'),
      sender: ref(TECHBRIEF),
      participants: [ref(DEMO_SELF)],
      timestamp: ago(10 * HOUR),
      labels: ['inbox', 'newsletter'],
      isRead: false,
    },
    {
      externalId: 'demo-email-020',
      category: 'email',
      title: 'Priya Sharma mentioned you in "Atlas GA — launch comms"',
      bodyText: [
        'Priya Sharma (@priya) mentioned you in a comment:',
        '',
        '"@alex can you confirm the customer-facing name for the migration tool? Marketing has it as \'Atlas Mover\' but the docs say \'Atlas Migrate\'."',
        '',
        'Open in Figma to reply.',
      ].join('\n'),
      sender: ref(FIGMA),
      participants: [ref(DEMO_SELF)],
      timestamp: ago(1 * DAY + 2 * HOUR),
      labels: ['inbox', 'notification'],
      isRead: false,
    },
  ];

  // -------------------------------------------------------------------------
  // Chat messages (~12 across 3 channels)
  // -------------------------------------------------------------------------
  const chatMessages: RawSourceItem[] = [
    // BEAT: escalation with ASAP language.
    {
      externalId: 'demo-chat-001',
      category: 'chat',
      title: '#atlas-launch: staging cert expires tonight — need a call ASAP',
      bodyText:
        '@alex heads up — the TLS cert on the staging cluster expires tonight and the renewal is stuck on an approval only you or Sarah can give in the vendor portal. If it lapses, tomorrow\'s launch dry run slips a day. Need a decision ASAP — it is a 5-minute approval.',
      sender: ref(PRIYA),
      participants: [ref(PRIYA), ref(DEMO_SELF), ref(TOM)],
      timestamp: ago(35 * MINUTE),
      threadExternalId: 'demo-channel-atlas',
      labels: ['mention'],
      isRead: false,
    },
    {
      externalId: 'demo-chat-002',
      category: 'chat',
      title: '#atlas-launch: ingest fix candidate is in review',
      bodyText:
        'Ingest batching fix (#2841) is in review. Early numbers from the load rig: p99 latency down 31% at Northwind-scale volume. If it holds in the soak test we can call the latency risk closed at the 14:00 review.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(PRIYA), ref(DEMO_SELF)],
      timestamp: ago(3 * HOUR),
      threadExternalId: 'demo-channel-atlas',
      isRead: true,
    },
    {
      externalId: 'demo-chat-003',
      category: 'chat',
      title: '#atlas-launch: readiness review at 14:00 — deck is up',
      bodyText:
        'Readiness review at 14:00 today. Deck is in the drive (Atlas-Launch-Readiness-Review.pptx). Please read slides 7–9 (risk register) before the meeting so we can spend the time on decisions, not narration.',
      sender: ref(PRIYA),
      participants: [ref(PRIYA), ref(DEMO_SELF), ref(TOM)],
      timestamp: ago(5 * HOUR),
      threadExternalId: 'demo-channel-atlas',
      isRead: true,
    },
    {
      externalId: 'demo-chat-004',
      category: 'chat',
      title: '#atlas-launch: docs freeze is Thursday',
      bodyText:
        'Reminder: docs freeze for GA is Thursday EOD. Anything not merged by then ships in the day-2 docs update. The migration CLI guide (#2850) is the last big one outstanding.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(PRIYA)],
      timestamp: ago(1 * DAY + 4 * HOUR),
      threadExternalId: 'demo-channel-atlas',
      isRead: true,
    },
    {
      externalId: 'demo-chat-005',
      category: 'chat',
      title: '#atlas-launch: dry run Thursday 09:00',
      bodyText:
        'Launch dry run confirmed for Thursday 09:00. Full sequence: cutover, smoke tests, comms. Block 90 minutes. @alex you only need the first 30 for the go/no-go criteria walkthrough.',
      sender: ref(PRIYA),
      participants: [ref(PRIYA), ref(DEMO_SELF), ref(TOM)],
      timestamp: ago(1 * DAY + 7 * HOUR),
      threadExternalId: 'demo-channel-atlas',
      labels: ['mention'],
      isRead: true,
    },
    // Leadership channel.
    {
      externalId: 'demo-chat-006',
      category: 'chat',
      title: '#leadership: board pre-read goes out Friday evening',
      bodyText:
        'Reminder for everyone with a section in the board pre-read: final inputs by Friday 15:00, the document goes out at 18:00. The only open item I am tracking is the Q3 budget recommendation. @alex that is yours.',
      sender: ref(SARAH),
      participants: [ref(SARAH), ref(DEMO_SELF), ref(MAYA)],
      timestamp: ago(6 * HOUR),
      threadExternalId: 'demo-channel-leadership',
      labels: ['mention'],
      isRead: false,
    },
    {
      externalId: 'demo-chat-007',
      category: 'chat',
      title: '#leadership: sensitivity tab added to the budget model',
      bodyText:
        'I added a sensitivity tab to the Q3 model (Q3-Budget-Scenarios.xlsx, same file). It shows where scenarios A and B converge if the Atlas expansion forecast is discounted. Worth a look before anyone anchors on a position.',
      sender: ref(MAYA),
      participants: [ref(MAYA), ref(SARAH), ref(DEMO_SELF)],
      timestamp: ago(1 * DAY + 5 * HOUR),
      threadExternalId: 'demo-channel-leadership',
      isRead: true,
    },
    {
      externalId: 'demo-chat-008',
      category: 'chat',
      title: '#leadership: Northwind exec sponsor confirmed for launch announcement',
      bodyText:
        'Good news: Northwind confirmed their CTO will do a joint quote for the Atlas launch announcement. Keeps the partnership front and center for the board narrative.',
      sender: ref(SARAH),
      participants: [ref(SARAH), ref(DEMO_SELF)],
      timestamp: ago(2 * DAY + 8 * HOUR),
      threadExternalId: 'demo-channel-leadership',
      isRead: true,
    },
    // Vendor migration channel.
    // BEAT: blocked task — Tom blocked waiting on security review.
    {
      externalId: 'demo-chat-009',
      category: 'chat',
      title: '#vendor-migration: still blocked on the CloudPier security review',
      bodyText:
        'Status: still blocked. CloudPier security review has not come back, and policy says no production data moves until it clears. Runbook and sync tooling are done and tested — the team is literally waiting on one PDF. @alex if you have a lever with their account exec, now is the time to pull it.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(DEMO_SELF), ref(PRIYA)],
      timestamp: ago(4 * HOUR),
      threadExternalId: 'demo-channel-vendor-migration',
      labels: ['mention'],
      isRead: false,
    },
    {
      externalId: 'demo-chat-010',
      category: 'chat',
      title: '#vendor-migration: cutover window math',
      bodyText:
        'Cutover window math, for the record: CloudPier holds our reserved slot through the week after next. If the security review lands within 3 business days we keep the slot. Past that, the next available window collides with the Atlas launch freeze and we are looking at a month-long delay.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(PRIYA)],
      timestamp: ago(1 * DAY + 8 * HOUR),
      threadExternalId: 'demo-channel-vendor-migration',
      isRead: true,
    },
    {
      externalId: 'demo-chat-011',
      category: 'chat',
      title: '#vendor-migration: dry run of data sync completed',
      bodyText:
        'Data sync dry run completed overnight: 1.4TB mirrored, checksums clean, replication lag under 90 seconds at peak. Tooling is ready whenever legal and security let us go.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(PRIYA), ref(DEMO_SELF)],
      timestamp: ago(2 * DAY + 3 * HOUR),
      threadExternalId: 'demo-channel-vendor-migration',
      isRead: true,
    },
    {
      externalId: 'demo-chat-012',
      category: 'chat',
      title: '#vendor-migration: escalated to Elena again',
      bodyText:
        'Escalated to Elena again this morning — she says their security team is "two to three days out" from returning the questionnaire. Same answer as last week. I have asked her to put it in writing this time.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(DEMO_SELF)],
      timestamp: ago(26 * HOUR),
      threadExternalId: 'demo-channel-vendor-migration',
      isRead: true,
    },
  ];

  // -------------------------------------------------------------------------
  // Calendar events (~10, yesterday .. +7 days)
  // -------------------------------------------------------------------------
  const calendarEvents: RawSourceItem[] = [
    {
      externalId: 'demo-cal-001',
      category: 'calendar',
      title: '1:1 Alex / Priya',
      bodyText:
        'Weekly 1:1. Standing agenda: Atlas readiness, team health, hiring pipeline. Priya to bring the updated risk register.',
      sender: ref(DEMO_SELF),
      participants: [ref(DEMO_SELF), ref(PRIYA)],
      timestamp: at(-1, 10, 0),
      startsAt: at(-1, 10, 0),
      endsAt: at(-1, 10, 30),
      threadExternalId: 'demo-cal-series-priya-1on1',
      dedupeHint: 'demo-ics-priya-1on1',
      isRead: true,
    },
    {
      externalId: 'demo-cal-002',
      category: 'calendar',
      title: 'Vendor migration weekly sync',
      bodyText:
        'Weekly sync with CloudPier. Agenda: security review status (still outstanding), cutover window confirmation, escalation path if the review slips again.',
      sender: ref(TOM),
      participants: [ref(DEMO_SELF), ref(TOM), ref(ELENA)],
      timestamp: at(-1, 15, 0),
      startsAt: at(-1, 15, 0),
      endsAt: at(-1, 15, 45),
      threadExternalId: 'demo-cal-series-vendor-sync',
      dedupeHint: 'demo-ics-vendor-sync',
      isRead: true,
    },
    // BEAT: meeting today at 14:00, prep needed, deck lives in storage.
    {
      externalId: 'demo-cal-003',
      category: 'calendar',
      title: 'Atlas Launch Readiness Review',
      bodyText: [
        'Final readiness review before the GA go/no-go.',
        '',
        'Prep required: read the deck (Atlas-Launch-Readiness-Review.pptx in the shared drive), especially the risk register on slides 7–9. Alex to come ready to decide on: rollback criteria sign-off, on-call staffing for launch week, and whether to flag the ingest latency item to Northwind proactively.',
        '',
        'Decisions made here feed directly into the Thursday dry run and the go/no-go on launch day.',
      ].join('\n'),
      sender: ref(PRIYA),
      participants: [ref(DEMO_SELF), ref(PRIYA), ref(TOM), ref(SARAH)],
      timestamp: at(0, 14, 0),
      startsAt: at(0, 14, 0),
      endsAt: at(0, 15, 0),
      threadExternalId: 'demo-cal-series-atlas-readiness',
      labels: ['needs-prep'],
      attachments: [
        {
          filename: 'Atlas-Launch-Readiness-Review.pptx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sizeBytes: 4_812_900,
          externalRef: 'demo-file-001',
        },
      ],
      dedupeHint: 'demo-ics-atlas-readiness',
      isRead: false,
    },
    {
      externalId: 'demo-cal-004',
      category: 'calendar',
      title: 'Legal sync: Northwind MSA redlines',
      bodyText:
        'Working session with Jin to close the three open redlines on the Northwind MSA (liability cap, service credits, data residency). Their counsel needs our consolidated response by EOD — this meeting is the last chance to align before it goes out.',
      sender: ref(JIN),
      participants: [ref(DEMO_SELF), ref(JIN)],
      timestamp: at(1, 11, 0),
      startsAt: at(1, 11, 0),
      endsAt: at(1, 11, 45),
      dedupeHint: 'demo-ics-msa-sync',
      isRead: false,
    },
    {
      externalId: 'demo-cal-005',
      category: 'calendar',
      title: 'Customer call: Northwind (Daniel Reyes)',
      bodyText:
        'Monthly check-in with Daniel. Expect the Atlas rollout timeline and the ingest latency findings from their beta testing to come up. Bring the phased-rollout fallback options.',
      sender: ref(DEMO_SELF),
      participants: [ref(DEMO_SELF), ref(DANIEL), ref(PRIYA)],
      timestamp: at(1, 16, 0),
      startsAt: at(1, 16, 0),
      endsAt: at(1, 16, 30),
      dedupeHint: 'demo-ics-northwind-checkin',
      isRead: false,
    },
    {
      externalId: 'demo-cal-006',
      category: 'calendar',
      title: 'Atlas GA dry run (go/no-go criteria walkthrough)',
      bodyText:
        'Full dry run of the launch sequence: cutover, smoke tests, comms. Alex needed for the first 30 minutes (go/no-go and rollback criteria walkthrough); the rest is execution.',
      sender: ref(PRIYA),
      participants: [ref(DEMO_SELF), ref(PRIYA), ref(TOM)],
      timestamp: at(2, 9, 0),
      startsAt: at(2, 9, 0),
      endsAt: at(2, 10, 30),
      labels: ['needs-prep'],
      dedupeHint: 'demo-ics-atlas-dryrun',
      isRead: false,
    },
    {
      externalId: 'demo-cal-007',
      category: 'calendar',
      title: 'Q3 budget decision: Alex / Sarah / Maya',
      bodyText:
        'Decision meeting on the Q3 budget scenarios ahead of the Friday board pre-read. Alex to bring a recommendation (A or B) with reasoning; Maya to have the sensitivity model open.',
      sender: ref(SARAH),
      participants: [ref(DEMO_SELF), ref(SARAH), ref(MAYA)],
      timestamp: at(3, 13, 30),
      startsAt: at(3, 13, 30),
      endsAt: at(3, 14, 15),
      labels: ['needs-prep'],
      dedupeHint: 'demo-ics-q3-decision',
      isRead: false,
    },
    {
      externalId: 'demo-cal-008',
      category: 'calendar',
      title: 'Exec staff meeting',
      bodyText:
        'Weekly exec staff. Standing agenda plus: board pre-read final review, Atlas launch status, vendor migration escalation if still blocked.',
      sender: ref(SARAH),
      participants: [ref(DEMO_SELF), ref(SARAH), ref(MAYA), ref(JIN)],
      timestamp: at(4, 9, 0),
      startsAt: at(4, 9, 0),
      endsAt: at(4, 10, 0),
      threadExternalId: 'demo-cal-series-exec-staff',
      dedupeHint: 'demo-ics-exec-staff',
      isRead: false,
    },
    {
      externalId: 'demo-cal-009',
      category: 'calendar',
      title: 'Atlas Launch: GA go/no-go',
      bodyText:
        'Final go/no-go for the Atlas GA launch. Inputs: readiness review decisions, dry run results, Northwind sign-off, rollback criteria. If go: launch sequence starts at 09:00 the following day.',
      sender: ref(PRIYA),
      participants: [ref(DEMO_SELF), ref(PRIYA), ref(TOM), ref(SARAH)],
      timestamp: at(6, 10, 0),
      startsAt: at(6, 10, 0),
      endsAt: at(6, 11, 0),
      labels: ['needs-prep'],
      dedupeHint: 'demo-ics-atlas-gonogo',
      isRead: false,
    },
    {
      externalId: 'demo-cal-010',
      category: 'calendar',
      title: 'Quarterly product planning offsite',
      bodyText:
        'Full-day product planning offsite. Inputs: 2026 platform strategy draft, Q3 budget decision, Atlas launch retro (if launched). Location: Harbor View conference center.',
      sender: ref(DEMO_SELF),
      participants: [ref(DEMO_SELF), ref(PRIYA), ref(SARAH), ref(MAYA)],
      timestamp: at(7, 9, 0),
      startsAt: at(7, 9, 0),
      endsAt: at(7, 17, 0),
      dedupeHint: 'demo-ics-planning-offsite',
      isRead: false,
    },
  ];

  // -------------------------------------------------------------------------
  // Storage files (~8)
  // -------------------------------------------------------------------------
  const storageFiles: RawSourceItem[] = [
    // BEAT companion: the deck for today's 14:00 readiness review.
    {
      externalId: 'demo-file-001',
      category: 'storage',
      title: 'Atlas-Launch-Readiness-Review.pptx',
      bodyText:
        'Launch readiness deck for the Atlas GA review. Contents: status by workstream (slides 2–6), risk register with owners and mitigations (slides 7–9), rollback criteria proposal (slide 9), launch-week timeline and comms plan (slides 10–12).',
      snippet: 'Readiness deck for the Atlas GA review — risk register on slides 7–9.',
      sender: ref(PRIYA),
      participants: [ref(PRIYA), ref(DEMO_SELF), ref(TOM)],
      timestamp: ago(18 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-001',
      labels: ['shared-drive', 'atlas'],
      raw: { folder: '/Atlas Launch', sizeBytes: 4_812_900 },
      dedupeHint: 'demo-file-hash-readiness-deck-v1',
      isRead: false,
    },
    {
      externalId: 'demo-file-002',
      category: 'storage',
      title: 'Northwind-MSA-v4-redline.docx',
      bodyText:
        'Master services agreement with Northwind, version 4, with opposing counsel redlines tracked. Open items flagged in comments: clause 8.2 liability cap, schedule C service credits, EU data-residency addendum.',
      snippet: 'MSA v4 with Northwind redlines — three open items flagged for Alex.',
      sender: ref(JIN),
      participants: [ref(JIN), ref(DEMO_SELF)],
      timestamp: ago(3 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-002',
      labels: ['shared-drive', 'legal'],
      raw: { folder: '/Legal/Northwind', sizeBytes: 482_133 },
      dedupeHint: 'demo-file-hash-msa-v4',
      isRead: false,
    },
    // BEAT: long strategy doc worth reading, no deadline.
    {
      externalId: 'demo-file-003',
      category: 'storage',
      title: '2026-Platform-Strategy-Draft.docx',
      bodyText: [
        '2026 Platform Strategy — Draft v1 (Sarah Okafor). 14 pages. Executive summary below; full document in the shared drive.',
        '',
        '1. Where we are. Meridian Labs enters 2026 with a working platform business hiding inside a product business. Atlas is the proof: customers do not just buy our features, they build on our primitives. Revenue from API-led usage grew 3x faster than seat revenue this year, and our two largest expansion deals — Northwind included — were platform deals before they were product deals. The strategic question for 2026 is whether we lean into that shift deliberately or let it happen to us at someone else\'s pace.',
        '',
        '2. The data plane decision. The single largest fork in the road is the data plane: build our own streaming ingest and storage layer, or deepen the partnership with infrastructure vendors and stay an orchestration layer. Building buys us margin and control at the cost of 18 months of focused engineering investment and real operational risk. Partnering keeps us fast and capital-light but caps our gross margin in the high sixties and leaves us exposed to vendor pricing power — a risk we are already feeling in the CloudPier renewal. This document recommends a staged build: own the ingest tier in 2026, defer the storage tier decision to mid-year with explicit kill criteria.',
        '',
        '3. Self-serve and pricing architecture. Our sales-led motion is efficient above $50k ACV and wasteful below it. The self-serve tier (deferred from Q3 under budget scenario B) is not a growth experiment; it is the on-ramp that feeds the platform thesis. The pricing architecture proposed here separates platform consumption (usage-based, self-serve) from enterprise controls (seat- and tier-based, sales-led), which lets us serve a developer adopting Atlas on a credit card and a CIO signing a three-year commitment without the two models cannibalizing each other.',
        '',
        '4. Competitive posture. Our most dangerous competitor in 2026 is not the incumbent suite — it is the hyperscaler bundling a good-enough version of our core workflow into their platform at marginal cost. Our defense is not feature velocity; it is depth in the verticals where workflow context matters and the ecosystem of integrations that makes leaving expensive. Concretely: we should be the obvious choice in two verticals by year-end, not a plausible choice in ten.',
        '',
        '5. What we stop doing. Strategy is subtraction. This draft proposes sunsetting the legacy reporting module (single-digit usage, double-digit maintenance share), freezing net-new investment in the on-prem distribution, and folding the labs team into the platform org. Each of these will be unpopular with someone; all three fund the data plane investment without net new headcount.',
        '',
        '6. What I need from reviewers. Pressure-test the build-vs-partner analysis in section 2 — especially the kill criteria — and the pricing architecture in section 3. If you disagree with the verticals chosen in section 4, propose alternatives with evidence, not enthusiasm.',
      ].join('\n'),
      snippet: '2026 platform strategy draft — build-vs-partner, self-serve pricing, 14 pages.',
      sender: ref(SARAH),
      participants: [ref(SARAH), ref(DEMO_SELF)],
      timestamp: ago(2 * DAY + 6 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-003',
      labels: ['shared-drive', 'strategy'],
      raw: { folder: '/Strategy', sizeBytes: 1_204_551, pages: 14 },
      dedupeHint: 'demo-file-hash-strategy-v1',
      isRead: false,
    },
    {
      externalId: 'demo-file-004',
      category: 'storage',
      title: 'Q3-Budget-Scenarios.xlsx',
      bodyText:
        'Q3 budget model with scenarios A (+2 platform squads, margin target moves to Q4) and B (flat headcount, self-serve tier slips to Q1). Includes sensitivity tab showing scenario convergence when the Atlas expansion forecast is discounted by 25%.',
      snippet: 'Q3 budget model — scenarios A and B with sensitivity analysis.',
      sender: ref(MAYA),
      participants: [ref(MAYA), ref(DEMO_SELF), ref(SARAH)],
      timestamp: ago(1 * DAY + 5 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-004',
      labels: ['shared-drive', 'finance'],
      raw: { folder: '/Finance/2026', sizeBytes: 88_412 },
      dedupeHint: 'demo-file-hash-budget-model',
      isRead: true,
    },
    {
      externalId: 'demo-file-005',
      category: 'storage',
      title: 'Vendor-Migration-Runbook.md',
      bodyText:
        'Step-by-step cutover runbook for the CloudPier migration: pre-flight checks, data sync procedure, DNS cutover sequence, validation suite, rollback procedure with decision points. Status: complete and dry-run tested; execution blocked pending CloudPier security review.',
      snippet: 'Cutover runbook — complete and tested, blocked on security review.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(PRIYA)],
      timestamp: ago(3 * DAY + 4 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-005',
      labels: ['shared-drive', 'infrastructure'],
      raw: { folder: '/Infrastructure/Migration', sizeBytes: 41_268 },
      dedupeHint: 'demo-file-hash-runbook-v3',
      isRead: true,
    },
    {
      externalId: 'demo-file-006',
      category: 'storage',
      title: 'Atlas-GTM-Checklist.xlsx',
      bodyText:
        'Go-to-market checklist for the Atlas GA launch: announcement timeline, customer comms sequencing, pricing page updates, sales enablement assets, analyst briefings. Owner column updated; 9 of 31 items still open.',
      snippet: 'Atlas GTM checklist — 9 of 31 items open.',
      sender: ref(PRIYA),
      participants: [ref(PRIYA), ref(DEMO_SELF)],
      timestamp: ago(1 * DAY + 2 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-006',
      labels: ['shared-drive', 'atlas'],
      raw: { folder: '/Atlas Launch', sizeBytes: 64_009 },
      dedupeHint: 'demo-file-hash-gtm-checklist',
      isRead: true,
    },
    {
      externalId: 'demo-file-007',
      category: 'storage',
      title: 'Northwind-QBR-Notes.docx',
      bodyText:
        'Notes from the last Northwind quarterly business review: expansion appetite confirmed, Atlas launch partnership agreed in principle, action items on latency benchmarks and the phased rollout option. Several action items reference commitments now due before GA.',
      snippet: 'Northwind QBR notes — action items due before GA.',
      sender: ref(DEMO_SELF),
      participants: [ref(DEMO_SELF), ref(DANIEL)],
      timestamp: ago(6 * DAY + 2 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-007',
      labels: ['shared-drive', 'customer'],
      raw: { folder: '/Customers/Northwind', sizeBytes: 102_733 },
      dedupeHint: 'demo-file-hash-qbr-notes',
      isRead: true,
    },
    {
      externalId: 'demo-file-008',
      category: 'storage',
      title: 'Security-Review-Questionnaire-CloudPier.pdf',
      bodyText:
        'The outbound security review questionnaire sent to CloudPier: data handling, encryption at rest and in transit, access controls, incident response SLAs, subprocessor list. Sent four days ago; completed response still outstanding — this is the document blocking the migration cutover.',
      snippet: 'Security questionnaire sent to CloudPier — response outstanding, blocking cutover.',
      sender: ref(TOM),
      participants: [ref(TOM), ref(ELENA)],
      timestamp: ago(4 * DAY + 1 * HOUR),
      url: 'https://files.meridianlabs.example/demo-file-008',
      labels: ['shared-drive', 'security'],
      raw: { folder: '/Infrastructure/Migration', sizeBytes: 198_226 },
      dedupeHint: 'demo-file-hash-security-questionnaire',
      isRead: true,
    },
  ];

  // -------------------------------------------------------------------------
  // Incremental arrivals (served on the first incremental sync after a full
  // sync — they "land" right around now).
  // -------------------------------------------------------------------------
  const incremental: DemoDataset['incremental'] = {
    email: [
      {
        externalId: 'demo-email-inc-001',
        category: 'email',
        title: 'Quick one before the readiness review',
        bodyText: [
          'Alex,',
          '',
          'Before the 14:00 readiness review: if the ingest latency item is still yellow, I want us to tell Daniel proactively rather than have him discover it. Customers forgive problems; they do not forgive surprises.',
          '',
          'Your call on the mechanics, but make the call today.',
          '',
          'Sarah',
        ].join('\n'),
        sender: ref(SARAH),
        participants: [ref(DEMO_SELF), ref(SARAH)],
        timestamp: ago(3 * MINUTE),
        threadExternalId: 'demo-thread-atlas-readiness',
        labels: ['inbox'],
        isRead: false,
      },
      {
        externalId: 'demo-email-inc-002',
        category: 'email',
        title: '[meridian/atlas] Soak test passed on release/atlas-ga (#2841)',
        bodyText: [
          'Workflow "soak-test" completed successfully on release/atlas-ga.',
          '',
          'Run summary: 6h soak at 2.5x projected launch volume, p99 ingest latency within target, zero failed checks.',
          '',
          'You are receiving this because you are watching this repository.',
        ].join('\n'),
        sender: ref(GITHUB),
        participants: [ref(DEMO_SELF)],
        timestamp: ago(8 * MINUTE),
        labels: ['inbox', 'notification'],
        isRead: false,
      },
    ],
    chat: [
      {
        externalId: 'demo-chat-inc-001',
        category: 'chat',
        title: '#vendor-migration: CloudPier security review just landed',
        bodyText:
          'Update: CloudPier security review just landed in my inbox — full questionnaire, signed. Security team is validating now. If it is clean we are unblocked and I will confirm the cutover window with Elena by EOD.',
        sender: ref(TOM),
        participants: [ref(TOM), ref(DEMO_SELF), ref(PRIYA)],
        timestamp: ago(2 * MINUTE),
        threadExternalId: 'demo-channel-vendor-migration',
        isRead: false,
      },
    ],
    calendar: [
      {
        externalId: 'demo-cal-inc-001',
        category: 'calendar',
        title: 'Northwind latency sync (Daniel + ingest team)',
        bodyText:
          'Newly scheduled: 30 minutes with Daniel and the ingest owners to walk through the latency findings and the soak test results, per his email. Goal: leave with an agreed rollout plan (single wave vs phased).',
        sender: ref(DEMO_SELF),
        participants: [ref(DEMO_SELF), ref(DANIEL), ref(PRIYA), ref(TOM)],
        timestamp: at(2, 15, 0),
        startsAt: at(2, 15, 0),
        endsAt: at(2, 15, 30),
        dedupeHint: 'demo-ics-northwind-latency-sync',
        isRead: false,
      },
    ],
    storage: [
      {
        externalId: 'demo-file-inc-001',
        category: 'storage',
        title: 'Atlas-Launch-Readiness-Review-v2.pptx',
        bodyText:
          'Updated readiness deck (v2): soak test results added to slide 6, ingest latency risk moved from yellow to green pending final validation, rollback criteria reworded per legal feedback.',
        snippet: 'Readiness deck v2 — soak results in, latency risk trending green.',
        sender: ref(PRIYA),
        participants: [ref(PRIYA), ref(DEMO_SELF)],
        timestamp: ago(5 * MINUTE),
        url: 'https://files.meridianlabs.example/demo-file-inc-001',
        labels: ['shared-drive', 'atlas'],
        raw: { folder: '/Atlas Launch', sizeBytes: 4_955_104 },
        dedupeHint: 'demo-file-hash-readiness-deck-v2',
        isRead: false,
      },
    ],
  };

  return { emails, chatMessages, calendarEvents, storageFiles, incremental };
}
