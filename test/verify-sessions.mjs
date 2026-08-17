#!/usr/bin/env node
/** Filesystem-only verification for the Phase 1 sessions persistence layer. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const mod = await import("../sessions.ts");
const {
  slugifySessionName, slugifyAgentName, deriveSessionName,
  createOrResumeSession, reserveArtifacts, markArtifactStarted,
  finalizeArtifact, markArtifactStatus, updateSessionMoc, readSessionMetadata,
} = mod;
assert.equal((await import("../subagent.ts")).artifactTabLabel({ fileName: "scout-01.md" }), "scout-01");
assert.equal((await import("../subagent.ts")).artifactTabLabel({ fileName: "scout-02.md" }), "scout-02");
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (error) { failures++; console.log(`FAIL  ${label} — ${error.message}`); }
}
const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-sessions-"));

await check("safe deterministic session slug", () => {
  assert.equal(slugifySessionName(" Fix OAuth_Login! "), "fix-oauth-login");
  assert.equal(slugifySessionName("À very long name ".repeat(20)).length, 64);
  assert.equal(deriveSessionName(), "delegation");
  assert.equal(slugifyAgentName("Scout / unsafe"), "scout-unsafe");
});
await check("reject traversal and separators", () => {
  for (const value of ["../escape", "foo/bar", "foo\\bar", "/tmp/name", "..", "."]) {
    assert.throws(() => slugifySessionName(value));
  }
});

let first;
await check("create numbered session and metadata/MOC", () => {
  first = createOrResumeSession({ projectRoot: project, sessionName: "fix-oauth-login", mode: "single" });
  assert.equal(first.directoryName, "0001-fix-oauth-login");
  assert.equal(fs.existsSync(first.mocPath), true);
  assert.equal(fs.existsSync(first.sessionMetadataPath), true);
  assert.equal(fs.existsSync(path.join(project, ".shepherd", "shepherd.md")), false);
  const metadata = JSON.parse(fs.readFileSync(first.sessionMetadataPath, "utf8"));
  assert.equal(metadata.sessionName, "fix-oauth-login");
});
await check("same exact name resumes rather than duplicates", () => {
  const resumed = createOrResumeSession({ projectRoot: project, sessionName: "fix-oauth-login", mode: "parallel" });
  assert.equal(resumed.sessionPath, first.sessionPath);
  assert.equal(resumed.resumed, true);
  assert.equal(fs.readdirSync(path.join(project, ".shepherd", "sessions")).filter((x) => x.match(/^0001-/)).length, 1);
});
await check("same slug different names remain separate", () => {
  const other = createOrResumeSession({ projectRoot: project, sessionName: "fix oauth login", mode: "chain" });
  assert.notEqual(other.sessionPath, first.sessionPath);
  assert.equal(other.ordinal, 2);
  const otherMetadata = JSON.parse(fs.readFileSync(other.sessionMetadataPath, "utf8"));
  assert.equal(otherMetadata.sessionName, "fix oauth login");
  assert.match(other.directoryName, /^0002-fix-oauth-login-[0-9a-f]{8}$/);
});

let artifacts;
await check("reserve per-agent artifacts before execution with relative links", () => {
  artifacts = reserveArtifacts(first, [
    { agent: "Scout", mode: "parallel", task: "survey" },
    { agent: "Scout", mode: "parallel", task: "survey again" },
    { agent: "worker / unsafe", mode: "parallel" },
    { agent: "worker-unsafe", mode: "parallel" },
  ]);
  assert.deepEqual(artifacts.slice(0, 2).map((a) => a.fileName), ["scout-01.md", "scout-02.md"]);
  assert.equal(new Set(artifacts.map((a) => a.fileName)).size, artifacts.length);
  assert.ok(artifacts.every((a) => !path.isAbsolute(a.relativePath) && a.relativePath.includes(".shepherd")));
  const moc = fs.readFileSync(first.mocPath, "utf8");
  assert.match(moc, /\(\.\/scout-01\.md\)/);
  assert.match(moc, /\(\.\/scout-02\.md\)/);
  assert.match(moc, /Mode\(s\):\*\* single, parallel/);
  assert.match(fs.readFileSync(artifacts[0].filePath, "utf8"), /sessionName: fix-oauth-login/);
  assert.equal(fs.readdirSync(first.sessionPath).some((name) => name.includes(".tmp-")), false);
});
await check("lifecycle metadata and output/error persistence", () => {
  markArtifactStarted(first, artifacts[0], { pane: "test-pane" });
  finalizeArtifact(first, artifacts[0], { status: "completed", output: "survey output" });
  finalizeArtifact(first, artifacts[1], { status: "failed", error: "boom" });
  markArtifactStatus(first, artifacts[2], "timed-out", { reason: "deadline" });
  markArtifactStatus(first, artifacts[3], "cancelled");
  const firstText = fs.readFileSync(artifacts[0].filePath, "utf8");
  assert.match(firstText, /status: completed/);
  assert.match(firstText, /survey output/);
  assert.match(fs.readFileSync(artifacts[1].filePath, "utf8"), /boom/);
  const metadata = JSON.parse(fs.readFileSync(first.sessionMetadataPath, "utf8"));
  assert.deepEqual(metadata.artifacts.map((a) => a.status), ["completed", "failed", "timed-out", "cancelled"]);
});
await check("session remains resumable after failure", () => {
  const resumed = createOrResumeSession({ projectRoot: project, sessionName: "fix-oauth-login" });
  assert.equal(resumed.sessionPath, first.sessionPath);
  assert.equal(readSessionMetadata(first.sessionPath).sessionName, "fix-oauth-login");
  updateSessionMoc(resumed, { status: "completed" });
  assert.match(fs.readFileSync(first.mocPath, "utf8"), /Status:\*\* completed/);
});

// Child processes contend on the same project root.  The allocator's .alloc
// mkdir tokens must make every ordinal unique.
await check("chain mode is retained across continuation", () => {
  const resumed = createOrResumeSession({ projectRoot: project, sessionName: "fix-oauth-login", mode: "chain" });
  const metadata = JSON.parse(fs.readFileSync(resumed.sessionMetadataPath, "utf8"));
  assert.deepEqual(metadata.modes, ["single", "parallel", "chain"]);
  assert.match(fs.readFileSync(resumed.mocPath, "utf8"), /Mode\(s\):\*\* single, parallel, chain/);
});

await check("concurrent numbering uses unique ordinals", async () => {
  const concurrentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-concurrent-"));
  const script = `import { createOrResumeSession } from ${JSON.stringify(path.resolve("sessions.ts"))}; createOrResumeSession({projectRoot:process.argv[1],sessionName:process.argv[2]});`;
  const jobs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, concurrentRoot, `name-${i}`], { stdio: "ignore" });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  }));
  await Promise.all(jobs);
  const dirs = fs.readdirSync(path.join(concurrentRoot, ".shepherd", "sessions")).filter((x) => /^\d{4,}-/.test(x));
  assert.equal(dirs.length, 8);
  assert.equal(new Set(dirs.map((x) => x.split("-")[0])).size, 8);
  assert.equal(fs.existsSync(path.join(concurrentRoot, ".shepherd", "sessions", ".alloc", "0001")), true);
});

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll session assertions passed.");
