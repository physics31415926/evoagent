import { createHash } from 'node:crypto';

const API = 'https://api.github.com/repos/physics31415926/evoagent/releases?per_page=30';
const ROOT = 'https://github.com/physics31415926/evoagent/releases/download/';
const MAX = 8 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
function semver(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compare(a, b) {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function assetURL(url, tag, name) { return url === `${ROOT}${tag}/${name}`; }
function safeHop(value) {
  try {
    const u = new URL(value);
    const authority = /^[a-z]+:\/\/([^/]+)/i.exec(value)?.[1];
    return !!authority && !authority.includes(':') && !authority.includes('@') && u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'));
  } catch { return false; }
}
function parentAbort(signal) { if (signal?.aborted) throw signal.reason ?? fail('aborted'); }
function deadline(parent, ms) {
  parentAbort(parent);
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason ?? fail('aborted'));
  parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(fail('timeout')), ms);
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', cancel); } };
}
async function readBounded(response, max, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) { await response.body?.cancel(); throw fail('size_limit'); }
  if (!response.body) throw fail('empty_body');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) throw fail('size_limit');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function select(releases) {
  if (!Array.isArray(releases)) throw fail('invalid_release_data');
  let best = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') continue;
    const version = release.tag_name.startsWith('dsh-plugin-v') ? release.tag_name.slice(12) : '';
    if (!semver(version)) continue;
    const tag = release.tag_name, name = `dsh-evoagent-${version}.tgz`;
    const matches = Array.isArray(release.assets) ? release.assets.filter(a => a?.name === name) : [];
    if (matches.length !== 1) continue;
    const a = matches[0];
    if (!Number.isSafeInteger(a.size) || a.size <= 0 || a.size > MAX || !assetURL(a.browser_download_url, tag, name)) continue;
    const digest = typeof a.digest === 'string' && /^sha256:[a-fA-F0-9]{64}$/.test(a.digest) ? a.digest.toLowerCase() : null;
    const candidate = { version, tag, url: a.browser_download_url, name, size: a.size, digest, notes: typeof release.body === 'string' ? release.body.slice(0, 16000) : '', publishedAt: typeof release.published_at === 'string' ? release.published_at : null };
    if (!best || compare(version, best.version) > 0) best = candidate;
  }
  return best;
}
const known = new Set(['timeout', 'size_limit', 'empty_body', 'invalid_release_data', 'http_error', 'invalid_json', 'redirect_denied', 'redirect_limit', 'digest_mismatch', 'size_mismatch']);
function normalized(error, signal) {
  if (signal?.aborted) return signal.reason ?? fail('aborted');
  return fail(known.has(error?.code) ? error.code : 'network_error');
}

export function createUpdater({ version, linked, fetchImpl = fetch, now = Date.now }) {
  if (!semver(version)) throw fail('invalid_installed_version');
  let current = { installed: version, latest: null, newer: false, linked: !!linked, installable: false, checkError: null, checkedAt: null };
  let inFlight = null, lastAttempt = null, succeeded = false;
  const snapshot = () => structuredClone(current);
  async function check({ signal, refresh = false } = {}) {
    parentAbort(signal);
    if (inFlight) { const result = await inFlight; parentAbort(signal); return structuredClone(result); }
    const elapsed = lastAttempt === null ? Infinity : now() - lastAttempt;
    if (elapsed < (refresh ? 30000 : succeeded ? 900000 : 60000)) return snapshot();
    lastAttempt = now();
    inFlight = (async () => {
      const d = deadline(signal, 20000);
      try {
        const response = await fetchImpl(API, { signal: d.signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) { await response.body?.cancel(); throw fail('http_error'); }
        const bytes = await readBounded(response, 1024 * 1024, d.signal);
        let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw fail('invalid_json'); }
        const latest = select(data), newer = !!latest && compare(latest.version, version) > 0;
        current = { installed: version, latest, newer, linked: !!linked, installable: newer && !linked && !!latest.digest, checkError: null, checkedAt: now() };
        succeeded = true;
      } catch (error) {
        if (signal?.aborted) { lastAttempt = null; parentAbort(signal); }
        const code = normalized(error, d.signal).code ?? 'network_error';
        current = { ...current, installable: false, checkError: code, checkedAt: now() };
        succeeded = false;
      } finally { d.close(); }
      return snapshot();
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  async function download({ version: requested, signal } = {}) {
    parentAbort(signal);
    if (linked) throw fail('linked_install');
    if (!semver(requested)) throw fail('invalid_version');
    const state = await check({ signal, refresh: true });
    if (state.checkError) throw fail('check_failed');
    if (!state.latest || state.latest.version !== requested) throw fail('release_changed');
    if (!state.newer) throw fail('not_newer');
    if (!state.latest.digest) throw fail('digest_missing');
    const release = state.latest;
    const d = deadline(signal, 120000);
    try {
      let url = release.url, response;
      for (let hops = 0; ; hops++) {
        d.signal.throwIfAborted();
        if (!safeHop(url)) throw fail('redirect_denied');
        response = await fetchImpl(url, { signal: d.signal, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (hops >= 5) throw fail('redirect_limit');
        if (!location || (/^[a-z]+:/i.test(location) && !safeHop(location)) || (location.startsWith('//') && !safeHop(`https:${location}`))) throw fail('redirect_denied');
        try { url = new URL(location, url).href; } catch { throw fail('redirect_denied'); }
        if (!safeHop(url)) throw fail('redirect_denied');
      }
      if (!response.ok) { await response.body?.cancel(); throw fail('http_error'); }
      const bytes = await readBounded(response, MAX, d.signal);
      if (bytes.length !== release.size) throw fail('size_mismatch');
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== release.digest) throw fail('digest_mismatch');
      return { release, bytes };
    } catch (error) { parentAbort(signal); throw normalized(error, d.signal); }
    finally { d.close(); }
  }
  return { check, download, status: snapshot };
}
