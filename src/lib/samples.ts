/**
 * Fetches a bundled sample file (relative to the app, so it works under any base path).
 * The sandboxed preview host does not serve .tif files, so the preview build
 * publishes them base64-encoded as `<name>.b64.txt` and decodes them here.
 */
export async function fetchSample(path: string, type = ''): Promise<File> {
  const name = path.split('/').pop()!;
  if (__TERRAX_PREVIEW__ && /\.tiff?$/i.test(path)) {
    const res = await fetch(new URL(`data/${path}.b64.txt`, document.baseURI));
    if (!res.ok) throw new Error(`The sample file ${name} could not be loaded (HTTP ${res.status}).`);
    const bin = atob((await res.text()).trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: 'image/tiff' });
  }
  const res = await fetch(new URL(`data/${path}`, document.baseURI));
  if (!res.ok) throw new Error(`The sample file ${name} could not be loaded (HTTP ${res.status}).`);
  const blob = await res.blob();
  return new File([blob], name, { type: type || blob.type });
}
