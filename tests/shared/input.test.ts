import { describe, expect, it } from 'vitest';

import { normalizeNumericInput } from '../../src/shared/input';

describe('normalizeNumericInput', () => {
  it('keeps half-width ASCII digits', () => {
    expect(normalizeNumericInput('0123456789')).toBe('0123456789');
  });

  it('converts full-width digits to half-width digits', () => {
    expect(normalizeNumericInput('０１２３４５６７８９')).toBe('0123456789');
  });

  it('normalizes mixed half-width and full-width digits', () => {
    expect(normalizeNumericInput('1２3４5６')).toBe('123456');
  });

  it('removes letters, whitespace, and symbols', () => {
    expect(normalizeNumericInput('a１-2 ３!四')).toBe('123');
  });

  it('truncates the normalized result to the maximum length', () => {
    expect(normalizeNumericInput('１２３４５６７', 6)).toBe('123456');
  });
});
