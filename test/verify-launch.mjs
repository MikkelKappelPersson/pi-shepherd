#!/usr/bin/env node
/** Herdr-independent verification of delegated pi launch argument construction. */
import * as fs from "node:fs";

const { writePiLaunchFiles } = await import("../herdr.ts");
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}`); }
}
function check(label, omit, includeOption = true, model, omitContextFiles) {
  const name = label;
  const options = {
    name,
    task: "do the task",
    systemPrompt: "agent Markdown body",
    stayOpen: false,
    tools: ["read"],
    omitPiDocumentation: true,
  };
  if (model !== undefined) options.model = model;
  if (omitContextFiles !== undefined) options.omitContextFiles = omitContextFiles;
  if (includeOption) options.omitSystemPrompt = omit;
  let files;
  try {
    files = writePiLaunchFiles(options);
    const script = fs.readFileSync(files.scriptFile, "utf8");
    const task = fs.readFileSync(`${files.dir}/task-${name}.md`, "utf8");
    assert(script.includes("--append-system-prompt") === false, `${label}: no duplicate append system prompt flag`);
    assert(script.includes("--system-prompt '") === !!omit, `${label}: replacement system prompt flag`);
    assert(script.includes(`'@${files.dir}/task-${name}.md'`), `${label}: task file argument`);
    assert(task.includes("do the task") && task.includes("shepherd_done"), `${label}: task and completion instructions`);
    assert(script.includes("shepherd-done.ts") && script.includes("--tools read,shepherd_done"), `${label}: completion extension wiring`);
    assert(script.includes("PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE='"), `${label}: agent system prompt wiring`);
    assert(script.includes("PI_SHEPHERD_OMIT_PI_DOCUMENTATION=1"), `${label}: Pi documentation omission wiring`);
    assert(script.includes("--no-context-files") === (omitContextFiles === true), `${label}: context-file omission argument`);
    assert(script.includes("--model 'anthropic/claude-sonnet-4-5'") === (model !== undefined), `${label}: model argument`);
    assert(fs.existsSync(`${files.dir}/sysprompt-${name}.md`), `${label}: system prompt file`);
    assert(fs.readFileSync(`${files.dir}/sysprompt-${name}.md`, "utf8") === "agent Markdown body", `${label}: prompt file content`);
  } finally {
    if (files) fs.rmSync(files.dir, { recursive: true, force: true });
  }
}
check("default", false);
check("implicit-default", false, false);
check("omit", true);
check("context-true", false, true, undefined, true);
check("context-false", false, true, undefined, false);
check("context-absent", false, false);
check("model", false, true, "anthropic/claude-sonnet-4-5");
// Inheritance is resolved before launch; absent model must omit --model.
if (failures) process.exit(1);
console.log("All launch assertions passed.");
