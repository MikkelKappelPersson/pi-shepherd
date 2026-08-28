#!/usr/bin/env node
import assert from 'node:assert/strict';
import { LifecycleRegistry } from '../src/core/orchestration.ts';
import { PromptWatcherService, promptWatcherService } from '../src/core/lifecycle.ts';
import { lifecycleRegistry } from '../src/core/orchestration.ts';
import { registerShepherdTools } from '../src/extension/shepherd.ts';

const registry = new LifecycleRegistry();
const agent = registry.registerAgent({ agent: 'worker', label: 'watch test' });
const first = registry.createPrompt(agent);
const events = [];
const service = new PromptWatcherService(registry, event => events.push(event), 5, 5);

const registration = service.watch(first.id);
assert.equal(registration.promptIds.length, 1);
assert.deepEqual(registration.pending, [first.id]);
assert.deepEqual(registration.completed, []);
registry.settlePrompt(first, { promptId: first.id, agentId: first.agentId, status: 'done', ok: true, text: 'finished' });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(events.length, 1, 'settlement produces one notification');
assert.equal(events[0].watcherId, registration.watcherId);
assert.equal(events[0].completions[0].promptId, first.id);
assert.equal(events[0].completions[0].agentId, agent.id);
assert.equal(events[0].completions[0].label, 'watch test');
assert.equal(events[0].completions[0].text, 'finished');
assert.equal(events[0].completions[0].returnCode, 0);

// A completion that predates registration is returned immediately, not sent
// again as an asynchronous duplicate.
const completedRegistration = service.watch(first.id);
assert.deepEqual(completedRegistration.completed.map(result => result.promptId), [first.id]);
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(events.length, 1, 'already-settled prompt is not duplicated');

const second = registry.createPrompt(agent);
const thirdAgent = registry.registerAgent({ agent: 'scout' });
const third = registry.createPrompt(thirdAgent);
const arrayRegistration = service.watch([second.id, third.id]);
assert.deepEqual(arrayRegistration.pending, [second.id, third.id]);
registry.settlePrompt(third, { promptId: third.id, agentId: third.agentId, status: 'failed', ok: false, error: 'nope' });
registry.settlePrompt(second, { promptId: second.id, agentId: second.agentId, status: 'blocked', ok: false });
await new Promise(resolve => setTimeout(resolve, 20));
const arrayEvent = events.find(event => event.watcherId === arrayRegistration.watcherId);
assert.ok(arrayEvent, 'array watcher receives a completion notification');
assert.deepEqual(arrayEvent.completions.map(result => result.promptId), [second.id, third.id], 'coalesced completions preserve watch input order');
assert.equal(arrayEvent.completions[0].returnCode, 2);
assert.equal(arrayEvent.completions[1].returnCode, 1);

service.shutdown();

// The extension bridge sends a custom follow-up, never a synthetic user
// message, and preserves structured completion details.
const sent = [];
let registeredMessageRenderer;
registerShepherdTools({
  registerTool() {},
  registerMessageRenderer(customType, renderer) {
    assert.equal(customType, 'shepherd.prompt.completion');
    registeredMessageRenderer = renderer;
  },
  sendMessage(message, options) {
    sent.push({ message, options });
  },
});
const bridgeAgent = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'bridge' });
const bridgePrompt = lifecycleRegistry.createPrompt(bridgeAgent);
promptWatcherService.watch(bridgePrompt.id);
lifecycleRegistry.settlePrompt(bridgePrompt, {
  promptId: bridgePrompt.id,
  agentId: bridgePrompt.agentId,
  status: 'done',
  ok: true,
  text: 'bridge result',
});
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(sent.length, 1, 'bridge sends one custom completion message');
assert.equal(typeof registeredMessageRenderer, 'function');
const renderedNotification = registeredMessageRenderer(
  sent[0].message,
  { expanded: false, outputPad: 0 },
  { fg: (_color, text) => text, bold: text => text, bg: (_color, text) => text },
);
assert.ok(
  renderedNotification
    .render(200)
    .some(line => line.trimEnd() === 'shepherd_watcher completion: planner: bridge done'),
);
assert.equal(sent[0].message.customType, 'shepherd.prompt.completion');
assert.equal(sent[0].message.details.completions[0].promptId, bridgePrompt.id);
assert.equal(sent[0].message.details.completions[0].agentId, bridgeAgent.id);
const notificationFirstLine = sent[0].message.content.split('\n')[0];
assert.equal(notificationFirstLine, 'shepherd_watcher completion: planner: bridge done');
assert.doesNotMatch(notificationFirstLine, /shepherd-(?:watch|prompt)-/);
assert.match(sent[0].message.content, /\ncall:\n    shepherd_watch \{"id":".*"\}/);
assert.match(sent[0].message.content, /\nreturn:\n    \[\{"promptId":"/);
assert.match(sent[0].message.content, /\ndetails:\n/);
assert.doesNotMatch(sent[0].message.content, /Process the structured completion details/);
assert.deepEqual(sent[0].options, { deliverAs: 'followUp', triggerTurn: true });
promptWatcherService.shutdown();
console.log('All watcher assertions passed.');
