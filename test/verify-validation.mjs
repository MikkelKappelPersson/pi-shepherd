#!/usr/bin/env node
/** Verify delegation-name preflight keeps names exact and validates batches atomically. */

const { executeDelegation, unknownDelegationAgentNames } = await import("../subagent.ts");
const { mkdtemp, readdir, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

let failures = 0;
function assert(condition, label) {
	if (condition) console.log(`PASS  ${label}`);
	else {
		failures++;
		console.log(`FAIL  ${label}`);
	}
}

const agents = [
	{ name: "scout" },
	{ name: "Worker" },
];

assert(
	unknownDelegationAgentNames({ agent: "scout" }, agents).length === 0,
	"single mode accepts an exact discovered name",
);
assert(
	JSON.stringify(unknownDelegationAgentNames({ agent: "worker" }, agents)) === JSON.stringify(["worker"]),
	"agent names are case-sensitive and aliases are rejected",
);
assert(
	JSON.stringify(
		unknownDelegationAgentNames(
			{ tasks: [{ agent: "scout" }, { agent: "missing" }, { agent: "Worker" }, { agent: "missing" }] },
			agents,
		),
	) === JSON.stringify(["missing"]),
	"parallel validation checks every requested name and de-duplicates errors",
);
assert(
	JSON.stringify(unknownDelegationAgentNames({ chain: [{ agent: "missing-a" }, { agent: "missing-b" }] }, agents)) ===
		JSON.stringify(["missing-a", "missing-b"]),
	"chain validation checks all steps before execution",
);

const tempProject = await mkdtemp(join(tmpdir(), "pi-shepherd-validation-"));
try {
	const result = await executeDelegation(
		{
			tasks: [
				{ agent: "missing-one", task: "first" },
				{ agent: "missing-two", task: "second" },
			],
			agentScope: "user",
		},
		undefined,
		undefined,
		{ cwd: tempProject, hasUI: false },
	);
	assert(result.isError === true, "parallel unknown names return a tool error");
	assert(
		result.content[0]?.type === "text" &&
			result.content[0].text.includes('"missing-one"') &&
			result.content[0].text.includes('"missing-two"'),
		"parallel error reports every unknown name",
	);
	const entries = await readdir(tempProject);
	assert(!entries.includes(".shepherd"), "unknown names create no session or artifact directory");
} finally {
	await rm(tempProject, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
console.log("\nAll assertions passed.");
