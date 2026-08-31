#!/usr/bin/env node
/**
 * Phase 1 — discovery verification harness.
 *
 * Exercises discoverAgents() across the fixture tree in test/fixtures and
 * asserts precedence + scope filtering across the user/project locations.
 *
 * How user dirs are controlled: discovery.ts resolves user dirs via
 * getAgentDir() (= $HOME/.pi/agent) and os.homedir() (= $HOME/.agents). Both
 * read $HOME at call time, so we set process.env.HOME to the fixture "home"
 * BEFORE the dynamic import, then call discoverAgents().
 *
 * The bundled base dirs (pi-shepherd's own .pi/agents and .agents/agents) are
 * package-fixed and cannot be injected; they contain no named agents yet, so
 * we only assert they are reported in projectDirs.
 *
 * Run: node --experimental-strip-types test/verify-discovery.mjs
 * (node >= 22.6 with type stripping; a `test` script is also wired in package.json)
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");

// Point user dirs at the fixture "home" BEFORE importing discovery.
process.env.HOME = path.join(fixtures, "home");

const { discoverAgents, formatAgentList, normalizeModel, resolveDelegatedModel } = await import("../src/core/discovery.ts");

let failures = 0;
function assert(cond, label, extra = "") {
  if (cond) {
    console.log(`PASS  ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const proj = path.join(fixtures, "proj");

function namesOf(r) {
  return r.agents.map((a) => a.name).sort();
}
function descOf(r, name) {
  const a = r.agents.find((x) => x.name === name);
  return a ? a.description : undefined;
}

// --- user scope: only user-level agents, no project agents -----------------
const user = discoverAgents(proj, "user");
assert(!!descOf(user, "same")?.includes("user1-same"), "user scope: 'same' -> user1 version");
assert(!!descOf(user, "only-user"), "user scope: includes only-user");
assert(!!descOf(user, "shared-only"), "user scope: includes shared-only (user2)");
assert(!descOf(user, "project-pi"), "user scope: excludes project-pi");
assert(!descOf(user, "proj-shared"), "user scope: excludes proj-shared");
assert(resolveDelegatedModel("default", { provider: "test-provider", id: "test-model" }) === "test-provider/test-model", "model: default sentinel inherits parent");
assert(resolveDelegatedModel("explicit/model", { provider: "test-provider", id: "test-model" }) === "explicit/model", "model: explicit model still wins");
const omitTrue = user.agents.find((a) => a.name === "omit-true");
const omitFalse = user.agents.find((a) => a.name === "omit-false");
const omitInvalid = user.agents.find((a) => a.name === "omit-invalid");
const omitPiDocs = user.agents.find((a) => a.name === "omit-pi-docs");
const omitContextTrue = user.agents.find((a) => a.name === "omit-context-true");
const omitContextFalse = user.agents.find((a) => a.name === "omit-context-false");
const omitContextInvalid = user.agents.find((a) => a.name === "omit-context-invalid");
const omitContextAbsent = user.agents.find((a) => a.name === "omit-context-absent");
assert(omitTrue?.omitSystemPrompt === true, "frontmatter: strict true is retained");
assert(omitFalse?.omitSystemPrompt === false, "frontmatter: strict false is retained");
assert(omitInvalid?.omitSystemPrompt === undefined, "frontmatter: quoted true is ignored");
assert(omitPiDocs?.omitPiDocumentation === true, "frontmatter: omit-pi-documentation true is retained");
assert(user.agents.find((a) => a.name === "only-user")?.omitPiDocumentation === false, "frontmatter: omit-pi-documentation defaults false");
assert(user.agents.find((a) => a.name === "only-user")?.userInvocable === true, "frontmatter: user-invocable is retained");
assert(user.agents.find((a) => a.name === "omit-context-absent")?.userInvocable === true, "frontmatter: user-invocable defaults true");
assert(omitContextTrue?.omitContextFiles === true, "frontmatter: omit-context-files strict true is retained");
assert(omitContextFalse?.omitContextFiles === false, "frontmatter: omit-context-files strict false is retained");
assert(omitContextInvalid?.omitContextFiles === false, "frontmatter: omit-context-files quoted true is ignored");
assert(omitContextAbsent?.omitContextFiles === false, "frontmatter: omit-context-files defaults false");
assert(normalizeModel("  anthropic/claude  ") === "anthropic/claude", "frontmatter: model is trimmed");
assert(normalizeModel("   ") === undefined && normalizeModel(null) === undefined, "frontmatter: empty/null model inherits");
assert(user.agents.find((a) => a.name === "model-explicit")?.model === "anthropic/claude-sonnet-4-5", "frontmatter: explicit model is retained");
assert(user.agents.find((a) => a.name === "model-empty")?.model === undefined, "frontmatter: empty model is normalized for inheritance");
assert(resolveDelegatedModel(undefined, { provider: "openai", id: "gpt-4o" }) === "openai/gpt-4o", "model: parent provider/id inherited");
assert(resolveDelegatedModel(" custom/model ", { provider: "openai", id: "gpt-4o" }) === "custom/model", "model: explicit agent wins");
assert(resolveDelegatedModel(undefined, undefined) === undefined, "model: absent parent omitted");

// --- project scope: only project agents ------------------------------------
const project = discoverAgents(proj, "project");
assert(!!descOf(project, "project-pi"), "project scope: includes project-pi");
assert(!!descOf(project, "proj-shared"), "project scope: includes proj-shared");
assert(!descOf(project, "only-user"), "project scope: excludes only-user (user)");
assert(!descOf(project, "shared-only"), "project scope: excludes shared-only (user)");
assert(!!descOf(project, "same")?.includes("proj-pi-same"), "project scope: 'same' -> proj-pi version");

// --- both scope: precedence user1 > user2 > project ------------------------
const both = discoverAgents(proj, "both");
assert(!!descOf(both, "only-user"), "both scope: includes only-user");
assert(!!descOf(both, "proj-shared"), "both scope: includes proj-shared");
assert(!!descOf(both, "project-pi"), "both scope: includes project-pi");
assert(!!descOf(both, "same")?.includes("user1-same"), "both scope: 'same' -> user1 wins over user2+project");

// bundled base dirs are resolved and reported (package-fixed, no named agents yet)
const bundledInDirs = both.projectDirs.some((d) => d.includes(".pi") || d.includes(".agents"));
assert(bundledInDirs, "both scope: bundled base dirs reported in projectDirs", JSON.stringify(both.projectDirs));

// formatAgentList sanity
const fmt = formatAgentList(both.agents, 2);
assert(typeof fmt.text === "string" && fmt.remaining >= 0, "formatAgentList returns text+remaining");

console.log("\nSummary: user=", namesOf(user).join(","), "| project=", namesOf(project).join(","), "| both=", namesOf(both).join(","));
if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
process.exit(0);
