import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebase.js', () => ({ auth: {} }));
import { fitSize } from './photos.js';

describe('fitSize', () => {
  it('scales the long side down to max', () => {
    expect(fitSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });
  it('never upscales', () => {
    expect(fitSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});
