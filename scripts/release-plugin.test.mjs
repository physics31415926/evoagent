import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './release-plugin.mjs';

const script = fileURLToPath(new URL('./release-plugin.mjs', import.meta.url));

function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.GITHUB_REF_NAME;
  delete env.GITHUB_REPOSITORY;
  Object.assign(env, extraEnv);
  const child = spawnSync(process.execPath, [script, ...args], { env, stdio: 'ignore' });
  if (child.error) throw child.error;
  return child.status;
}

test('release check returns stable package and exact repository', async () => {
  const release = await checkRelease();
  assert.match(release.version, /^\d+\.\d+\.\d+$/);
  assert.equal(release.repository, 'physics31415926/evoagent');
  assert.equal(release.tag, `dsh-plugin-v${release.version}`);
  assert.equal(release.filename, `dsh-evoagent-${release.version}.tgz`);
});

test('check CLI accepts matching release tag', async () => {
  const release = await checkRelease();
  assert.equal(run(['--check'], { GITHUB_REF_NAME: release.tag, GITHUB_REPOSITORY: release.repository }), 0);
});

test('check CLI rejects incorrect tag and repository', () => {
  assert.equal(run(['--check'], { GITHUB_REF_NAME: 'dsh-plugin-vinvalid' }), 1);
  assert.equal(run(['--check'], { GITHUB_REPOSITORY: 'someone/other' }), 1);
});

test('CLI rejects unknown and duplicate arguments without packing', () => {
  assert.equal(run(['--unknown']), 1);
  assert.equal(run(['--check', '--check']), 1);
});
