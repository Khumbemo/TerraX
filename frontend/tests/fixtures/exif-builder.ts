// Builds a little-endian EXIF (TIFF) block with camera, time and GPS tags,
// and splices it into a JPEG as an APP1 segment. Test use only.
type Entry = { tag: number; type: number; count: number; data: Buffer };

function ifd(entries: Entry[], start: number): { bytes: Buffer; size: number } {
  const headLen = 2 + entries.length * 12 + 4;
  let extra = Buffer.alloc(0);
  const head = Buffer.alloc(headLen);
  head.writeUInt16LE(entries.length, 0);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    head.writeUInt16LE(e.tag, o);
    head.writeUInt16LE(e.type, o + 2);
    head.writeUInt32LE(e.count, o + 4);
    if (e.data.length <= 4) e.data.copy(head, o + 8);
    else {
      head.writeUInt32LE(start + headLen + extra.length, o + 8);
      extra = Buffer.concat([extra, e.data, Buffer.alloc(e.data.length & 1)]);
    }
  });
  const bytes = Buffer.concat([head, extra]);
  return { bytes, size: bytes.length };
}

const ascii = (s: string) => Buffer.from(s + '\0', 'latin1');
const long = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const rationals = (vals: [number, number][]) => {
  const b = Buffer.alloc(vals.length * 8);
  vals.forEach(([n, d], i) => {
    b.writeUInt32LE(n, i * 8);
    b.writeUInt32LE(d, i * 8 + 4);
  });
  return b;
};
const dms = (deg: number): [number, number][] => {
  const a = Math.abs(deg);
  const d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 1000), 1000]];
};

export function exifTiff(o: { make: string; model: string; dateTime: string; lat: number; lon: number; alt: number }): Buffer {
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  // Sizes are fixed by the entry lists, so lay out IFD0, the Exif IFD, then the GPS IFD.
  const ifd0Entries = (exifAt: number, gpsAt: number): Entry[] => [
    { tag: 0x010f, type: 2, count: o.make.length + 1, data: ascii(o.make) },
    { tag: 0x0110, type: 2, count: o.model.length + 1, data: ascii(o.model) },
    { tag: 0x8769, type: 4, count: 1, data: long(exifAt) },
    { tag: 0x8825, type: 4, count: 1, data: long(gpsAt) },
  ];
  const probe = ifd(ifd0Entries(0, 0), 8);
  const exifAt = 8 + probe.size;
  const exifIfd = ifd([{ tag: 0x9003, type: 2, count: o.dateTime.length + 1, data: ascii(o.dateTime) }], exifAt);
  const gpsAt = exifAt + exifIfd.size;
  const gpsIfd = ifd(
    [
      { tag: 1, type: 2, count: 2, data: ascii(o.lat < 0 ? 'S' : 'N') },
      { tag: 2, type: 5, count: 3, data: rationals(dms(o.lat)) },
      { tag: 3, type: 2, count: 2, data: ascii(o.lon < 0 ? 'W' : 'E') },
      { tag: 4, type: 5, count: 3, data: rationals(dms(o.lon)) },
      { tag: 5, type: 1, count: 1, data: Buffer.from([o.alt < 0 ? 1 : 0]) },
      { tag: 6, type: 5, count: 1, data: rationals([[Math.round(Math.abs(o.alt) * 10), 10]]) },
    ],
    gpsAt,
  );
  return Buffer.concat([header, ifd(ifd0Entries(exifAt, gpsAt), 8).bytes, exifIfd.bytes, gpsIfd.bytes]);
}

/** Inserts an EXIF APP1 segment right after the JPEG SOI marker. */
export function withExif(jpeg: Buffer, tiff: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
}
