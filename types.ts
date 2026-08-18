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

/**
 * Lifecycle actions have one public handle representation: the complete
 * handle object returned by the preceding action's `details.handle`.
 *
 * Do not add string/JSON alternatives here. Besides making the protocol
 * ambiguous, those alternatives cause an array of handles to be stringified
 * by some model/tool transports and then misinterpreted as one handle.
 */
export const AgentHandleInputSchema = Type.Object({
 id: Type.String({ description: "Handle id from details.handle returned by start." }),
 agent: Type.Optional(Type.String()), paneId: Type.Optional(Type.String()),
 tabId: Type.Optional(Type.String()), workspaceId: Type.Optional(Type.String()),
}, {
 ...HandleObjectOptions,
 description: "The complete AgentHandle object returned in details.handle by start; do not pass an id or JSON string.",
});
export const PromptHandleInputSchema = Type.Object({
 id: Type.String({ description: "Handle id from details.handle returned by prompt." }),
 agentId: Type.Optional(Type.String()), createdAt: Type.Optional(Type.Number()),
}, {
 ...HandleObjectOptions,
 description: "The complete PromptHandle object returned in details.handle by prompt; do not pass an id or JSON string.",
});

export const LifecyclePromptParams = Type.Object({
 action: Type.Literal("prompt", { description: "Submit one message and return a prompt handle without waiting." }),
 handle: AgentHandleInputSchema,
 message: Type.String({ description: "Message to submit to the started agent." }),
 timeout: Type.Optional(Type.Integer({ default: 120000 })),
});
export const WaitParams = Type.Object({
 action: Type.Literal("wait", { description: "Wait for one or more prompt handles; agents remain alive." }),
 handle: Type.Union([
  PromptHandleInputSchema,
  Type.Array(PromptHandleInputSchema, {
   minItems: 1,
   description: "Native array of complete PromptHandle objects for parallel wait; do not stringify the array.",
  }),
 ], {
  description: "One complete PromptHandle object, or a native array of complete PromptHandle objects.",
 }),
 timeout: Type.Optional(Type.Integer()),
});
export const LifecycleStatusParams = Type.Object({
 action: Type.Literal("status"), handle: AgentHandleInputSchema,
});
export const LifecycleCloseParams = Type.Object({
 action: Type.Literal("close"), handle: AgentHandleInputSchema,
});
