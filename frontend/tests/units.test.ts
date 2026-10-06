import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate, I18N_KEYS } from '../src/lib/i18n';
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

test('every Hindi string has an English counterpart and falls back cleanly', () => {
  for (const k of Object.keys(I18N_KEYS.HI)) {
    if (k.startsWith('tool.')) continue; // English tool names come from the registry
    assert.ok(k in I18N_KEYS.EN, `missing English for ${k}`);
  }
  assert.equal(translate('hi', 'nav.tools'), 'टूल');
  assert.equal(translate('hi', 'tool.forest.name', 'Forest loss'), 'वन हानि');
  assert.equal(translate('en', 'tool.forest.name', 'Forest loss'), 'Forest loss');
  assert.equal(translate('hi', 'no.such.key', 'fallback'), 'fallback');
});
