/**
 * `value` held inside the range: truncated to a whole number, `minimum` when it is not a number,
 * and `minimum` again when the range is empty — a bound of `length - 1` on nothing is `-1`.
 */
export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.trunc(value), minimum), Math.max(minimum, maximum));
}
