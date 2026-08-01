/**
 * Normalizes a user-entered number string for fields such as PIN inputs.
 *
 * Full-width digits are converted with NFKC normalization, non-ASCII digits
 * are removed, and the optional maximum length is applied last.
 */
export function normalizeNumericInput(value: string, maxLength?: number): string {
  const digits = value.normalize('NFKC').replace(/[^0-9]/g, '');

  return maxLength === undefined ? digits : digits.slice(0, Math.max(0, maxLength));
}
