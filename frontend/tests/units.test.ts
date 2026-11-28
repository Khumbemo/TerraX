import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { browserLang, EN, LANG_CODES, LANGUAGES, RTL, translate, type Messages } from '../src/lib/i18n';
import { TOOLS } from '../src/lib/tools/registry';
import { ACRES_PER_HA, M2HA_TO_FT2ACRE, T_HA_TO_STON_ACRE, areaHa, elevationM, lengthM, perHa } from '../src/lib/units';

test('unit conversions match published factors', () => {
  assert.ok(Math.abs(ACRES_PER_HA - 10_000 / 4046.8564224) < 1e-9);
  assert.ok(Math.abs(T_HA_TO_STON_ACRE - 0.44609) < 1e-5); // 1 t/ha = 0.44609 short tons/acre
  assert.ok(Math.abs(M2HA_TO_FT2ACRE - 4.356) < 1e-3); // 1 m²/ha = 4.356 ft²/acre
  assert.equal(areaHa(1, 'imperial'), '2.471 acres');
  assert.equal(areaHa(2.5, 'metric'), '2.5 ha');
  assert.equal(lengthM(1609.344, 'imperial'), '1 mi');
  assert.equal(lengthM(30.48, 'imperial'), '100 ft');
  assert.equal(elevationM(1000, 'imperial'), '3,280.8 ft');
  assert.equal(perHa(100, 't', 'imperial', ' C'), '44.61 US tons C/acre');
  assert.equal(perHa(100, 't', 'metric', ' C'), '100 t C/ha');
});

test('every language has every interface string, keeps placeholders and falls back cleanly', async () => {
  const placeholders = (v: string) => (v.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [code] of LANGUAGES) {
    if (code === 'en') continue;
    const file = new URL(`../src/lib/locales/${code}.ts`, import.meta.url);
    assert.ok(existsSync(file), `no translation file for ${code}`);
    const m: Messages = (await import(file.href)).default;
    assert.deepEqual(Object.keys(m).sort(), Object.keys(EN).sort(), `${code}: keys differ from English`);
    for (const [k, v] of Object.entries(m)) {
      assert.ok(v.trim(), `${code}: empty ${k}`);
      assert.equal(placeholders(v), placeholders(EN[k] || v), `${code}: placeholders in ${k}`);
    }
  }
  // English tool names are the registry's.
  for (const tool of TOOLS) {
    assert.equal(EN[`tool.${tool.id}.name`], tool.name);
    assert.equal(EN[`tool.${tool.id}.summary`], tool.summary);
  }
  const hi: Messages = (await import('../src/lib/locales/hi')).default;
  assert.equal(translate(hi, 'nav.tools'), 'टूल');
  assert.equal(translate(hi, 'gate.signedIn', '', { email: 'a@b.org' }), 'a@b.org के रूप में साइन इन है।');
  assert.equal(translate(EN, 'tool.forest.name'), 'Forest loss');
  assert.equal(translate(hi, 'no.such.key', 'fallback'), 'fallback');
  assert.equal(browserLang(['pt-BR', 'en']), 'pt');
  assert.equal(browserLang(['nl-NL']), 'en');
  assert.ok(RTL.every(l => LANG_CODES.includes(l)));
});
