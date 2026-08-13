/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Phase 1: `/pi-shepherd list` now uses discovery.ts. Subagent spawning
 * (Phase 2) and Herdr herding (Phase 4) land in later phases.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList } from "./discovery.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-shepherd", {
    description: "pi-shepherd: list | herd | <agent> <task> (subagents in Phase 2)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim();

      if (arg === "list" || arg === "agents") {
        // Default scope: user agents + bundled base. Pass an explicit scope to
        // include project agents (trust-gated) — see discovery.ts.
        const { agents } = discoverAgents(ctx.cwd, "user");
        const { text, remaining } = formatAgentList(agents, 20);
        ctx.ui?.notify(
          `pi-shepherd agents (user scope): ${text}${
            remaining > 0 ? ` (+${remaining} more)` : ""
          }`,
          "info",
        );
        return;
      }

      if (arg === "herd") {
        ctx.ui?.notify("pi-shepherd: Herdr herding not implemented yet (Phase 4).", "info");
        return;
      }

      ctx.ui?.notify(
        `pi-shepherd: try /pi-shepherd list, /pi-shepherd herd` +
          (arg ? ` (unhandled arg: ${arg})` : ""),
        "info",
      );
    },
  });
}
