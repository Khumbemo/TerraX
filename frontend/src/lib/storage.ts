// Safe wrappers around localStorage. Storage can be unavailable (private
// windows, blocked site data, sandboxed previews), so every access is
// guarded and callers always get a usable fallback.
//
// Keys are namespaced "terrax_". Values written by the app's previous name
// ("terrasense_") are migrated on first read.

const PREFIX = 'terrax_';
const LEGACY_PREFIX = 'terrasense_';

export function getItem(key: string): string | null {
  try {
    const value = localStorage.getItem(PREFIX + key);
    if (value !== null) return value;
    const legacy = localStorage.getItem(LEGACY_PREFIX + key);
    if (legacy !== null) {
      localStorage.setItem(PREFIX + key, legacy);
      localStorage.removeItem(LEGACY_PREFIX + key);
      return legacy;
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function setItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
    localStorage.removeItem(LEGACY_PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

export function getJSON<T>(key: string, fallback: T): T {
  const raw = getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJSON(key: string, value: unknown): boolean {
  try {
    return setItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
