import test from 'node:test';
import assert from 'node:assert/strict';
import { nextReleaseVersion, compareVersions, canPublish } from '../../tools/auto-release.mjs';

test('auto-release advances an unchanged source version beyond every published release', () => {
  assert.equal(nextReleaseVersion('1.1.1', ['1.1.0', '1.1.1']), '1.1.2');
  assert.equal(nextReleaseVersion('1.1.1', ['1.1.9', '1.1.10', '1.1.2']), '1.1.11');
  assert.equal(nextReleaseVersion('1.1.1', ['1.2.0']), '1.2.1');
});
test('auto-release keeps an intentionally raised version and reuses an unpublished retry version', () => {
  assert.equal(nextReleaseVersion('2.0.0', ['1.1.1']), '2.0.0');
  assert.equal(nextReleaseVersion('1.1.2', ['1.1.1']), '1.1.2');
  assert.equal(nextReleaseVersion('1.0.0', []), '1.0.0');
});
test('auto-release rejects malformed and overflowing versions rather than tagging them', () => {
  for (const value of ['01.1.1', '1.2.3-beta', 'v1.2.3', '1.2', '1.2.1000000']) assert.throws(() => nextReleaseVersion(value, []));
  assert.throws(() => nextReleaseVersion('1.0.0', ['1.0.999999']));
  assert.equal(compareVersions('1.10.0', '1.9.9') > 0, true);
});
test('auto-release will not publish or overwrite an advanced main branch', () => {
  const source = 'a'.repeat(40), newer = 'b'.repeat(40);
  assert.equal(canPublish(source, source), true);
  assert.equal(canPublish(source, newer), false);
  assert.throws(() => canPublish('main', newer));
});
