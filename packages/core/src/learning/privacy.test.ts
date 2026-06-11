import { describe, expect, it } from 'vitest';
import { detectSensitiveContent, isSafeToLearn } from './privacy.js';

describe('detectSensitiveContent', () => {
  it('flags health content', () => {
    expect(detectSensitiveContent('Follow-up on my diagnosis next week')).toBe('health');
    expect(detectSensitiveContent('picking up a prescription')).toBe('health');
    expect(detectSensitiveContent('she is pregnant')).toBe('health');
  });

  it('flags political content', () => {
    expect(detectSensitiveContent('I voted for the candidate')).toBe('political');
    expect(detectSensitiveContent('left-wing politics')).toBe('political');
  });

  it('flags religious content', () => {
    expect(detectSensitiveContent('see you at bible study')).toBe('religious');
  });

  it('flags sexual orientation content', () => {
    expect(detectSensitiveContent('discussing sexual orientation at work')).toBe('sexual');
  });

  it('flags immigration / union / criminal record content', () => {
    expect(detectSensitiveContent('my visa status is pending')).toBe('immigration');
    expect(detectSensitiveContent('the union membership drive')).toBe('union');
    expect(detectSensitiveContent('a criminal record check')).toBe('criminal');
  });

  it('passes ordinary work content', () => {
    expect(detectSensitiveContent('Q3 budget review and the Atlas launch plan')).toBeNull();
    expect(detectSensitiveContent('Please review the vendor contract by Friday')).toBeNull();
    expect(detectSensitiveContent('customer churn risk on the enterprise account')).toBeNull();
  });
});

describe('isSafeToLearn', () => {
  it('rejects when any field is sensitive', () => {
    expect(isSafeToLearn(['budget review', 'mentions chemotherapy schedule'])).toBe(false);
  });

  it('accepts clean fields and ignores empties', () => {
    expect(isSafeToLearn(['budget review', null, undefined, ''])).toBe(true);
  });
});
