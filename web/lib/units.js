import { HttpError } from './http.js';

export const CANONICAL_UNITS = Object.freeze(['g', 'kg', 'ml', 'l', 'unit']);

export function normalizeUnit(value) {
  const unit = String(value || '').trim().toLowerCase();
  if (!CANONICAL_UNITS.includes(unit)) {
    throw new HttpError(422, `Unit must be one of: ${CANONICAL_UNITS.join(', ')}.`, 'INVALID_UNIT');
  }
  return unit;
}

export function requireMatchingUnit(expected, actual) {
  if (normalizeUnit(expected) !== normalizeUnit(actual)) {
    throw new HttpError(409, `Unit mismatch: expected ${expected}, received ${actual}.`, 'UNIT_MISMATCH');
  }
}
