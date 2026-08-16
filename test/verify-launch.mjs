#!/usr/bin/env node
/** Herdr-independent verification of delegated pi launch argument construction. */
import * as fs from "node:fs";

const { writePiLaunchFiles } = await import("../herdr.ts");
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}`); }
}
function check(label, omit, includeOption = true) {
  const name = label;
  const options = {
    name,
    task: "do the task",
    systemPrompt: "agent Markdown body",
    stayOpen: false,
    tools: ["read"],
  };
  if (includeOption) options.omitSystemPrompt = omit;
  let files;
  try {
    files = writePiLaunchFiles(options);
    const script = fs.readFileSync(files.scriptFile, "utf8");
    const task = fs.readFileSync(`${files.dir}/task-${name}.md`, "utf8");
    assert(script.includes("--append-system-prompt") === !omit, `${label}: append system prompt flag`);
    assert(script.includes("--system-prompt '") === !!omit, `${label}: replacement system prompt flag`);
    assert(script.includes(`'@${files.dir}/task-${name}.md'`), `${label}: task file argument`);
    assert(task.includes("do the task") && task.includes("shepherd_done"), `${label}: task and completion instructions`);
    assert(script.includes("shepherd-done.ts") && script.includes("--tools read,shepherd_done"), `${label}: completion extension wiring`);
    assert(fs.existsSync(`${files.dir}/sysprompt-${name}.md`), `${label}: system prompt file`);
    assert(fs.readFileSync(`${files.dir}/sysprompt-${name}.md`, "utf8") === "agent Markdown body", `${label}: prompt file content`);
  } finally {
    if (files) fs.rmSync(files.dir, { recursive: true, force: true });
  }
}
check("default", false);
check("implicit-default", false, false);
check("omit", true);
if (failures) process.exit(1);
console.log("All launch assertions passed.");
