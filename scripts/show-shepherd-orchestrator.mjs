#!/usr/bin/env node
/**
 * Inspect the model-facing Shepherd tool registration used by the parent
 * (orchestrator) pi session.
 *
 * Usage:
 *   node --experimental-strip-types scripts/show-shepherd-orchestrator.mjs
 *   node --experimental-strip-types scripts/show-shepherd-orchestrator.mjs --json
 *
 * Note: Shepherd is registered as a tool. Its description and parameter schema
 * are sent as tool metadata; they are not persisted as a normal conversation
 * message. Pi adds promptSnippet and promptGuidelines to the textual system
 * prompt when the tool is active.
 */

import process from "node:process";
import {
	SHEPHERD_TOOL_DESCRIPTION,
	SHEPHERD_TOOL_PROMPT_GUIDELINES,
	SHEPHERD_TOOL_PROMPT_SNIPPET,
	ShepherdParams,
} from "../shepherd.ts";

const json = process.argv.includes("--json");
const help = process.argv.includes("--help") || process.argv.includes("-h");
if (help || process.argv.slice(2).some((arg) => arg !== "--json")) {
	console.log(`Usage: show-shepherd-orchestrator [--json]

Prints the exact model-facing Shepherd tool description and parameter schema.
`);
	process.exit(help ? 0 : 2);
}

const registration = {
	name: "shepherd",
	label: "Shepherd (delegate & manage Herdr agents)",
	description: SHEPHERD_TOOL_DESCRIPTION,
	promptSnippet: SHEPHERD_TOOL_PROMPT_SNIPPET,
	promptGuidelines: SHEPHERD_TOOL_PROMPT_GUIDELINES,
	parameters: ShepherdParams,
};

if (json) {
	console.log(JSON.stringify(registration, null, 2));
	process.exit(0);
}

console.log("=== Parent/orchestrator Shepherd tool ===");
console.log(`Name: ${registration.name}`);
console.log(`Label: ${registration.label}`);
console.log("\n=== Textual system-prompt contribution ===\n");
console.log(`Available tools entry: - shepherd: ${registration.promptSnippet}`);
console.log("Guidelines:");
for (const guideline of registration.promptGuidelines) console.log(`- ${guideline}`);
console.log("\n=== Tool description ===\n");
console.log(registration.description);
console.log("\n=== Tool parameter schema ===\n");
console.log(JSON.stringify(registration.parameters, null, 2));
