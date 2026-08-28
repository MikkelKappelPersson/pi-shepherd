import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

export const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description: 'Which agent-definition directories to use. Defaults to the persisted Shepherd setting; an explicit value overrides it.',
});

export const SpawnPlacementSchema = StringEnum(['pane_right', 'pane_down', 'tab', 'workspace'] as const, {
  description:
    'Optional placement: pane_right or pane_down splits the current pane, tab creates a new tab, and workspace creates a new workspace. If omitted, uses a background tab.',
});

export const SpawnParams = Type.Object({
  action: Type.Literal('spawn', {
    description: 'Spawn an idle persistent agent; does not submit work.',
  }),
  agent: Type.String({ description: 'Exact discovered agent name (case-sensitive). If unsure, call shepherd with action "agents" first.' }),
  label: Type.String({ description: 'Short task-specific human label for this spawned instance. Letters, numbers, spaces, _, -, and . only; max 64 characters.' }),
  placement: Type.Optional(SpawnPlacementSchema),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});
export const AgentIdSchema = Type.String({
  description: 'Opaque agent id returned by shepherd_spawn. Do not use a Herdr pane id.',
});
export const PromptIdSchema = Type.String({
  description: 'Opaque prompt id returned by shepherd_prompt. Do not use an agent id or Herdr pane id.',
});

export const LifecyclePromptParams = Type.Object({
  action: Type.Literal('prompt', {
    description: 'Submit one message to an agent and return a prompt id without waiting.',
  }),
  id: AgentIdSchema,
  message: Type.String({ description: 'Task or question to submit to the spawned agent. Submission returns immediately; use shepherd_wait for the result.' }),
  timeout: Type.Optional(Type.Integer({ default: 20, description: 'Optional readiness wait before submission; normally omit. It is capped at 15 seconds internally. The completion timeout belongs to shepherd_wait.' })),
});
export const WatchParams = Type.Object({
  action: Type.Literal('watch', {
    description: 'Register a non-blocking one-shot watcher for prompt completions.',
  }),
  id: Type.Union(
    [
      PromptIdSchema,
      Type.Array(PromptIdSchema, {
        minItems: 1,
        description: 'Array of opaque prompt ids; completions are reported as each prompt settles.',
      }),
    ],
    {
      description: 'One opaque prompt id or a non-empty array of prompt ids returned by shepherd_prompt.',
    }
  ),
});
export const WaitParams = Type.Object({
  action: Type.Literal('wait', {
    description: 'Wait for one or more prompt ids; agents remain alive.',
  }),
  id: Type.Union(
    [
      PromptIdSchema,
      Type.Array(PromptIdSchema, {
        minItems: 1,
        description: 'Array of opaque prompt ids for parallel waiting.',
      }),
    ],
    {
      description:
        'One opaque prompt id returned by shepherd_prompt, or an array of prompt ids for parallel work. Do not pass an agent id or pane id.',
    }
  ),
  timeout: Type.Optional(Type.Integer({ default: 20, description: 'Maximum time to wait for completion, in minutes (default: 20). Suggested: 1, 2, 5, 10, 20, 30, 60.' })),
});
export const LifecycleStatusParams = Type.Object({
  action: Type.Literal('status', { description: 'Inspect an agent without focusing or mutating its Herdr pane.' }),
  id: AgentIdSchema,
});
export const LifecycleCloseParams = Type.Object({
  action: Type.Literal('close', { description: 'Close an owned agent and cancel any unresolved prompt.' }),
  id: AgentIdSchema,
});
