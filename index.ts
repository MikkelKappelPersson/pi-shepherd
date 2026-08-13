/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Phase 0 stub: verifies extension discovery via the `/pi-shepherd` command.
 * Real tooling (subagent spawning, Herdr herding) lands in later phases.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-shepherd", {
    description: "pi-shepherd: list | herd | <agent> <task> (scaffold stub)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim();

      if (arg === "list") {
        ctx.ui?.notify("pi-shepherd: agent discovery not implemented yet (Phase 1).", "info");
        return;
      }

      if (arg === "herd") {
        ctx.ui?.notify("pi-shepherd: Herdr herding not implemented yet (Phase 4).", "info");
        return;
      }

      ctx.ui?.notify(
        `pi-shepherd scaffold online. Try /pi-shepherd list or /pi-shepherd herd.` +
          (arg ? ` (unhandled arg: ${arg})` : ""),
        "info",
      );
    },
  });
}
