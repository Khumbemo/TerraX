// Minimal EXIF reader: camera, capture time and GPS position from JPEG
// (APP1), WebP (EXIF chunk) and PNG (eXIf chunk) files. Follows the TIFF 6.0
// IFD layout used by EXIF 2.3 (CIPA DC-008).

export interface ExifInfo {
  make: string | null;
  model: string | null;
  /** DateTimeOriginal (or DateTime) as written by the camera, local time without zone. */
  dateTime: string | null;
  lat: number | null;
  lon: number | null;
  /** Metres above sea level (negative below). */
  altitude: number | null;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseTiff(view: DataView, base: number): ExifInfo | null {
  if (base + 8 > view.byteLength) return null;
  const order = view.getUint16(base);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  const u16 = (o: number) => view.getUint16(base + o, le);
  const u32 = (o: number) => view.getUint32(base + o, le);
  if (u16(2) !== 42) return null;
  const len = view.byteLength - base;

  type Entry = { type: number; count: number; valueOffset: number };
  const readIfd = (off: number): Map<number, Entry> => {
    const m = new Map<number, Entry>();
    if (off <= 0 || off + 2 > len) return m;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > len) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      m.set(u16(e), { type, count, valueOffset: size <= 4 ? e + 8 : u32(e + 8) });
    }
    return m;
  };
  const ascii = (e: Entry | undefined): string | null => {
    if (!e || e.type !== 2 || e.valueOffset + e.count > len) return null;
    let s = '';
    for (let i = 0; i < e.count; i++) {
      const c = view.getUint8(base + e.valueOffset + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || null;
  };
  const rationals = (e: Entry | undefined): number[] | null => {
    if (!e || (e.type !== 5 && e.type !== 10) || e.valueOffset + e.count * 8 > len) return null;
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const o = e.valueOffset + i * 8;
      const num = e.type === 5 ? u32(o) : view.getInt32(base + o, le);
      const den = e.type === 5 ? u32(o + 4) : view.getInt32(base + o + 4, le);
      out.push(den ? num / den : NaN);
    }
    return out;
  };

  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.get(0x8769);
  const gpsPtr = ifd0.get(0x8825);
  const exif = exifPtr ? readIfd(u32(exifPtr.valueOffset)) : new Map<number, Entry>();
  const gps = gpsPtr ? readIfd(u32(gpsPtr.valueOffset)) : new Map<number, Entry>();

  const dms = (tag: number, refTag: number, neg: string): number | null => {
    const v = rationals(gps.get(tag));
    const ref = ascii(gps.get(refTag));
    if (!v || v.length < 3 || v.some(x => !Number.isFinite(x))) return null;
    const deg = v[0] + v[1] / 60 + v[2] / 3600;
    return ref && ref.toUpperCase().startsWith(neg) ? -deg : deg;
  };
  let lat = dms(2, 1, 'S');
  let lon = dms(4, 3, 'W');
  if (lat !== null && (Math.abs(lat) > 90 || lon === null || Math.abs(lon) > 180)) lat = lon = null;
  // 0,0 is what some cameras write when they have no fix.
  if (lat === 0 && lon === 0) lat = lon = null;
  let altitude: number | null = null;
  const alt = rationals(gps.get(6));
  if (alt && Number.isFinite(alt[0])) {
    const refE = gps.get(5);
    const below = refE && refE.type === 1 ? view.getUint8(base + refE.valueOffset) === 1 : false;
    altitude = below ? -alt[0] : alt[0];
  }
  return {
    make: ascii(ifd0.get(0x010f)),
    model: ascii(ifd0.get(0x0110)),
    dateTime: ascii(exif.get(0x9003)) ?? ascii(ifd0.get(0x0132)),
    lat,
    lon: lat === null ? null : lon,
    altitude,
  };
}

const isExifHeader = (v: DataView, o: number) =>
  o + 6 <= v.byteLength && v.getUint32(o) === 0x45786966 /* "Exif" */ && v.getUint16(o + 4) === 0;

/** Reads EXIF from an image file buffer; null when there is none. */
export function readExif(buf: ArrayBuffer): ExifInfo | null {
  const v = new DataView(buf);
  if (v.byteLength < 12) return null;
  // JPEG
  if (v.getUint16(0) === 0xffd8) {
    let o = 2;
    while (o + 4 <= v.byteLength) {
      if (v.getUint8(o) !== 0xff) return null;
      const marker = v.getUint8(o + 1);
      if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
      const size = v.getUint16(o + 2);
      if (marker === 0xe1 && isExifHeader(v, o + 4)) return parseTiff(v, o + 10);
      o += 2 + size;
    }
    return null;
  }
  // WebP: RIFF container with an "EXIF" chunk
  if (v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    let o = 12;
    while (o + 8 <= v.byteLength) {
      const id = v.getUint32(o);
      const size = v.getUint32(o + 4, true);
      if (id === 0x45584946) return parseTiff(v, isExifHeader(v, o + 8) ? o + 14 : o + 8);
      o += 8 + size + (size & 1);
    }
    return null;
  }
  // PNG: "eXIf" chunk
  if (v.getUint32(0) === 0x89504e47) {
    let o = 8;
    while (o + 8 <= v.byteLength) {
      const size = v.getUint32(o);
      const type = v.getUint32(o + 4);
      if (type === 0x65584966) return parseTiff(v, o + 8);
      if (type === 0x49454e44) return null; // IEND
      o += 12 + size;
    }
  }
  return null;
}
