#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, openSync, closeSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'plugins', 'evoagent');
const repository = 'physics31415926/evoagent';

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function inspectTree(target) {
  const stat = await lstat(target);
  assert(!stat.isSymbolicLink(), `Release resources must not be symbolic links: ${target}`);
  if (stat.isDirectory()) {
    for (const name of await readdir(target)) await inspectTree(path.join(target, name));
  } else {
    assert(stat.isFile(), `Unsupported release resource: ${target}`);
  }
}

export async function checkRelease() {
  const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
  assert(pkg.name === 'dsh-evoagent', 'Unexpected plugin package name');
  assert(typeof pkg.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version), 'Release version must be stable X.Y.Z');
  assert(pkg.type === 'module', 'Plugin must be an ES module');
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'Unexpected bundle patch');
  assert(pkg.exports?.['.'] === './index.js', 'Missing Host entry export');
  const tag = `dsh-plugin-v${pkg.version}`;
  if (process.env.GITHUB_REF_NAME) assert(process.env.GITHUB_REF_NAME === tag, `Tag must be ${tag}`);
  if (process.env.GITHUB_REPOSITORY) assert(process.env.GITHUB_REPOSITORY.toLowerCase() === repository, `Release repository must be ${repository}`);
  assert(Array.isArray(pkg.files) && pkg.files.length > 0, 'Package files must be explicit');
  for (const required of ['index.js', 'host.js', 'core.js', 'updates.js', 'update-host.js', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md']) {
    assert(pkg.files.includes(required), `Missing package resource: ${required}`);
  }
  for (const item of pkg.files) {
    assert(typeof item === 'string' && item.length > 0 && !path.isAbsolute(item) && !item.split(/[\\/]/).includes('..') && !/[*!?{}\[\]]/.test(item), 'Package files must be safe explicit relative paths');
    await inspectTree(path.join(pluginDir, item));
  }
  for (const locale of ['en-US', 'zh-CN']) {
    const data = JSON.parse(await readFile(path.join(pluginDir, 'locale', `${locale}.json`), 'utf8'));
    assert(data.meta?.title && data.meta?.description, `Missing ${locale} metadata`);
  }
  return { version: pkg.version, tag, repository, filename: `dsh-evoagent-${pkg.version}.tgz` };
}

async function absent(target) {
  try {
    await access(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite release asset: ${target}`);
}

export async function packRelease() {
  const release = await checkRelease();
  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  const asset = path.join(dist, release.filename);
  const checksum = `${asset}.sha256`;
  await absent(asset);
  await absent(checksum);
  // A version-specific lock prevents concurrent invocations from racing.
  const staging = path.join(dist, `.pack-${release.version}`);
  await mkdir(staging);
  try {
    let executable = 'npm';
    const reportFile = path.join(staging, 'pack-report.json');
    let args = ['pack', '--ignore-scripts', '--json', '--pack-destination', staging];
    if (process.platform === 'win32') {
      // Invoke npm's JS entry rather than a .cmd shell or piped child process.
      const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await access(cli);
      executable = process.execPath;
      args = [cli, ...args];
    }
    const reportFd = openSync(reportFile, 'wx');
    let result;
    try {
      result = spawnSync(executable, args, { cwd: pluginDir, stdio: ['ignore', reportFd, 'inherit'], env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    } finally {
      closeSync(reportFd);
    }
    if (result.error) throw result.error;
    assert(result.status === 0, `npm pack failed (exit ${result.status}, signal ${result.signal ?? 'none'})`);
    const reports = JSON.parse(await readFile(reportFile, 'utf8'));
    assert(Array.isArray(reports) && reports.length === 1, 'npm pack must report exactly one package');
    const report = reports[0];
    assert(report.name === 'dsh-evoagent' && report.version === release.version && report.filename === release.filename, 'npm pack reported unexpected package identity');
    const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
    const expected = new Set(['package.json']);
    async function collect(relative) {
      const target = path.join(pluginDir, relative);
      if ((await lstat(target)).isDirectory()) {
        for (const entry of await readdir(target)) await collect(`${relative}/${entry}`);
      } else expected.add(relative.replaceAll('\\', '/'));
    }
    for (const item of pkg.files) await collect(item);
    assert(Array.isArray(report.files), 'npm pack did not report file entries');
    const actual = new Set(report.files.map(file => file.path));
    assert(actual.size === expected.size && [...expected].every(name => actual.has(name)), 'npm pack file list differs from explicit package resources');
    const packed = path.join(staging, release.filename);
    const files = await readdir(staging);
    assert(files.length === 2 && files.includes(release.filename) && files.includes('pack-report.json'), 'npm pack returned unexpected assets');
    const digest = createHash('sha256').update(await readFile(packed)).digest('hex');
    await copyFile(packed, asset, constants.COPYFILE_EXCL);
    await writeFile(checksum, `${digest}  ${release.filename}\n`, { flag: 'wx' });
    console.log(`Release assets: ${asset}\n${checksum}`);
    return { ...release, asset, checksum, digest };
  } finally {
    // staging is the exact directory this invocation created, never a user path.
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.slice(2).every(arg => arg === '--check') && process.argv.length <= 3, 'Usage: node scripts/release-plugin.mjs [--check]');
    if (process.argv.includes('--check')) console.log(JSON.stringify(await checkRelease(), null, 2));
    else await packRelease();
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  }
}
