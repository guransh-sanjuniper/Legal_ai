import type { DocumentRecord } from '../runner/db';
import { makeTask } from '../tasks/make';
import { runTask } from '../runner/runTask';
import { splitInput } from '../tasks/split';
import type { Task } from '../tasks/types';
import { makeRunConfig, type ExecuteContext } from './execute';

export interface RetryOutcome {
  retried: number;
  splitInto: number;
  done: number;
  failed: number;
}

// Splits a failed unit until every piece is under maxChars, preferring line boundaries.
export function splitToSize(input: string, maxChars: number): string[] {
  if (input.length <= maxChars) return [input];
  const pair = splitInput(input, Math.max(200, Math.floor(maxChars / 2)));
  if (!pair) {
    return [input.slice(0, maxChars), ...splitToSize(input.slice(maxChars), maxChars)];
  }
  return [...splitToSize(pair[0], maxChars), ...splitToSize(pair[1], maxChars)];
}

// Retries only failed clause-analysis tasks. Oversized inputs are split before the retry, so a
// previously oversized unit cannot be sent again unchanged.
export async function retryFailedClauseTasks(
  ctx: ExecuteContext,
  doc: DocumentRecord,
  runId: string,
  opts: { limit?: number; maxChars?: number } = {},
): Promise<RetryOutcome> {
  const limit = opts.limit ?? 5;
  const maxChars = opts.maxChars ?? 4000;
  const cfg = makeRunConfig(ctx);
  const all = await ctx.db.getAllFromIndex('tasks', 'byRun', runId);
  const failed = all
    .filter((t) => t.status === 'failed' && /:(?:a|r)\d+(?:\/|$)/.test(t.id))
    .slice(0, limit);

  let retried = 0;
  let splitInto = 0;
  let done = 0;
  let failedCount = 0;

  for (const task of failed) {
    const pieces = splitToSize(task.input, maxChars);
    splitInto += pieces.length;
    const children: Task[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const child = await makeTask(
        {
          id: `${task.id}/retry${i}`,
          runId: task.runId,
          parentId: task.id,
          depth: task.depth + 1,
          docHash: task.docHash,
          prepFingerprint: task.prepFingerprint,
          promptVersion: task.promptVersion,
          prompt: task.prompt,
          input: pieces[i],
          maxTokens: Math.min(task.maxTokens, 1200),
        },
        Date.now(),
      );
      await ctx.db.put('tasks', child);
      children.push(child);
    }
    await ctx.db.put('tasks', { ...task, status: 'split', updatedAt: Date.now() });
    retried++;

    for (const child of children) {
      const fresh = await ctx.db.get('tasks', child.id);
      if (!fresh) continue;
      const outcome = await runTask(ctx.db, fresh, cfg);
      if (outcome === 'done') done++;
      else if (outcome === 'failed') failedCount++;
    }
  }

  return { retried, splitInto, done, failed: failedCount };
}
