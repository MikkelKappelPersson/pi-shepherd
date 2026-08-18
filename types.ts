import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
 description: 'Which agent directories to use. Default: "user".', default: "user",
});

export const StartParams = Type.Object({
 action: Type.Literal("start", { description: "Start an idle persistent agent; does not submit work." }),
 agent: Type.String({ description: "Exact discovered agent name (case-sensitive)." }),
 agentScope: Type.Optional(AgentScopeSchema),
 confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
 cwd: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
 omitSystemPrompt: Type.Optional(Type.Boolean()), timeout: Type.Optional(Type.Integer({ default: 120000 })),
});
export const LifecyclePromptParams = Type.Object({
 action: Type.Literal("prompt", { description: "Submit one message and return a prompt handle without waiting." }),
 handle: Type.Any({ description: "Serialized AgentHandle returned by start." }), message: Type.String(),
 timeout: Type.Optional(Type.Integer({ default: 120000 })),
});
export const WaitParams = Type.Object({
 action: Type.Literal("wait", { description: "Wait for one or more prompt handles; agents remain alive." }),
 handle: Type.Union([Type.Any(), Type.Array(Type.Any(), { minItems: 1 })]), timeout: Type.Optional(Type.Integer()),
});
export const LifecycleStatusParams = Type.Object({ action: Type.Literal("status"), handle: Type.Any() });
export const LifecycleCloseParams = Type.Object({ action: Type.Literal("close"), handle: Type.Any() });
