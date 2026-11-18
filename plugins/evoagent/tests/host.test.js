import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../host.js';
const signal = () => new AbortController().signal;
const task = { id: 'linear', prompt: 'Return 2*x+1', kind: 'expression', inputs: [0, 2], expected: [1, 5] };
function harness(stream) {
  const tools = Object.fromEntries(createTools({ stream }, x => x).map(t => [t.name, t]));
  const agent = { id: Math.random().toString() };
  return (name, args, s = signal()) => tools[name].execute(args, { signal: s, agent });
}
test('explicit plan, one-shot execution, usage and records', async () => {
  let count = 0;
  const run = harness(async function* (opts) {
    count++;
    assert.equal(opts.provider, 'configured');
    assert.equal(opts.maxTokens, 512);
    assert.ok(!opts.messages[0].content[0].text.includes('expected'));
    yield { type: 'text-delta', text: '{"artifact":"2*x+1","rationale":"linear"}' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
    yield { type: 'finish', reason: 'stop' };
  });
  const p = await run('evoagent_plan', { task, strategies: ['direct', 'alternative'] });
  assert.equal(count, 0);
  const args = { plan_id: p.plan_id, provider: 'configured', model: 'test' };
  const result = await run('evoagent_explore', args);
  assert.equal(result.status, 'passed'); assert.equal(count, 2);
  assert.equal(result.usage.inputTokens, 20); assert.equal(result.cost, null);
  assert.equal((await run('evoagent_records', {})).records.length, 1);
  await assert.rejects(run('evoagent_explore', args), /Plan missing/);
});
test('malformed and error streams do not leak provider secrets', async () => {
  for (const stream of [async function* () { throw new Error('SECRET'); }, async function* () { yield { type: 'text-delta', text: 'not JSON' }; yield { type: 'finish', reason: 'stop' }; }]) {
    const run = harness(stream), p = await run('evoagent_plan', { task });
    const result = await run('evoagent_explore', { plan_id: p.plan_id, provider: 'p', model: 'm' });
    assert.equal(result.status, 'failed'); assert.equal(result.answer, null);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});
test('text remains unverified and other factory cannot consume plan', async () => {
  const stream = async function* () { yield { type: 'text-delta', text: '{"artifact":"answer"}' }; yield { type: 'finish', reason: 'stop' }; };
  const a = harness(stream), b = harness(stream);
  const p = await a('evoagent_plan', { task: { id: 'text', prompt: 'Research', kind: 'text' } });
  const args = { plan_id: p.plan_id, provider: 'p', model: 'm' };
  await assert.rejects(b('evoagent_explore', args), /Plan missing/);
  assert.equal((await a('evoagent_explore', args)).status, 'unverified');
});
test('parent cancellation reaches stream and quiesces', async () => {
  let active = 0;
  const controller = new AbortController();
  const run = harness(async function* ({ signal: s }) {
    active++;
    try {
      await new Promise(resolve => {
        s.addEventListener('abort', resolve, { once: true });
        if (active === 2) controller.abort(new Error('cancel'));
      });
      s.throwIfAborted();
    } finally { active--; }
  });
  const p = await run('evoagent_plan', { task, strategies: ['a', 'b'] });
  await assert.rejects(run('evoagent_explore', { plan_id: p.plan_id, provider: 'p', model: 'm' }, controller.signal), /cancel/);
  assert.equal(active, 0);
});
