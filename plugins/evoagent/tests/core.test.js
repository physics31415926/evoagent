import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, verify, explore } from '../core.js';

const textTask = { id: 'text', prompt: 'Write a short greeting', kind: 'text' };
const exprTask = { id: 'expression', prompt: 'Find the square of x', kind: 'expression', inputs: [0, 2, -3], expected: [0, 4, 9] };
const exprPlan = (strategies = ['first', 'second', 'third']) => makePlan({ task: exprTask, strategies });

test('plan has the required request format and does not send validation data', () => {
  const task = { ...exprTask, inputs: [987654.321], expected: [123456.789] };
  const plan = makePlan({ task, memories: [{ task_id: 'old', artifact: 'x*x', secret: 'never-send-me', inputs: task.inputs, expected: task.expected }] });
  assert.equal(plan.version, 1);
  assert.equal(plan.task.id, task.id);
  assert.equal(plan.maxTokens, 1024);
  assert.equal(plan.requests[0].messages[0].role, 'user');
  const messages = JSON.stringify(plan.requests);
  assert.match(messages, /untrusted/i);
  assert.match(messages, /JSON object/);
  assert.match(messages, /artifact/);
  assert.match(messages, /rationale/);
  assert.match(messages, /x\*x/);
  for (const secret of ['987654.321', '123456.789', 'never-send-me', 'expected', 'inputs']) assert.ok(!messages.includes(secret));
  task.inputs[0] = 0;
  assert.equal(plan.task.inputs[0], 987654.321);
});

test('text answers always remain unverified', () => {
  const evidence = verify({ ...textTask, expected: 'hello' }, 'hello');
  assert.equal(evidence.status, 'unverified');
  assert.equal(evidence.score, null);
  assert.equal(evidence.verifier, 'none');
});

test('safe expression grammar, precedence, scientific numbers and tolerance', () => {
  for (const artifact of ['x*x', 'x**2', '(+x) * (x)', 'x**(1+1)', '1e0*x*x']) assert.equal(verify(exprTask, artifact).status, 'passed', artifact);
  assert.equal(verify({ ...exprTask, inputs: [2], expected: [-4] }, '-x**2').status, 'passed');
  assert.equal(verify({ ...exprTask, inputs: [1], expected: [512] }, '2**3**2').status, 'passed');
  assert.equal(verify({ ...exprTask, inputs: [1], expected: [1] }, '1.000000001').status, 'passed');
  assert.equal(verify(exprTask, 'x').status, 'failed');
});

test('expression parser rejects code, invalid arithmetic and resource abuse', () => {
  const invalid = [
    'process.exit()', 'globalThis.x', 'Math.pow(x,2)', 'x;1', '(()=>1)()', '[1][0]', 'x=1', 'NaN', 'Infinity',
    '1/0', '0/0', '(-1)**.5', 'x**13', '2**-13', '1e13', '1e999', '1000000000000*2',
    '('.repeat(21) + 'x' + ')'.repeat(21), '-'.repeat(21) + 'x', 'x+'.repeat(64) + 'x', 'x'.repeat(257), 'x x', 'x+', '()',
  ];
  for (const artifact of invalid) {
    const evidence = verify(exprTask, artifact);
    assert.equal(evidence.status, 'failed', artifact);
    assert.equal(evidence.score, 0);
    assert.ok(!JSON.stringify(evidence).includes('process.exit'));
  }
});

test('validates task, strategy, memory, token limits and bounded proposal strings', async () => {
  for (const task of [null, {}, { ...textTask, kind: 'shell' }, { ...textTask, prompt: 'x'.repeat(8001) }, { ...exprTask, inputs: [Infinity] }, { ...exprTask, expected: [] }, { ...exprTask, inputs: [] }]) assert.throws(() => makePlan({ task }), TypeError);
  for (const strategies of [[], ['a', 'b', 'c', 'd'], ['x'.repeat(101)], [3]]) assert.throws(() => makePlan({ task: textTask, strategies }), TypeError);
  for (const memories of [Array(6).fill({}), [null], 'bad']) assert.throws(() => makePlan({ task: textTask, memories }), TypeError);
  for (const maxTokens of [0, -1, 1.5, Infinity, '3']) assert.throws(() => makePlan({ task: textTask, maxTokens }), TypeError);
  const plan = makePlan({ task: textTask });
  for (const response of [{ artifact: 'x'.repeat(16001) }, { artifact: 'fine', rationale: 'x'.repeat(2001) }, {}, null]) {
    const run = await explore(plan, async () => response);
    assert.equal(run.status, 'failed');
    assert.equal(run.answer, null);
  }
});

test('explore runs requests concurrently, forwards budget and deduplicates in strategy order', async () => {
  const plan = exprPlan();
  const controller = new AbortController();
  let started = 0;
  const releases = [];
  const promise = explore(plan, (request, maxTokens, signal) => {
    started++;
    assert.equal(maxTokens, plan.maxTokens);
    assert.equal(signal, controller.signal);
    return new Promise((resolve) => releases.push(() => resolve({ artifact: request.strategy === 'third' ? 'x**2' : ' x*x ', rationale: 'candidate', usage: { inputTokens: 10, outputTokens: 2 } })));
  }, { signal: controller.signal });
  assert.equal(started, 3);
  releases.reverse().forEach((release) => release());
  const run = await promise;
  assert.equal(run.calls, 3);
  assert.equal(run.status, 'passed');
  assert.equal(run.answer, ' x*x ');
  assert.equal(run.attempts[1].duplicate_of, run.attempts[0].id);
  assert.equal(run.attempts[2].duplicate_of, null);
  assert.deepEqual(run.usage, { inputTokens: 30, outputTokens: 6 });
  assert.equal(new Set(run.attempts.map((attempt) => attempt.id)).size, 3);
});

test('failed proposals and thrown errors cannot become selected answers or leak messages', async () => {
  const run = await explore(exprPlan(), async (request) => {
    if (request.strategy === 'first') throw new Error('SECRET credential');
    return { artifact: request.strategy === 'second' ? 'process.exit()' : 'x**2' };
  });
  assert.equal(run.answer, 'x**2');
  assert.equal(run.status, 'passed');
  assert.equal(run.usage, null);
  assert.ok(!JSON.stringify(run).includes('SECRET credential'));
  assert.equal(run.attempts[0].evidence.details.type, 'proposal_error');
  const failed = await explore(exprPlan(), async () => ({ artifact: 'x' }));
  assert.equal(failed.answer, null);
  assert.equal(failed.status, 'failed');
});

test('text runs select unverified output and never invent usage', async () => {
  const run = await explore(makePlan({ task: textTask }), async () => ({ artifact: 'hello' }));
  assert.equal(run.answer, 'hello');
  assert.equal(run.status, 'unverified');
  assert.equal(run.usage, null);
});

test('maxCalls caps calls, has no retries, and validates plan budgets', async () => {
  let calls = 0;
  const run = await explore(exprPlan(), async () => { calls++; throw new Error('failure'); }, { maxCalls: 1 });
  assert.equal(calls, 1);
  assert.equal(run.calls, 1);
  assert.equal(run.attempts.length, 1);
  for (const maxCalls of [0, 7, -1, 1.5, '2']) await assert.rejects(explore(exprPlan(), async () => ({}), { maxCalls }), TypeError);
  await assert.rejects(explore({ ...exprPlan(), requests: Array(4).fill(exprPlan().requests[0]) }, async () => ({})), TypeError);
  await assert.rejects(explore({ ...exprPlan(), maxTokens: 0 }, async () => ({})), TypeError);
});

test('abort before and during proposal propagates the original reason', async () => {
  const before = new AbortController();
  const reason = new Error('cancelled');
  before.abort(reason);
  let calls = 0;
  await assert.rejects(explore(exprPlan(), async () => { calls++; }, { signal: before.signal }), (error) => error === reason);
  assert.equal(calls, 0);
  const during = new AbortController();
  const releases = [];
  let finished = false;
  const pending = explore(exprPlan(), () => new Promise((resolve) => releases.push(resolve)), { signal: during.signal });
  const checked = pending.finally(() => { finished = true; });
  const rejection = assert.rejects(checked, (error) => error === reason);
  during.abort(reason);
  releases[0]({ artifact: 'x**2' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'abort must await outstanding proposal completion');
  releases[1]({ artifact: 'x**2' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  releases[2]({ artifact: 'x**2' });
  await rejection;
  assert.equal(finished, true);
  const abortError = Object.assign(new Error('transport cancelled'), { name: 'AbortError' });
  await assert.rejects(explore(exprPlan(), async () => { throw abortError; }), (error) => error === abortError);
});
