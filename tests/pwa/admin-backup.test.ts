import { describe, expect, it } from 'vitest';
import { backupWarningFor } from '../../src/pwa/components/AdminApp';

describe('backup warning timing', () => {
  const now = Date.UTC(2026, 7, 13, 7, 30);
  const week = 7 * 24 * 60 * 60 * 1000;

  it('warns before the first backup', () => {
    expect(backupWarningFor(null, now)).toBe('first');
  });

  it('does not warn before seven days have elapsed', () => {
    expect(backupWarningFor(now - week + 1, now)).toBeUndefined();
  });

  it('warns at seven days and later', () => {
    expect(backupWarningFor(now - week, now)).toBe('stale');
    expect(backupWarningFor(now - week - 1, now)).toBe('stale');
  });
});
