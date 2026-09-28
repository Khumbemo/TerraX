/** Fetches a bundled sample file (relative to the app, so it works under any base path). */
export async function fetchSample(path: string, type = ''): Promise<File> {
  const res = await fetch(new URL(`data/${path}`, document.baseURI));
  if (!res.ok) throw new Error(`The sample file ${path} could not be loaded (HTTP ${res.status}).`);
  const blob = await res.blob();
  return new File([blob], path.split('/').pop()!, { type: type || blob.type });
}
