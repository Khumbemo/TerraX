// Writes a minimal PMTiles v3 archive (uncompressed) holding one raster tile at z0.
// Layout per the PMTiles v3 spec: 127-byte header, root directory, JSON metadata, tile data.
function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export function rasterPmtiles(tile: Buffer, tileType = 2 /* PNG */): Buffer {
  // One entry: tile id 0 (z0/0/0), run length 1, length, offset 0 (written as offset + 1).
  const dir = Buffer.from([...varint(1), ...varint(0), ...varint(1), ...varint(tile.length), ...varint(1)]);
  const meta = Buffer.from('{}');
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header[7] = 3;
  const u64 = (o: number, v: number) => header.writeBigUInt64LE(BigInt(v), o);
  const rootOff = 127, metaOff = rootOff + dir.length, dataOff = metaOff + meta.length;
  u64(8, rootOff);
  u64(16, dir.length);
  u64(24, metaOff);
  u64(32, meta.length);
  u64(40, dataOff); // no leaf directories
  u64(48, 0);
  u64(56, dataOff);
  u64(64, tile.length);
  u64(72, 1);
  u64(80, 1);
  u64(88, 1);
  header[96] = 1; // clustered
  header[97] = 1; // internal compression: none
  header[98] = 1; // tile compression: none
  header[99] = tileType;
  header[100] = 0; // min zoom
  header[101] = 0; // max zoom
  header.writeInt32LE(-180e7, 102);
  header.writeInt32LE(-85e7, 106);
  header.writeInt32LE(180e7, 110);
  header.writeInt32LE(85e7, 114);
  return Buffer.concat([header, dir, meta, tile]);
}
