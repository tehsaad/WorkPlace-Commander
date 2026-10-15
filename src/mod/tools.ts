/**
 * The tools Claude can call: the shared coordination tools
 * (src/coordination/tools.ts) typed for the Claude Code host. Each maps onto
 * one `wsc` invocation; the CLI is the single write path, so a tool call and
 * an external agent's CLI or MCP call are held to the same locking and the
 * same protocol rules.
 */
import type { ToolSpec } from 'claude-code'

import { COORDINATION_TOOLS } from '../coordination/tools.ts'

export interface ToolDef {
  spec: ToolSpec
  /** Builds the wsc argv from the model's input. */
  args: (input: Record<string, unknown>) => string[]
}

export const TOOLS: Record<string, ToolDef> = Object.fromEntries(
  Object.entries(COORDINATION_TOOLS)
    .filter(([, tool]) => !tool.surfaces || tool.surfaces.includes('mod'))
    .map(([name, tool]) => [name, { spec: tool.spec as ToolSpec, args: tool.args }]),
)

export const TOOL_NAMES = Object.keys(TOOLS)
