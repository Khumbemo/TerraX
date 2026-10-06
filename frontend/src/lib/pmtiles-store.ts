// The local .pmtiles file chosen for the Protomaps map: kept in memory and,
// when the browser allows, in IndexedDB so it survives a reload.
import { idbGet, idbSet } from './idb';

let current: File | null = null;
let loaded = false;
const listeners = new Set<() => void>();

export function getLocalPmtiles(): File | null {
  return current;
}

export async function loadLocalPmtiles(): Promise<File | null> {
  if (!loaded) {
    loaded = true;
    const f = await idbGet<File>('pmtiles');
    if (f && !current) current = f;
  }
  return current;
}

export async function setLocalPmtiles(file: File | null): Promise<boolean> {
  current = file;
  loaded = true;
  const ok = await idbSet('pmtiles', file ?? undefined);
  listeners.forEach(l => l());
  return ok;
}

export function onLocalPmtilesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
