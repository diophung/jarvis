import { describe, expect, it } from 'vitest';
import { analyzeDraftEdit, analyzeWritingStyle } from './style.js';

describe('analyzeWritingStyle', () => {
  it('does not judge very short texts', () => {
    const obs = analyzeWritingStyle('Sounds good, thanks.');
    expect(obs.length).toBeNull();
    expect(obs.directness).toBeNull();
  });

  it('detects concise direct writing', () => {
    const obs = analyzeWritingStyle(
      'Ship the fix today. Update the customer once deployed. Flag any blockers to me directly.',
    );
    expect(obs.length).toBe('concise');
    expect(obs.directness).toBe('direct');
  });

  it('detects detailed writing', () => {
    const long = Array.from(
      { length: 12 },
      (_, i) =>
        `Paragraph ${i} elaborates extensively on the considerations, trade-offs, stakeholder concerns and historical context that informed this decision over the previous quarters.`,
    ).join(' ');
    expect(analyzeWritingStyle(long).length).toBe('detailed');
  });

  it('detects hedged (softened) writing', () => {
    const obs = analyzeWritingStyle(
      'Hi! I was wondering if maybe you could perhaps take a look at this when you get a chance? No worries if not, I just wanted to check. I think it is sort of important.',
    );
    expect(obs.directness).toBe('softened');
    expect(obs.hedgeCount).toBeGreaterThanOrEqual(4);
  });

  it('detects formal vs casual registers', () => {
    expect(
      analyzeWritingStyle(
        'Dear Ms. Alvarez, please find attached the revised agreement. Best regards, Alex',
      ).formality,
    ).toBe('formal');
    expect(
      analyzeWritingStyle('hey team, quick one — gonna push the demo to thursday, thanks! :)').formality,
    ).toBe('casual');
  });

  it('detects bullet structure', () => {
    const obs = analyzeWritingStyle(
      ['Plan for today:', '- finalize budget', '- review atlas deck', '- call vendor', '- send recap'].join(
        '\n',
      ),
    );
    expect(obs.structure).toBe('bullets');
  });
});

describe('analyzeDraftEdit', () => {
  const verboseDraft = [
    'Hi Jane, I hope this message finds you well. I just wanted to reach out because I was wondering',
    'if perhaps we could possibly find some time to discuss the quarterly budget review that is coming up.',
    'I think it might maybe be useful for us to align on the key figures beforehand, if you get a chance.',
    'Please let me know what works best for you whenever it is convenient. No worries if not!',
  ].join(' ');

  it('detects shortening and de-hedging', () => {
    const edited = 'Jane — can we meet Thursday to align on the Q3 budget figures? 30 minutes should do it.';
    const { changes } = analyzeDraftEdit(verboseDraft, edited);
    const dims = changes.map((c) => c.dimension);
    expect(dims).toContain('length');
    expect(changes.find((c) => c.dimension === 'length')?.to).toBe('concise');
    expect(dims).toContain('directness');
    expect(changes.find((c) => c.dimension === 'directness')?.to).toBe('direct');
  });

  it('detects restructuring into bullets', () => {
    const original =
      'We should cover the budget numbers, then the hiring plan, then the vendor migration status, and finally the launch timeline in our discussion tomorrow afternoon.';
    const edited = ['Agenda:', '- budget numbers', '- hiring plan', '- vendor migration', '- launch timeline'].join('\n');
    const { changes } = analyzeDraftEdit(original, edited);
    expect(changes.find((c) => c.dimension === 'structure')?.to).toBe('bullets');
  });

  it('reports no changes for an unchanged draft', () => {
    expect(analyzeDraftEdit(verboseDraft, verboseDraft).changes).toEqual([]);
  });
});
