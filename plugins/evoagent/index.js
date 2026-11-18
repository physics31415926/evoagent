import { defineTool } from '@deepseek-ai/dsh-tools';
import { createTools } from './host.js';
import { mountUpdates } from './update-host.js';
export const name = 'evoagent';
export const inject = ['tools', 'llm'];
export async function apply(ctx, config = {}) {
  for (const tool of createTools(ctx.llm, defineTool)) ctx.effect(() => ctx.tools.register(tool));
  await mountUpdates(ctx, defineTool, config);
}
