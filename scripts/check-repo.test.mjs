import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { checkTrackedFiles, credentialKinds } from './check-repo.mjs';

test('credential shapes are rejected but model digests and documentation are accepted', () => {
  const shapes = [
    ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['aws-access-key', 'AKIA' + 'A'.repeat(16)],
    ['github-token', 'ghp_' + 'a'.repeat(36)],
    ['github-fine-grained-token', 'github_pat_' + 'a'.repeat(50)],
    ['openai-key', 'sk-proj-' + 'a'.repeat(40)],
  ];
  for (const [kind, text] of shapes) assert.deepEqual(credentialKinds(text), [kind]);
  assert.deepEqual(credentialKinds('sha256=' + 'a'.repeat(64)), []);
  assert.deepEqual(credentialKinds('Keys stay in Keychain; model data is synthetic.'), []);
});

test('tracked credential failure reports only path and kind, never its value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sauti-scan-'));
  try {
    execFileSync('git', ['init', '--quiet', dir]);
    const fake = 'sk-proj-' + 'z'.repeat(40);
    writeFileSync(join(dir, 'fixture.txt'), fake);
    execFileSync('git', ['add', '--', 'fixture.txt'], { cwd: dir });
    const report = checkTrackedFiles(dir);
    assert.deepEqual(report.findings, [{ path: 'fixture.txt', kind: 'openai-key' }]);
    assert.equal(JSON.stringify(report).includes(fake), false);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(dir.startsWith(join(tmpdir(), 'sauti-scan-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
