import { expect, type Page } from '@playwright/test';

/** Starts a session and waits for the tool hub. Fails the test on any page error. */
export async function start(page: Page, name = 'Test Operator') {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.fill('#operator-name', name);
  await page.click('button:has-text("Start session")');
  await expect(page.locator('.tool-card').first()).toBeVisible();
  return errors;
}

export async function openTool(page: Page, name: string) {
  await page.locator('.tool-card', { hasText: name }).click();
  await expect(page.locator('.tool-workspace h2', { hasText: name })).toBeVisible();
}

export async function backToTools(page: Page) {
  await page.click('button:has-text("← All tools")');
}

/** Sends a chat message and returns the reply text. */
export async function chat(page: Page, chatId: string, message: string): Promise<string> {
  const inputId = `${chatId}-input`;
  const panel = page.locator('section.chat-panel', { has: page.locator(`#${inputId}`) });
  const before = await panel.locator('.bot-style').count();
  await page.fill(`#${inputId}`, message);
  await page.press(`#${inputId}`, 'Enter');
  const reply = panel.locator('.bot-style').nth(before);
  await expect(reply).toBeVisible();
  return reply.innerText();
}

/** Minimal zipped shapefile (stored, uncompressed): one 0.01° WGS84 square at 25.67 N, 94.10 E. */
export function shapefileZip(): Buffer {
  const ring = [[94.1, 25.67], [94.1, 25.68], [94.11, 25.68], [94.11, 25.67], [94.1, 25.67]];
  const bbox = [94.1, 25.67, 94.11, 25.68];
  const header = (lenWords: number) => {
    const h = Buffer.alloc(100);
    h.writeInt32BE(9994, 0);
    h.writeInt32BE(lenWords, 24);
    h.writeInt32LE(1000, 28);
    h.writeInt32LE(5, 32);
    bbox.forEach((v, i) => h.writeDoubleLE(v, 36 + i * 8));
    return h;
  };
  const content = Buffer.alloc(4 + 32 + 4 + 4 + 4 + ring.length * 16);
  let o = 0;
  content.writeInt32LE(5, o); o += 4;
  for (const v of bbox) { content.writeDoubleLE(v, o); o += 8; }
  content.writeInt32LE(1, o); o += 4;
  content.writeInt32LE(ring.length, o); o += 4;
  content.writeInt32LE(0, o); o += 4;
  for (const [x, y] of ring) { content.writeDoubleLE(x, o); content.writeDoubleLE(y, o + 8); o += 16; }
  const recHead = Buffer.alloc(8);
  recHead.writeInt32BE(1, 0);
  recHead.writeInt32BE(content.length / 2, 4);
  const shp = Buffer.concat([header((100 + 8 + content.length) / 2), recHead, content]);
  const shxRec = Buffer.alloc(8);
  shxRec.writeInt32BE(50, 0);
  shxRec.writeInt32BE(content.length / 2, 4);
  const shx = Buffer.concat([header((100 + 8) / 2), shxRec]);
  const dbfHead = Buffer.alloc(65);
  dbfHead[0] = 3; dbfHead[1] = 126; dbfHead[2] = 1; dbfHead[3] = 1;
  dbfHead.writeUInt32LE(1, 4); dbfHead.writeUInt16LE(65, 8); dbfHead.writeUInt16LE(21, 10);
  dbfHead.write('NAME', 32, 'ascii'); dbfHead[43] = 0x43; dbfHead[48] = 20; dbfHead[64] = 0x0d;
  const rec = Buffer.alloc(21, 0x20);
  rec.write('Shapefile plot', 1, 'ascii');
  const dbf = Buffer.concat([dbfHead, rec, Buffer.from([0x1a])]);
  const prj = Buffer.from('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]');
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const files: [string, Buffer][] = [['plot.shp', shp], ['plot.shx', shx], ['plot.dbf', dbf], ['plot.prj', prj]];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name);
    const c = crc(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
