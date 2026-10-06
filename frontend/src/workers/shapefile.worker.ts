// Parses a zipped shapefile off the main thread, so a malformed file can
// never freeze the page (the caller terminates this worker on timeout).
import shp from 'shpjs';

self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const out = await shp(e.data);
    const list = Array.isArray(out) ? out : [out];
    (self as unknown as Worker).postMessage({ ok: true, features: list.flatMap(x => x.features) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
