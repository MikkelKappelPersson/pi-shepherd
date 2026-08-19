import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

export const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description: 'Which agent directories to use. Default: "user".',
  default: 'user',
});

export const StartParams = Type.Object({
  action: Type.Literal('start', {
    description: 'Start an idle persistent agent; does not submit work.',
  }),
  agent: Type.String({ description: 'Exact discovered agent name (case-sensitive).' }),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  omitSystemPrompt: Type.Optional(Type.Boolean()),
});
const HandleObjectOptions = { additionalProperties: true } as const;

/**
 * Lifecycle actions have one public handle representation: the complete
 * handle object returned by the preceding action's `details.handle`.
 *
 * The canonical protocol is object-only. The model-facing tool has a narrow
 * prepareArguments compatibility step for transports that encode this nested
 * field as JSON text before schema validation; callers should still pass the
 * native object and never stringify it themselves.
 */
export const AgentHandleInputSchema = Type.Object(
  {
    id: Type.String({ description: 'Handle id from details.handle returned by start.' }),
    agent: Type.Optional(Type.String()),
    paneId: Type.Optional(Type.String()),
    tabId: Type.Optional(Type.String()),
    workspaceId: Type.Optional(Type.String()),
  },
  {
    ...HandleObjectOptions,
    description: 'The complete AgentHandle object returned in details.handle by start.',
  }
);
export const PromptHandleInputSchema = Type.Object(
  {
    id: Type.String({ description: 'Handle id from details.handle returned by prompt.' }),
    agentId: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.Number()),
  },
  {
    ...HandleObjectOptions,
    description: 'The complete PromptHandle object returned in details.handle by prompt.',
  }
);

export const LifecyclePromptParams = Type.Object({
  action: Type.Literal('prompt', {
    description: 'Submit one message and return a prompt handle without waiting.',
  }),
  handle: AgentHandleInputSchema,
  message: Type.String({ description: 'Message to submit to the started agent.' }),
  timeout: Type.Optional(Type.Integer({ default: 20, description: 'Timeout in minutes (default: 20). Suggested: 1, 2, 5, 10, 20, 30, 60 minutes' })),
});
export const WaitParams = Type.Object({
  action: Type.Literal('wait', {
    description: 'Wait for one or more prompt handles; agents remain alive.',
  }),
  handle: Type.Union(
    [
      PromptHandleInputSchema,
      Type.Array(PromptHandleInputSchema, {
        minItems: 1,
        description: 'Native array of complete PromptHandle objects for parallel wait.',
      }),
    ],
    {
      description:
        'One complete PromptHandle object, or a native array of complete PromptHandle objects.',
    }
  ),
  timeout: Type.Optional(Type.Integer({ default: 20, description: 'Timeout in minutes (default: 20). Suggested: 1, 2, 5, 10, 20, 30, 60 minutes' })),
});
export const LifecycleStatusParams = Type.Object({
  action: Type.Literal('status'),
  handle: AgentHandleInputSchema,
});
export const LifecycleCloseParams = Type.Object({
  action: Type.Literal('close'),
  handle: AgentHandleInputSchema,
});
