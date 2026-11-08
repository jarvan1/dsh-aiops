import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  executeToolBatch,
  ToolExecutionPipeline,
} from '@deepseek-ai/dsh-tools/pipeline'
import type {
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
  ToolModelInput,
} from '@deepseek-ai/dsh-tools'

/**
 * DSH 0.2.x splits tool execution out of the tool registry: `ctx.tools` only
 * stores definitions, and a deployment-level plugin must contribute a
 * `ToolExecutor` through `tools.setExecutor()` before any call runs. Real
 * compositions get one from the agent runtime; these Loader compositions
 * install this minimal pass-through executor so the tools under test execute
 * through the shared policy pipeline.
 */
export function installTestToolExecutor(ctx: Context): void {
  const pipeline = new ToolExecutionPipeline(ctx)
  const executor: ToolExecutor = {
    describe(tools: readonly ToolDefinition[]): ToolModelInput {
      return {
        schemas: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        knownNames: tools.map(tool => tool.name),
      }
    },
    execute(input) {
      return executeToolBatch(input, pipeline, () => 4)
    },
  }
  ctx.tools.setExecutor(executor)
}

let callCounter = 0

/**
 * DSH 0.2.x `ctx.tools.execute` only accepts a raw model batch; run one call
 * through it and return the settled execution-local result.
 */
export async function executeTestTool(
  ctx: Context,
  call: {
    name: string
    arguments: unknown
    signal?: AbortSignal
    agent?: unknown
    /** Stable id when the tool derives idempotency from the call id. */
    callId?: string
  },
): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: ToolCallId(call.callId ?? `test-call-${++callCounter}`),
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    }],
    signal: call.signal ?? new AbortController().signal,
    ...(call.agent === undefined ? {} : { agent: call.agent as never }),
  })
  const outcome = batch.results[0]
  if (outcome === undefined) throw new Error(`tool "${call.name}" produced no result`)
  return outcome.result
}
