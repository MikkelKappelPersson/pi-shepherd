/**
 * OpenCode server plugin entry (spec 013, Phase 3).
 *
 * Registers the Shepherd tool family and the `/shepherd` command against
 * the shared engine: spawn/delegate/message/watch/status/read/close plus
 * the herd/agents/prune umbrella, with the child shepherd_message and
 * shepherd_done tools served from the same surface (sheep sessions are
 * gated out of the parent tools, parent sessions out of shepherd_done).
 * Parent fieldnotes sessions resolve onto the shared `.shepherd/sessions`
 * layout (Phase 4); settings are file-based for now (see the carried-forward
 * spec question).
 */

import { Plugin } from "@opencode/plugin"
import { installOpencodeHost } from "./host.ts"
import {
  closeSheep,
  delegateSheep,
  listAgents,
  listHerd,
  messageSheep,
  pruneRegistrations,
  readSheep,
  sheepDone,
  sheepMessage,
  spawnSheep,
  statusSheep,
  watchSheep,
  type OpencodeActionContext,
} from "./actions.ts"
import { installOpencodeBridges, isSheepSession, markParentSession } from "./bridge.ts"
import { parseShepherdCli, tokenizeCli } from "../extension/cli.ts"
import { displayCommandOutput } from "./display.ts"
import { migrationNoticeOnce } from "../core/migration.ts"
import { noticeNewOrphans, reapOrphans } from "./orphans.ts"

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

/** Display a human-facing command result without starting an assistant turn. */
async function showCommandOutput(ctx: any, sessionID: string, text: string): Promise<void> {
  // Farewell notice for the old package name: human sessions only, once per
  // host user, and display-only like the rest of the command output.
  if (!isSheepSession(sessionID)) {
    const notice = migrationNoticeOnce()
    if (notice) text = `${notice}\n\n${text}`
  }
  try {
    await displayCommandOutput(ctx, sessionID, text)
  } catch (error) {
    // Never fall back to session.prompt here: that would reintroduce the turn.
    console.error(`shepherd: command display failed: ${errorText(error)}`)
  }
}

/**
 * Gate a parent-only tool: sheep sessions cannot orchestrate. Marks every
 * other caller as a parent session (sheep-only tools refuse those).
 */
function parentOnly(sessionID: string, tool: string): void {
  if (isSheepSession(sessionID)) {
    throw new Error(`${tool} is not available in sheep sessions; sheep use shepherd_message and shepherd_done.`)
  }
  markParentSession(sessionID)
}

const PLACEMENT_DESC =
  "Optional placement: pane_right or pane_down splits the current pane, tab creates a new tab, and workspace creates a new workspace. If omitted, uses a background tab."

export default Plugin.define({
  id: "shepherd",
  async setup(ctx) {
    installOpencodeBridges(ctx)
    // A reload loses in-memory sheep state but not the owned panes/terminals.
    // Surface them once per orphan set; never block tool registration on it.
    void noticeNewOrphans(ctx)
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "shepherd",
        description:
          "Shepherd control plane: list the live herd (agents in Herdr panes), list available agent definitions, prune stale registrations, or reap sheep orphaned by a server restart. Lifecycle operations are separate tools: shepherd_spawn, shepherd_status, shepherd_read, shepherd_close.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["herd", "agents", "prune", "reap"],
              description:
                "herd: live agents. agents: definitions. prune: drop stale registrations. reap: close sheep orphaned by a server restart.",
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
          parentOnly(context.sessionID, "shepherd")
          const actx = await actionContext(ctx, context.sessionID)
          const action = (input as any).action
          if (action === "herd") return { content: await listHerd(actx) }
          if (action === "agents")
            return { content: await listAgents(actx, { agentScope: (input as any).agentScope }) }
          if (action === "reap") return { content: reapOrphans(context.sessionID) }
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
            no_parent: {
              type: "boolean",
              description:
                "Herdr app / hc only: launch a separate parentless agent in its own tab instead of a subagent under the caller. Defaults to false. Ignored on the Herdr TUI backend.",
            },
            cwd: {
              type: "string",
              description: "Working directory for the child; defaults to the session cwd.",
            },
          },
          required: ["agent"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          parentOnly(context.sessionID, "shepherd_spawn")
          const actx = await actionContext(ctx, context.sessionID)
          return {
            content: await spawnSheep(actx, {
              agent: String((input as any).agent ?? ""),
              label: String((input as any).label ?? ""),
              placement: (input as any).placement,
              no_parent: (input as any).no_parent,
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
          parentOnly(context.sessionID, "shepherd_status")
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
          parentOnly(context.sessionID, "shepherd_read")
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
          parentOnly(context.sessionID, "shepherd_close")
          const actx = await actionContext(ctx, context.sessionID)
          return { content: await closeSheep(actx, { id: String((input as any).id ?? "") }) }
        },
      })

      editor.add({
        name: "shepherd_delegate",
        description:
          "Start tracked asynchronous work on a spawned agent and return a task id immediately. The task can span runs; use shepherd_watch to observe terminal completion. Nothing settles until the sheep calls shepherd_done (or the task fails, is cancelled, or times out).",
        input: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Exact opaque agent id returned by shepherd_spawn. Never a pane id.",
            },
            task: { type: "string", description: "Non-empty delegated task description." },
            timeout: {
              type: "number",
              description: "Optional task deadline in minutes (default 60).",
            },
          },
          required: ["target", "task"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          parentOnly(context.sessionID, "shepherd_delegate")
          const actx = await actionContext(ctx, context.sessionID)
          return {
            content: await delegateSheep(actx, {
              target: String((input as any).target ?? ""),
              task: String((input as any).task ?? ""),
              timeout: (input as any).timeout,
            }),
          }
        },
      })

      editor.add({
        name: "shepherd_watch",
        description:
          "Register a non-blocking one-shot watcher for task completions. Returns immediately; already-settled tasks are reported inline and pending completions arrive automatically. Accepts one task id or a non-empty array.",
        input: {
          type: "object",
          properties: {
            id: {
              anyOf: [
                { type: "string", description: "Opaque task id returned by shepherd_delegate." },
                {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  description: "Non-empty array of opaque task ids.",
                },
              ],
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          parentOnly(context.sessionID, "shepherd_watch")
          const actx = await actionContext(ctx, context.sessionID)
          return { content: await watchSheep(actx, { id: (input as any).id }) }
        },
      })

      editor.add({
        name: "shepherd_message",
        description:
          "Send one asynchronous message and return immediately. Parent form: target MUST be the exact opaque sheep agent id from shepherd_spawn; use expectsReply with a taskId to park the task until the reply arrives. Sheep form (delegated sheep sessions only): target parent/shepherd or a peer agent id; set taskId/replyTo from the delivered task text.",
        input: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description:
                "Parent form: exact opaque sheep agent id. Sheep form: parent, shepherd, or a peer agent id.",
            },
            message: { type: "string", description: "Non-empty message content." },
            taskId: { type: "string", description: "Active delegated task id, when this message belongs to a task." },
            threadId: { type: "string", description: "Conversation/thread correlation id." },
            replyTo: { type: "string", description: "Message id of the request being answered." },
            expectsReply: {
              type: "boolean",
              description: "Track this message as a request that expects a reply.",
            },
            delivery: {
              type: "string",
              enum: ["followUp", "steer"],
              description: "Delivery mode; followUp queues passively, steer is for urgent input.",
            },
          },
          required: ["target", "message"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          const args = {
            target: String((input as any).target ?? ""),
            message: String((input as any).message ?? ""),
            taskId: (input as any).taskId,
            threadId: (input as any).threadId,
            replyTo: (input as any).replyTo,
            expectsReply: (input as any).expectsReply,
            delivery: (input as any).delivery,
          }
          if (isSheepSession(context.sessionID)) {
            const result = await sheepMessage(actx, args, context.sessionID)
            if (result.parentPrompt && result.parentSessionId) {
              try {
                await ctx.session.prompt({ sessionID: result.parentSessionId, text: result.parentPrompt })
              } catch {
                result.text += " (parent notice delivery failed; the message itself was accepted)"
              }
            }
            return { content: result.text }
          }
          markParentSession(context.sessionID)
          return { content: await messageSheep(actx, args) }
        },
      })

      editor.add({
        name: "shepherd_done",
        description:
          "Sheep-only: explicitly complete, block, or fail the current delegated task. This is the only signal that tells the parent a tracked task has finished. Include the Task ID from the delegated task text.",
        input: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "Exact Task ID from the delegated task text (omit only to complete the sheep's open task).",
            },
            status: {
              type: "string",
              enum: ["completed", "blocked", "failed"],
              description: "Terminal status for the delegated task.",
            },
            summary: {
              type: "string",
              description: "Concise completion, blocked, or failure summary.",
            },
          },
          required: ["status"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const actx = await actionContext(ctx, context.sessionID)
          const result = await sheepDone(
            actx,
            {
              taskId: (input as any).taskId,
              status: String((input as any).status ?? ""),
              summary: (input as any).summary,
            },
            context.sessionID
          )
          return { content: result.text }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "shepherd",
        description: "Shepherd: agents | herd | spawn <agent> | status <target> | read <target>",
        execute: async ({ sessionID, prompt }: any) => {
          markParentSession(sessionID)
          const actx = await actionContext(ctx, sessionID)
          const raw = String(prompt?.text ?? "").trim()
          if (!raw) {
            await showCommandOutput(
              ctx,
              sessionID,
              [
                "Shepherd settings are file-based in Phase 2: edit the user config or the",
                "project `.shepherd/config.json` directly. For herd operations use one of:",
                "agents, herd, spawn <agent>, status <target>, read <target>.",
              ].join("\n")
            )
            return
          }
          const parsed = parseShepherdCli(tokenizeCli(raw))
          if ("error" in parsed) {
            await showCommandOutput(ctx, sessionID, `Shepherd: ${parsed.error}`)
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
            await showCommandOutput(ctx, sessionID, `[shepherd ${parsed.action}]\n${result}`)
          } catch (error) {
            await showCommandOutput(ctx, sessionID, `Shepherd command failed: ${errorText(error)}`)
          }
        },
      })
    })
  },
})
