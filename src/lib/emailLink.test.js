import { describe, it, expect } from 'vitest';
import { isIPhone, linkFromPaste } from './emailLink.js';

describe('isIPhone', () => {
  it('is true for iPhone and iPod only', () => {
    expect(isIPhone('Mozilla/5.0 (iPhone; CPU iPhone OS 13_3 like Mac OS X) AppleWebKit/605.1.15')).toBe(true);
    expect(isIPhone('Mozilla/5.0 (iPad; CPU OS 13_3 like Mac OS X)')).toBe(false);
    expect(isIPhone('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120')).toBe(false);
    expect(isIPhone('')).toBe(false);
  });
});

describe('linkFromPaste', () => {
  const link = 'https://proj.firebaseapp.com/__/auth/links?apiKey=k&mode=signIn&oobCode=abc123&continueUrl=https%3A%2F%2Fapp.example.org%2F';
  it('returns a bare link unchanged', () => {
    expect(linkFromPaste(link)).toBe(link);
    expect(linkFromPaste(`  ${link}\n`)).toBe(link);
  });
  it('finds the link inside surrounding text and returns empty when there is none', () => {
    expect(linkFromPaste(`Sign in: ${link} thanks`)).toBe(link);
    expect(linkFromPaste('hello')).toBe('');
    expect(linkFromPaste(undefined)).toBe('');
  });
});
