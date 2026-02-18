export interface IntegerQueryOptions {
  min: number;
  max: number;
}

export function parseQueryInteger(
  value: string | undefined,
  defaultValue: number,
  options: IntegerQueryOptions,
): number | null {
  if (value === undefined) return defaultValue;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || `${parsed}` !== value.trim()) {
    return null;
  }
  if (parsed < options.min || parsed > options.max) {
    return null;
  }
  return parsed;
}
