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
  description: 'Exact opaque agent id returned by shepherd_spawn. Copy it verbatim; do not use an agent name (such as "planner"), display label, Herdr pane id, or placeholder such as "<planner agent ID>".',
});
export const PromptIdSchema = Type.String({
  description: 'Opaque prompt id returned by shepherd_prompt. Do not use an agent id or Herdr pane id.',
});
export const TaskIdSchema = Type.String({
  description: 'Opaque task id returned by shepherd_delegate. Do not use an agent id or Herdr pane id.',
});

export const LifecycleDelegateParams = Type.Object({
  action: Type.Literal('delegate', {
    description: 'Start tracked asynchronous work on a spawned agent and return a task id without waiting.',
  }),
  target: AgentIdSchema,
  task: Type.String({ description: 'Non-empty delegated task description.' }),
  timeout: Type.Optional(Type.Integer({ default: 20, description: 'Optional task deadline in minutes.' })),
});

export const LifecyclePromptParams = Type.Object({
  action: Type.Literal('prompt', {
    description: 'Deprecated compatibility path: submits one message to an agent and returns a prompt id without waiting. For tracked work, prefer shepherd_delegate (task) + shepherd_watch; shepherd_prompt ties completion to one child turn, so it cannot carry work that must survive peer replies.',
  }),
  id: AgentIdSchema,
  message: Type.String({ description: 'Task or question to submit to the spawned agent. Submission returns immediately; use shepherd_watch for the result.' }),
  timeout: Type.Optional(Type.Integer({ default: 20, description: 'Optional readiness wait before submission; normally omit. It is capped at 15 seconds internally. Completion is reported asynchronously by shepherd_watch.' })),
});
export const WatchParams = Type.Object({
  action: Type.Literal('watch', {
    description: 'Register a non-blocking one-shot watcher for task completions (legacy prompt ids are also accepted).',
  }),
  id: Type.Union(
    [
      TaskIdSchema,
      PromptIdSchema,
      Type.Array(
        Type.Union([TaskIdSchema, PromptIdSchema]),
        {
          minItems: 1,
          description: 'Array of opaque task (or legacy prompt) ids; completions are reported as each settles.',
        }
      ),
    ],
    {
      description: 'One opaque task id (preferred) or legacy prompt id, or a non-empty array of such ids returned by shepherd_delegate (or shepherd_prompt).',
    }
  ),
});
export const LifecycleMessageParams = Type.Object({
  action: Type.Literal('message', {
    description: 'Send one asynchronous message to an agent and return a message id without waiting.',
  }),
  target: AgentIdSchema,
  message: Type.String({ description: 'Non-empty message content.' }),
  taskId: Type.Optional(TaskIdSchema),
  threadId: Type.Optional(Type.String({ description: 'Conversation/thread correlation id.' })),
  replyTo: Type.Optional(Type.String({ description: 'Message id of the request being answered.' })),
  expectsReply: Type.Optional(Type.Boolean({ description: 'Track this message as a request that expects a reply.' })),
  delivery: Type.Optional(
    Type.Union(
      [Type.Literal('followUp'), Type.Literal('steer')],
      { description: 'Delivery mode; followUp is the default, steer is for urgent input.' }
    )
  ),
});
export const LifecycleStatusParams = Type.Object({
  action: Type.Literal('status', { description: 'Inspect an agent without focusing or mutating its Herdr pane.' }),
  id: AgentIdSchema,
});
export const LifecycleCloseParams = Type.Object({
  action: Type.Literal('close', { description: 'Close an owned agent and cancel any unresolved prompt.' }),
  id: AgentIdSchema,
});
