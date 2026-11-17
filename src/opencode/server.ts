/**
 * OpenCode server plugin entry (spec 013, Phase 2).
 *
 * Registers the Shepherd tool family and the `/shepherd` command against
 * the shared engine. Phase 2 surface: spawn/status/read/close plus the
 * herd/agents/prune umbrella (delegate/message/watch arrive in Phase 3).
 * Fieldnotes parent sessions arrive in Phase 4; settings are file-based
 * for now (see the carried-forward spec question).
 */

import { Plugin } from "@opencode/plugin"
import { installOpencodeHost } from "./host.ts"
import {
  closeSheep,
  listAgents,
  listHerd,
  pruneRegistrations,
  readSheep,
  spawnSheep,
  statusSheep,
  type OpencodeActionContext,
} from "./actions.ts"
import { parseShepherdCli, tokenizeCli } from "../extension/cli.ts"

installOpencodeHost()

/** Resolve the OpenCode session's working directory for engine calls. */
async function actionContext(ctx: any, sessionID: string): Promise<OpencodeActionContext> {
  try {
    const session = await ctx.session.get({ sessionID })
    const directory = (session as any)?.directory
    if (typeof directory === "string" && directory.length > 0) return { cwd: directory, sessionId: sessionID }
  } catch {
    // Fall through to the plugin location, then the process cwd.
  }
  return { cwd: ctx.location?.directory ?? process.cwd(), sessionId: sessionID }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error")
}

const PLACEMENT_DESC =
  "Optional placement: pane_right or pane_down splits the current pane, tab creates a new tab, and workspace creates a new workspace. If omitted, uses a background tab."

export default Plugin.define({
  id: "shepherd",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "shepherd",
        description:
          "Shepherd control plane: list the live herd (agents in Herdr panes), list available agent definitions, or prune stale pane registrations. Lifecycle operations are separate tools: shepherd_spawn, shepherd_status, shepherd_read, shepherd_close.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["herd", "agents", "prune"],
              description: "herd: live agents. agents: definitions. prune: drop stale registrations.",
            },
            agentScope: {
              type: "string",
              enum: ["user", "project", "both"],
              description: "Which agent-definition directories to use (agents action only).",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          const action = (input as any).action
          if (action === "herd") return { content: await listHerd(actx) }
          if (action === "agents")
            return { content: await listAgents(actx, { agentScope: (input as any).agentScope }) }
          return { content: await pruneRegistrations(actx) }
        },
      })

      editor.add({
        name: "shepherd_spawn",
        description:
          "Spawn an idle, persistent agent in a Herdr pane (no task submitted). Provide a short task-specific label (for example: code review). Use shepherd with action agents first if you do not know an exact agent name. The result prints an opaque agent id; pass it to shepherd_status, shepherd_read, or shepherd_close. Never use a pane id where an agent id is expected.",
        input: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Exact discovered agent name (case-sensitive).",
            },
            label: {
              type: "string",
              description: "Short task-specific label (max 64 characters).",
            },
            placement: { type: "string", description: PLACEMENT_DESC },
            cwd: {
              type: "string",
              description: "Working directory for the child; defaults to the session cwd.",
            },
          },
          required: ["agent"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          return {
            content: await spawnSheep(actx, {
              agent: String((input as any).agent ?? ""),
              label: String((input as any).label ?? ""),
              placement: (input as any).placement,
              cwd: (input as any).cwd,
            }),
          }
        },
      })

      editor.add({
        name: "shepherd_status",
        description:
          "Inspect a spawned agent without focusing or mutating its pane. Reports process state plus the state of its active task (an idle process can own a waiting task).",
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Exact opaque agent id returned by shepherd_spawn. Never a pane id.",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          return { content: await statusSheep(actx, { id: String((input as any).id ?? "") }) }
        },
      })

      editor.add({
        name: "shepherd_read",
        description:
          "Read recent terminal output from a spawned agent for diagnostics. Accepts an agent name, pane id, or opaque agent id.",
        input: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Agent name, pane id, or opaque agent id of the target.",
            },
            lines: {
              type: "number",
              description: "Number of recent lines for read (default 40).",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          return {
            content: await readSheep(actx, {
              target: String((input as any).name ?? ""),
              lines: (input as any).lines,
            }),
          }
        },
      })

      editor.add({
        name: "shepherd_close",
        description:
          "Close an owned agent and cancel its active task. Only shepherd-created work is closed.",
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Exact opaque agent id returned by shepherd_spawn. Never a pane id.",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          return { content: await closeSheep(actx, { id: String((input as any).id ?? "") }) }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "shepherd",
        description: "Shepherd: agents | herd | spawn <agent> | status <target> | read <target>",
        execute: async ({ sessionID, prompt }: any) => {
          const actx = await actionContext(ctx, sessionID)
          const raw = String(prompt?.text ?? "").trim()
          if (!raw) {
            await ctx.session.prompt({
              sessionID,
              text: [
                "Shepherd settings are file-based in Phase 2: edit the user config or the",
                "project `.shepherd/config.json` directly. For herd operations use one of:",
                "agents, herd, spawn <agent>, status <target>, read <target>.",
              ].join("\n"),
            })
            return
          }
          const parsed = parseShepherdCli(tokenizeCli(raw))
          if ("error" in parsed) {
            await ctx.session.prompt({ sessionID, text: `Shepherd: ${parsed.error}` })
            return
          }
          try {
            const args = parsed.args as any
            let result: string
            switch (parsed.action) {
              case "herd":
                result = await listHerd(actx)
                break
              case "agents":
                result = await listAgents(actx, { agentScope: args.agentScope })
                break
              case "spawn":
                result = await spawnSheep(actx, {
                  agent: args.agent,
                  label: args.label ?? "",
                  placement: args.placement,
                  cwd: args.cwd,
                })
                break
              case "status":
                result = await statusSheep(actx, { id: args.id })
                break
              case "read":
                result = await readSheep(actx, { target: args.name, lines: args.lines })
                break
              default:
                result = `Shepherd: action "${parsed.action}" is not available from the command yet; use the shepherd_* tools.`
            }
            await ctx.session.prompt({ sessionID, text: `[shepherd ${parsed.action}]\n${result}` })
          } catch (error) {
            await ctx.session.prompt({ sessionID, text: `Shepherd command failed: ${errorText(error)}` })
          }
        },
      })
    })
  },
})
