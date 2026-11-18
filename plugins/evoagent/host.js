import { randomUUID } from 'node:crypto';
import { makePlan, explore } from './core.js';

const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
function proposalError(code) { return Object.assign(new Error(code), { evoCode: code }); }
const str = (description) => ({ type: 'string', required: true, description });
function owner(exec) {
  if (!exec.agent?.id) throw new Error('EvoAgent requires an agent session.');
  return exec.agent.id;
}

// All cache content is derived from normal tool inputs/results. Never authoritative memory.
export function createTools(llm, defineTool) {
  const sessions = new Map();
  function state(exec) {
    const key = owner(exec);
    if (!sessions.has(key)) {
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
      sessions.set(key, { plans: new Map(), runs: [] });
    }
    return sessions.get(key);
  }
  return [
    defineTool({
      name: 'evoagent_plan',
      description: 'Prepare and log exact model requests before exploration. No model calls. Review returned requests, then pass plan_id to evoagent_explore. Text results remain unverified; expression checks are sample-based, not proofs.',
      parameters: {
        task: { type: 'json', required: true, description: 'Object: id, prompt, kind (text or expression), optional numeric inputs and expected arrays. Expression expected values are never sent to models.' },
        strategies: { type: 'json', description: 'Optional array of up to 3 strategy names.' },
        max_tokens: { type: 'integer', description: 'Output-token ceiling per model call, 64–2048; default 512.' },
      }, output,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const s = state(exec);
        const maxTokens = args.max_tokens ?? 512;
        if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048) throw new Error('max_tokens must be 64–2048');
        const plan = makePlan({ task: args.task, strategies: args.strategies, maxTokens });
        const plan_id = randomUUID();
        if (s.plans.size >= 20) s.plans.delete(s.plans.keys().next().value);
        s.plans.set(plan_id, { plan, expires: Date.now() + 30 * 60_000 });
        return { plan_id, expires_in_seconds: 1800, ...plan, notice: 'Review requests before execution. At most one call per strategy. Verification samples are not a proof; no arbitrary code is executed.' };
      },
    }),
    defineTool({
      name: 'evoagent_explore',
      description: 'Execute a previously logged EvoAgent plan once using DSH configured provider/model (may incur cost). Up to 3 parallel calls, 120-second cooperative deadline. Does not train, activate policies, execute code, or retry. Ask user before paid calls when required.',
      parameters: { plan_id: str('ID from evoagent_plan in this agent session.'), provider: str('Configured DSH provider ID.'), model: str('Configured DSH model ID.') }, output,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        for (const k of ['provider', 'model']) if (typeof args[k] !== 'string' || !args[k].trim() || args[k].length > 200) throw new Error(`Invalid ${k}`);
        const s = state(exec), stored = s.plans.get(args.plan_id);
        if (!stored || stored.expires < Date.now()) throw new Error('Plan missing, expired, consumed, or plugin restarted. Run evoagent_plan again.');
        s.plans.delete(args.plan_id);
        const controller = new AbortController();
        const cancel = () => controller.abort(exec.signal.reason);
        exec.signal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('Exploration deadline exceeded')), 120_000);
        try {
          const result = await explore(stored.plan, async (request, maxTokens, signal) => {
            let text = '', usage = null, reason;
            for await (const chunk of llm.stream({ provider: args.provider, model: args.model, messages: request.messages, maxTokens, signal, purpose: 'evoagent-explore' })) {
              signal.throwIfAborted();
              if (chunk.type === 'text-delta') {
                text += chunk.text;
                if (text.length > 18000) throw proposalError('response_limit');
              }
              if (chunk.type === 'usage') usage = chunk.usage;
              if (chunk.type === 'finish') reason = chunk.reason;
            }
            signal.throwIfAborted();
            if (!['stop', 'max-tokens'].includes(reason)) throw proposalError('provider_error');
            let proposal;
            try { proposal = JSON.parse(text); } catch { throw proposalError('invalid_json'); }
            return { artifact: proposal.artifact, rationale: proposal.rationale, usage };
          }, { signal: controller.signal, maxCalls: 3 });
          const record = { ...result, provider: args.provider, model: args.model, plan_id: args.plan_id, cost: null, notice: 'Usage is provider-reported when available; cost is unknown. Sample pass is not a proof.' };
          s.runs.push(record);
          if (s.runs.length > 30) s.runs.shift();
          return record;
        } finally {
          clearTimeout(timer);
          exec.signal.removeEventListener('abort', cancel);
        }
      },
    }),
    defineTool({
      name: 'evoagent_records',
      description: 'Read cached exploration records for this agent only; no model calls. Cache may disappear on restart/eviction; durable source is the normal session tool log. No cross-session learning.',
      parameters: {}, output,
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        return { records: state(exec).runs, retention: 'Last 30 runs in this agent; volatile derived cache.' };
      },
    }),
  ];
}
