import { describe, it, expect } from 'vitest';
import {
  CATEGORY_KEYS, isReportCategory, categoryLabel, isReportTargetType,
  isResolution, noteRequiredFor, checkReportInput, MAX_REPORT_NOTE,
} from './reports';

describe('isReportCategory', () => {
  it('accepts every published category', () => {
    for (const key of CATEGORY_KEYS) expect(isReportCategory(key)).toBe(true);
  });
  it('rejects anything else', () => {
    for (const v of ['Spam', 'abuse', '', null, undefined, 7, {}]) {
      expect(isReportCategory(v)).toBe(false);
    }
  });
});

describe('categoryLabel', () => {
  it('gives the human wording for a known category', () => {
    expect(categoryLabel('harassment')).toBe('Harassment or bullying');
  });
  it('falls back to the raw value for a category written by an older build', () => {
    expect(categoryLabel('misinformation')).toBe('misinformation');
  });
});

describe('isReportTargetType', () => {
  it('accepts the three reportable things', () => {
    expect(isReportTargetType('comment')).toBe(true);
    expect(isReportTargetType('blogPost')).toBe(true);
    expect(isReportTargetType('user')).toBe(true);
  });
  it('rejects anything else', () => {
    for (const v of ['post', 'Comment', '', null, 3]) expect(isReportTargetType(v)).toBe(false);
  });
});

describe('isResolution', () => {
  it('allows only the two terminal states', () => {
    expect(isResolution('resolved')).toBe(true);
    expect(isResolution('dismissed')).toBe(true);
  });
  it('refuses to reopen a handled report', () => {
    expect(isResolution('open')).toBe(false);
  });
});

describe('noteRequiredFor', () => {
  it('demands an explanation for "other", which says nothing on its own', () => {
    expect(noteRequiredFor('other')).toBe(true);
  });
  it('leaves the note optional for categories that carry their own meaning', () => {
    for (const key of CATEGORY_KEYS.filter(k => k !== 'other')) {
      expect(noteRequiredFor(key)).toBe(false);
    }
  });
});

describe('checkReportInput', () => {
  it('accepts a valid category with no note', () => {
    expect(checkReportInput('spam', undefined)).toEqual({ ok: true, note: '' });
  });

  it('trims the note it returns', () => {
    expect(checkReportInput('spam', '  bot links  ')).toEqual({ ok: true, note: 'bot links' });
  });

  it('rejects an unknown category', () => {
    const out = checkReportInput('nonsense', '');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reason/i);
  });

  it('rejects a non-string note', () => {
    expect(checkReportInput('spam', { text: 'x' }).ok).toBe(false);
  });

  it('rejects a note past the cap', () => {
    const out = checkReportInput('spam', 'x'.repeat(MAX_REPORT_NOTE + 1));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/under/i);
  });

  it('accepts a note exactly at the cap', () => {
    expect(checkReportInput('spam', 'x'.repeat(MAX_REPORT_NOTE)).ok).toBe(true);
  });

  it('requires an explanation for "other"', () => {
    expect(checkReportInput('other', '').ok).toBe(false);
    expect(checkReportInput('other', '   ').ok).toBe(false);
    expect(checkReportInput('other', 'impersonating my employer').ok).toBe(true);
  });

  it('never returns a note alongside an error', () => {
    // The caller writes `note` straight to the row; a populated note on a
    // failed check would be a way to store text that passed no validation.
    expect(checkReportInput('other', '').note).toBe('');
  });
});
