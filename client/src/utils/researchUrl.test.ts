import { describe, it, expect } from 'vitest';
import {
  isResearchPath, parseResearchPath, researchPathFor, researchArticlePath, researchAskPath,
} from './researchUrl';

describe('isResearchPath', () => {
  it('matches the index and a thread', () => {
    expect(isResearchPath('/research')).toBe(true);
    expect(isResearchPath('/research/')).toBe(true);
    expect(isResearchPath('/research/abc123')).toBe(true);
  });

  it('does not match a neighbouring path', () => {
    // The prefix test must not claim /researchers or an unrelated route.
    expect(isResearchPath('/researchers')).toBe(false);
    expect(isResearchPath('/blog')).toBe(false);
    expect(isResearchPath('/')).toBe(false);
  });
});

describe('parseResearchPath', () => {
  it('reads the thread id', () => {
    expect(parseResearchPath('/research/abc123')).toBe('abc123');
    expect(parseResearchPath('/research/abc123/')).toBe('abc123');
  });

  it('returns null for the bare index', () => {
    expect(parseResearchPath('/research')).toBeNull();
    expect(parseResearchPath('/research/')).toBeNull();
  });

  it('round-trips an id that needs encoding', () => {
    const id = 'a b/c';
    expect(parseResearchPath(researchPathFor(id))).toBe(id);
  });
});

describe('researchArticlePath', () => {
  it('carries the url, and the title when there is one', () => {
    const params = new URLSearchParams(researchArticlePath('https://x.test/a', 'A Title').split('?')[1]);
    expect(params.get('url')).toBe('https://x.test/a');
    expect(params.get('title')).toBe('A Title');
  });

  it('omits the title rather than sending an empty one', () => {
    expect(researchArticlePath('https://x.test/a')).not.toContain('title=');
  });
});

describe('researchAskPath', () => {
  it('carries the question, and the url when there is one', () => {
    const params = new URLSearchParams(researchAskPath('why is the sky blue?', 'https://x.test/a').split('?')[1]);
    expect(params.get('q')).toBe('why is the sky blue?');
    expect(params.get('url')).toBe('https://x.test/a');
  });

  it('works without an article — a question away from one is still a question', () => {
    const path = researchAskPath('what is a newt?');
    expect(new URLSearchParams(path.split('?')[1]).get('q')).toBe('what is a newt?');
    expect(path).not.toContain('url=');
  });

  it('encodes a question containing separators', () => {
    // A question with & or = in it must not split into extra params.
    const path = researchAskPath('a=b & c?');
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('q')).toBe('a=b & c?');
    expect([...params.keys()]).toEqual(['q']);
  });
});
