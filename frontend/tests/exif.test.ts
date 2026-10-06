import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExif } from '../src/lib/exif';
import { exifTiff, withExif } from './fixtures/exif-builder';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
// Smallest structurally valid JPEG prefix for the parser: SOI, a DQT stub and SOS.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);

test('EXIF GPS, camera and time from a JPEG', () => {
  const info = readExif(ab(withExif(jpeg, exifTiff({ make: 'DJI', model: 'FC3170', dateTime: '2025:03:14 10:22:05', lat: 25.6742, lon: 94.1086, alt: 1493.2 }))))!;
  assert.equal(info.make, 'DJI');
  assert.equal(info.model, 'FC3170');
  assert.equal(info.dateTime, '2025:03:14 10:22:05');
  assert.ok(Math.abs(info.lat! - 25.6742) < 1e-6, String(info.lat));
  assert.ok(Math.abs(info.lon! - 94.1086) < 1e-6, String(info.lon));
  assert.ok(Math.abs(info.altitude! - 1493.2) < 1e-9);
  const sw = readExif(ab(withExif(jpeg, exifTiff({ make: 'A', model: 'B', dateTime: 'x', lat: -33.9, lon: -70.6, alt: -12 }))))!;
  assert.ok(sw.lat! < 0 && sw.lon! < 0 && sw.altitude === -12);
});

test('images without EXIF', () => {
  assert.equal(readExif(ab(jpeg)), null);
  assert.equal(readExif(ab(Buffer.from('not an image at all'))), null);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)]);
  assert.equal(readExif(ab(png)), null);
});
