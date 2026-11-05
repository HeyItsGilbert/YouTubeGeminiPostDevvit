import { describe, expect, it } from 'vitest';
import { assemblePostBody, matchesExclusionFilter, parseGeneratedResponse } from './postUtils.js';

describe('matchesExclusionFilter', () => {
  it('matches a keyword as a case-insensitive substring', () => {
    expect(matchesExclusionFilter('Episode 12: Trailer Reaction', 'trailer')).toBe(true);
  });

  it('matches any of several comma-separated keywords', () => {
    expect(matchesExclusionFilter('Bonus Episode', 'trailer, bonus, short')).toBe(true);
  });

  it('returns false when no keyword matches', () => {
    expect(matchesExclusionFilter('Episode 12: The Real Deal', 'trailer, bonus')).toBe(false);
  });

  it('returns false for blank keywords', () => {
    expect(matchesExclusionFilter('Episode 12', '')).toBe(false);
    expect(matchesExclusionFilter('Episode 12', '   ')).toBe(false);
  });

  it('ignores empty entries produced by stray commas', () => {
    expect(matchesExclusionFilter('Episode 12', ', ,trailer,')).toBe(false);
    expect(matchesExclusionFilter('Episode 12: Trailer', ', ,trailer,')).toBe(true);
  });
});

describe('parseGeneratedResponse', () => {
  it('splits the first non-empty line as the title and the rest as the body', () => {
    const result = parseGeneratedResponse('My Title\n\nFirst paragraph.\nSecond line.', 'fallback');
    expect(result).toEqual({ title: 'My Title', body: 'First paragraph.\nSecond line.' });
  });

  it('skips leading blank lines before finding the title', () => {
    const result = parseGeneratedResponse('\n\n  Real Title  \nBody text', 'fallback');
    expect(result.title).toBe('Real Title');
    expect(result.body).toBe('Body text');
  });

  it('trims trailing whitespace from the body', () => {
    const result = parseGeneratedResponse('Title\nBody\n\n   ', 'fallback');
    expect(result.body).toBe('Body');
  });

  it('falls back to the fallback title when the response is entirely blank', () => {
    const result = parseGeneratedResponse('   \n\n  ', 'Fallback Title');
    expect(result).toEqual({ title: 'Fallback Title', body: '' });
  });

  it('produces an empty body when there is only a title line', () => {
    const result = parseGeneratedResponse('Only A Title', 'fallback');
    expect(result).toEqual({ title: 'Only A Title', body: '' });
  });
});

describe('assemblePostBody', () => {
  it('joins all three non-empty parts with double newlines', () => {
    expect(assemblePostBody('Prepend', 'Body', 'Append')).toBe('Prepend\n\nBody\n\nAppend');
  });

  it('omits empty parts rather than leaving blank gaps', () => {
    expect(assemblePostBody('', 'Body', '')).toBe('Body');
    expect(assemblePostBody('Prepend', 'Body', '')).toBe('Prepend\n\nBody');
    expect(assemblePostBody('', 'Body', 'Append')).toBe('Body\n\nAppend');
  });

  it('returns an empty string when every part is empty', () => {
    expect(assemblePostBody('', '', '')).toBe('');
  });
});
