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
const HandleObjectOptions = { additionalProperties: true } as const;

/** Handles may be passed as the returned object, JSON text, or opaque id. */
export const AgentHandleInputSchema = Type.Union([
 Type.Object({
  id: Type.String({ description: "Opaque agent handle id returned by start." }),
  agent: Type.Optional(Type.String()), paneId: Type.Optional(Type.String()),
  tabId: Type.Optional(Type.String()), workspaceId: Type.Optional(Type.String()),
 }, HandleObjectOptions),
 Type.String({ description: "AgentHandle JSON text or opaque agent handle id." }),
]);
export const PromptHandleInputSchema = Type.Union([
 Type.Object({
  id: Type.String({ description: "Opaque prompt handle id returned by prompt." }),
  agentId: Type.Optional(Type.String()), createdAt: Type.Optional(Type.Number()),
 }, HandleObjectOptions),
 Type.String({ description: "PromptHandle JSON text or opaque prompt handle id." }),
]);

export const LifecyclePromptParams = Type.Object({
 action: Type.Literal("prompt", { description: "Submit one message and return a prompt handle without waiting." }),
 handle: AgentHandleInputSchema,
 message: Type.String({ description: "Message to submit to the started agent." }),
 timeout: Type.Optional(Type.Integer({ default: 120000 })),
});
export const WaitParams = Type.Object({
 action: Type.Literal("wait", { description: "Wait for one or more prompt handles; agents remain alive." }),
 handle: Type.Union([PromptHandleInputSchema, Type.Array(PromptHandleInputSchema, { minItems: 1 })]),
 timeout: Type.Optional(Type.Integer()),
});
export const LifecycleStatusParams = Type.Object({
 action: Type.Literal("status"), handle: AgentHandleInputSchema,
});
export const LifecycleCloseParams = Type.Object({
 action: Type.Literal("close"), handle: AgentHandleInputSchema,
});
