import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater } from './updates.js';

const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
export function createUpdateTools(updater, defineTool, prepare) {
  let busy = false;
  return [defineTool({
    name: 'evoagent_update',
    description: 'Read status, check GitHub, or prepare a verified EvoAgent update. prepare requires human approval for the exact version and confirmed=true. Does NOT install. Pass returned installTarget to the official plugin_manager install_bundle tool, which enforces profile permissions. Local development links cannot be overwritten.',
    parameters: {
      action: { type: 'string', required: true, description: 'status (offline), check (network), or prepare (download only; never installs).' },
      version: { type: 'string', description: 'Exact version the human approved; required for prepare.' },
      confirmed: { type: 'boolean', description: 'True only after human explicitly approved downloading this exact version.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (args.action === 'status') return updater.status();
      if (args.action === 'check') return updater.check({ signal: exec.signal, refresh: true });
      if (args.action !== 'prepare') throw new Error('invalid_action');
      if (args.confirmed !== true || typeof args.version !== 'string') throw new Error('explicit_version_confirmation_required');
      if (busy) throw new Error('update_in_progress');
      busy = true;
      try {
        const { release, bytes } = await updater.download({ version: args.version, signal: exec.signal });
        exec.signal.throwIfAborted();
        const installTarget = await prepare(release, bytes, exec.signal);
        return { from: updater.status().installed, to: release.version, integrityVerified: true, installed: false, installTarget,
          notice: 'Download only. After human install approval, use official plugin_manager install_bundle with installTarget. Profile-wide change; obey applied/nextStep. Temporary file is retained in OS temp and may be cleaned by the OS; prepare again if missing.' };
      } finally { busy = false; }
    },
  })];
}

export async function mountUpdates(ctx, defineTool, { autoCheck = true } = {}) {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  let linked = true;
  try { linked = !/[\\/]node_modules[\\/]/.test(await realpath(fileURLToPath(import.meta.url))); } catch { /* fail closed */ }
  const updater = createUpdater({ version: manifest.version, linked });
  const dirs = new Set();
  let disposed = false;
  // Successful prepared packages survive disposal: the official installer may still be reading them.
  // Up to three per activation; OS temp cleanup owns their eventual removal.
  ctx.effect(() => () => { disposed = true; });
  const prepare = async (release, bytes, signal) => {
    if (disposed) throw new Error('plugin_disposed');
    if (dirs.size >= 3) throw new Error('prepared_update_limit_restart_plugin');
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evoagent-update-'));
    dirs.add(dir);
    try {
      const target = join(dir, release.name);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600, signal });
      signal.throwIfAborted();
      if (disposed) throw new Error('plugin_disposed');
      return target;
    } catch (error) { dirs.delete(dir); await rm(dir, { recursive: true, force: true }).catch(() => {}); throw error; }
  };
  for (const tool of createUpdateTools(updater, defineTool, prepare)) ctx.effect(() => ctx.tools.register(tool));
  if (autoCheck !== false) ctx.effect(() => {
    const controller = new AbortController();
    const check = () => { void updater.check({ signal: controller.signal }).catch(() => {}); };
    const first = setTimeout(check, 60_000);
    const interval = setInterval(check, 6 * 60 * 60_000);
    first.unref?.(); interval.unref?.();
    return () => { clearTimeout(first); clearInterval(interval); controller.abort(); };
  });
  return updater;
}
