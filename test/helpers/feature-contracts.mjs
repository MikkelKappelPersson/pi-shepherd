/**
 * Phase 0 contract placeholders for the task/messaging test suite.
 *
 * These are intentionally data-only. They describe the future model-facing
 * surface without registering tools or changing runtime behavior. Later phase
 * tests should import these contracts instead of duplicating strings.
 */
export const plannedToolContracts = Object.freeze({
  shepherd_delegate: Object.freeze({
    surface: 'parent',
    rootType: 'object',
    required: Object.freeze(['target', 'task']),
  }),
  shepherd_message: Object.freeze({
    surface: 'parent-and-child',
    rootType: 'object',
    required: Object.freeze(['target', 'message']),
  }),
  shepherd_done: Object.freeze({
    surface: 'child',
    rootType: 'object',
    required: Object.freeze(['taskId', 'status']),
  }),
  shepherd_watch: Object.freeze({
    surface: 'parent',
    rootType: 'object',
    required: Object.freeze(['id']),
  }),
});

export const plannedTaskStates = Object.freeze([
  'created',
  'running',
  'waiting',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timed_out',
]);

export const plannedParentOnlyTools = Object.freeze([
  'shepherd_delegate',
  'shepherd_watch',
]);

export const plannedChildOnlyTools = Object.freeze([
  'shepherd_done',
]);
