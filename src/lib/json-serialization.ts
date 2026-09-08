export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function toJsonArray(arr: string[] | undefined | null): string {
  if (!arr) return "[]";
  return JSON.stringify(arr);
}

export function parseJsonObject<T = Record<string, unknown>>(
  value: string | null | undefined,
): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function toJsonString(obj: unknown): string | null {
  if (obj === null || obj === undefined) return null;
  return JSON.stringify(obj);
}
