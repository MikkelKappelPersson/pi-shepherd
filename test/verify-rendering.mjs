#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  formatExpandedToolResult,
  formatParentMessageNotification,
  formatCollapsedNotification,
  renderCollapsedLifecycleResult,
  formatStaleWaitNotification,
  formatWatcherNotification,
  styleExpandedToolResult,
} from '../src/extension/shepherd.ts';

const spawnResult = {
  content: [{ type: 'text', text: 'shepherd_spawn spawned worker: code review' }],
  details: {
    call: {
      name: 'shepherd_spawn',
      arguments: {
        agent: 'worker',
        label: 'code review',
        placement: 'tab',
      },
    },
    id: 'shepherd-agent-123',
    agent: 'worker',
    label: 'code review',
    model: 'github-copilot/gpt-5.6-luna',
    returnValue: {
      id: 'shepherd-agent-123',
      agent: 'worker',
      label: 'code review',
      model: 'github-copilot/gpt-5.6-luna',
    },
    fieldnote: '.shepherd/sessions/secret',
    artifactSession: { parentSessionId: 'secret' },
    returnCode: 0,
  },
};
assert.equal(
  formatExpandedToolResult(spawnResult),
  [
    'call',
    'agent: worker',
    'label: code review',
    'placement: tab',
    '',
    'return',
    'status: spawned',
    'agent id: shepherd-agent-123',
    'model: github-copilot/gpt-5.6-luna',
  ].join('\n'),
  'spawn expanded output uses minimal headers, spacing, and curated return fields'
);
console.log('PASS spawn expanded output has minimal spaced call/return sections');

const plainTheme = {
  fg: (_color, text) => text,
  bold: text => text,
};
const collapsedStatus = renderCollapsedLifecycleResult(
  {
    content: [{ type: 'text', text: 'agent done.\n\ncall:\n    shepherd_status {}' }],
    details: { call: { name: 'shepherd_status' }, returnCode: 0 },
  },
  'shepherd_status',
  plainTheme,
  {}
);
assert.equal(collapsedStatus, 'agent done.');
console.log('PASS collapsed status results hide protocol call/return/details text');

const expandedStatus = formatExpandedToolResult({
  content: [{ type: 'text', text: 'agent working; task shepherd-task-status running.' }],
  details: {
    call: { name: 'shepherd_status', arguments: { id: 'shepherd-agent-status' } },
    returnValue: {
      id: 'shepherd-agent-status',
      state: 'working',
      task: { id: 'shepherd-task-status', state: 'running' },
    },
    status: {
      id: 'shepherd-agent-status',
      state: 'working',
      task: { id: 'shepherd-task-status', state: 'running' },
    },
    returnCode: 0,
  },
});
assert.equal(
  expandedStatus,
  [
    'call',
    'id: shepherd-agent-status',
    '',
    'return',
    'status: working',
    'task:',
    '  id: shepherd-task-status',
    '  state: running',
  ].join('\n')
);
console.log('PASS expanded status results remove duplicated status metadata');

const expandedCompletedWatch = formatExpandedToolResult({
  content: [{ type: 'text', text: 'watch completed' }],
  details: {
    call: { name: 'shepherd_watch', arguments: { id: 'shepherd-task-123' } },
    returnValue: {
      watcherId: 'shepherd-watcher-123',
      pending: [],
      completed: [{
        taskId: 'shepherd-task-123',
        agentId: 'shepherd-agent-123',
        status: 'completed',
        returnCode: 0,
        text: 'First line\nSecond line',
        artifact: { id: 'large/session-note.md', task: 'omit this metadata' },
      }],
    },
    returnCode: 0,
  },
});
assert.match(expandedCompletedWatch, /completions:\n/);
assert.match(expandedCompletedWatch, /text:\nFirst line\nSecond line/);
assert.doesNotMatch(expandedCompletedWatch, /omit this metadata|artifact:/);
console.log('PASS expanded completed watcher results omit artifact metadata and preserve text blocks');

const collapsedHerd = renderCollapsedLifecycleResult(
  {
    content: [{ type: 'text', text: '• pi (self/focused) ●(shepherd) [working] pane=w1:p1 cwd=/private' }],
    details: {
      call: { name: 'shepherd' },
      agents: [{ name: 'pi', state: 'working', focused: true, shepherd: true, paneId: 'w1:p1', cwd: '/private' }],
      returnCode: 0,
    },
  },
  'shepherd',
  plainTheme,
  {}
);
assert.equal(collapsedHerd, 'Active agents: 1');
assert.doesNotMatch(collapsedHerd, /pane=|cwd=|pi \(self\/focused\)/);
console.log('PASS collapsed herd results show only the active-agent count');

const collapsedAgents = renderCollapsedLifecycleResult(
  {
    content: [{ type: 'text', text: 'Available agent names (copy the name exactly; names are case-sensitive):' }],
    details: {
      call: { name: 'shepherd' },
      scope: 'both',
      agents: [
        { name: 'planner', description: 'Creates plans' },
        { name: 'reviewer', description: 'Reviews code' },
        { name: 'worker', description: 'Does work' },
      ],
      returnCode: 0,
    },
  },
  'shepherd',
  plainTheme,
  {}
);
assert.equal(collapsedAgents, 'Available agents: planner, reviewer, worker');
const styledCollapsedAgents = renderCollapsedLifecycleResult(
  {
    content: [{ type: 'text', text: 'Available agent names:' }],
    details: { call: { name: 'shepherd' }, scope: 'both', agents: [{ name: 'planner' }], returnCode: 0 },
  },
  'shepherd',
  {
    bold: text => `<bold>${text}</bold>`,
    fg: (color, text) => `<${color}>${text}</${color}>`,
  },
  {}
);
assert.equal(styledCollapsedAgents, '<accent>Available agents:</accent> <toolOutput>planner</toolOutput>');
console.log('PASS collapsed available-agent labels use accent styling');

const expandedHerd = formatExpandedToolResult({
  content: [{ type: 'text', text: '• pi (self/focused) [working]' }],
  details: {
    call: { name: 'shepherd', arguments: { agentScope: 'both' } },
    agents: [
      { name: 'pi', state: 'working', focused: true, shepherd: true },
      { name: 'pi', state: 'idle', focused: false, shepherd: false },
    ],
    returnCode: 0,
  },
});
assert.match(expandedHerd, /agents:\n  agent id: shepherd\n    state: working/);
assert.doesNotMatch(expandedHerd, /\n\s+- /);
assert.doesNotMatch(expandedHerd, /paneId|cwd/);
console.log('PASS expanded herd arrays keep each item marker beside its first field');

const spawnWithoutOptionalPlacement = structuredClone(spawnResult);
delete spawnWithoutOptionalPlacement.details.call.arguments.placement;
assert.doesNotMatch(
  formatExpandedToolResult(spawnWithoutOptionalPlacement),
  /placement:/,
  'absent optional spawn placement is omitted'
);
console.log('PASS optional call arguments are omitted when absent');

const messageResult = {
  content: [{ type: 'text', text: 'Message queued to worker' }],
  details: {
    call: {
      name: 'shepherd_message',
      arguments: {
        target: 'shepherd-agent-123',
        message: 'First line\nStatus: pending\nThird line',
      },
    },
    returnValue: {
      messageId: 'shepherd-message-123',
      accepted: true,
      delivery: 'queued',
    },
    returnCode: 0,
  },
};
const messageExpanded = formatExpandedToolResult(messageResult);
assert.match(messageExpanded, /call\ntarget: shepherd-agent-123\nmessage:\nFirst line\nStatus: pending\nThird line\n\nreturn\nstatus: queued/);
console.log('PASS multiline message content uses a raw copy-friendly block');

const theme = {
  bold: text => `<bold>${text}</bold>`,
  fg: (color, text) => `<${color}>${text}</${color}>`,
};
const styledMessage = styleExpandedToolResult(messageExpanded, theme);
assert.match(styledMessage, /<accent>message:<\/accent>/);
assert.match(styledMessage, /<toolOutput>Status: pending<\/toolOutput>/);
assert.doesNotMatch(styledMessage, /<accent>Status:/);
assert.match(styledMessage, /<bold>call<\/bold>/);
assert.match(styledMessage, /<bold>return<\/bold>/);
console.log('PASS raw message lines stay normal while headers and labels are styled');

const longSingleLine = 'A long single-line message that should wrap naturally in the terminal without introducing explicit line breaks.';
const longMessage = formatExpandedToolResult({
  content: [{ type: 'text', text: 'Message queued to worker' }],
  details: {
    call: { name: 'shepherd_message', arguments: { target: 'shepherd-agent-123', message: longSingleLine } },
    returnValue: { messageId: 'shepherd-message-long', delivery: 'queued' },
    returnCode: 0,
  },
});
assert.match(longMessage, new RegExp(`message:\\n${longSingleLine.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n\\nreturn`));
console.log('PASS long single-line messages stay single-line in the raw block');

const parentMessage = formatParentMessageNotification({
  kind: 'reply',
  senderId: 'shepherd-agent-123',
  messageId: 'shepherd-message-123',
  taskId: 'shepherd-task-123',
  threadId: 'shepherd-message-001',
  replyTo: 'shepherd-message-000',
  content: 'Reply line one\nReply line two',
});
assert.match(parentMessage, /^Shepherd reply from shepherd-agent-123\n\nmessage id:/);
assert.match(parentMessage, /reply to: shepherd-message-000\n\nmessage:\nReply line one\nReply line two/);
assert.doesNotMatch(parentMessage, /\ncall:\n|\nreturn:\n|\ndetails:/);
const styledParentMessage = styleExpandedToolResult(parentMessage, theme, { boldFields: ['message'] });
assert.match(styledParentMessage, /<bold>message:<\/bold>/);
assert.match(styledParentMessage, /<accent>message id:<\/accent>/);
console.log('PASS incoming replies use spacious metadata and a bold message label');
const collapsedReply = formatCollapsedNotification({
  details: {
    messageId: 'shepherd-message-123',
    senderId: 'shepherd-agent-123',
    content: 'Reply line one\nReply line two',
  },
}, parentMessage);
assert.equal(collapsedReply, 'Shepherd reply from shepherd-agent-123\nReply line one Reply line two');
const collapsedLongReply = formatCollapsedNotification({
  details: {
    messageId: 'shepherd-message-long',
    content: 'A very long message '.repeat(20),
  },
}, parentMessage);
assert.equal(collapsedLongReply.split('\n').length, 2);
assert.ok(collapsedLongReply.split('\n')[1].endsWith('…'));
assert.ok(collapsedLongReply.split('\n')[1].length <= 160);
console.log('PASS collapsed incoming replies show a concise sender and message summary');

const watcher = formatWatcherNotification({
  watcherId: 'shepherd-watcher-123',
  taskIds: ['shepherd-task-123'],
  completions: [{
    taskId: 'shepherd-task-123',
    agentId: 'shepherd-agent-123',
    status: 'completed',
    text: 'Finished the task.\nSecond line of the result.',
    returnCode: 0,
    artifact: { id: 'session/worker-01.md', task: 'large durable metadata' },
  }],
}, 'task');
assert.match(watcher, /^Shepherd watcher/);
assert.match(watcher, /watcher id: shepherd-watcher-123/);
assert.match(watcher, /completions:/);
assert.match(watcher, /text:\nFinished the task\.\nSecond line of the result\./);
assert.doesNotMatch(watcher, /large durable metadata|artifact:/);
assert.doesNotMatch(watcher, /\ncall:\n|\nreturn:\n|\ndetails:/);
console.log('PASS watcher notifications use structured human-readable fields');

const stale = formatStaleWaitNotification({
  taskId: 'shepherd-task-123',
  agentId: 'shepherd-agent-123',
  agent: 'worker',
  label: 'code review',
  elapsedMs: 61000,
  thresholdMinutes: 1,
  description: 'Review the implementation.',
  question: 'Should the notification be reformatted?',
  requestMessageId: 'shepherd-message-000',
  recipientName: 'planner',
});
assert.match(stale, /^Shepherd stale wait/);
assert.match(stale, /question:\nShould the notification be reformatted\?/);
assert.match(stale, /actions:\n/);
console.log('PASS stale-wait notifications use readable raw question/action blocks');

console.log('All rendering assertions passed.');
