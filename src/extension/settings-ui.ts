/**
 * Settings menu for pi-shepherd — rendered inline in the writing field slot,
 * exactly like pi's own `/settings`: a `SettingsList` framed by `DynamicBorder`s
 * (Pattern 3). When the command runs, the editor is replaced by the menu;
 * arrows navigate, Enter cycles a value, `/` fuzzy-searches, esc closes and the
 * editor comes back.
 *
 * The first item selects the *settings scope*: "user" (the user file) or
 * "project" (the `.shepherd/config.json` delta in the current directory).
 * The menu opens on the merged, effective values, so what it shows is exactly
 * what the system is using. Scope changes always save to the user file (it
 * owns the scope pointer); every other field saves to the current scope's
 * file (the project file stores only the delta).
 *
 * Alignment note: the SettingsList pads the label column to the widest label
 * (capped at 30). Keep every label ≤ 30 visible chars so the value column
 * stays aligned.
 *
 * Command: `/shepherd` with no arguments (or `/shepherd settings`).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import * as path from "node:path";
import {
	type ConfigScope,
	type ShepherdSettings,
	loadProjectDelta,
	loadSettings,
	saveSettings,
} from "./config.ts";

const TIMEOUT_CHOICES = [1, 2, 5, 10, 20, 30, 60];
const TIMEOUT_DISPLAY = (n: number) => `${n} min`;
// 0 disables stale-wait reminders; the rest are minutes.
const STALE_WAIT_CHOICES = [0, 1, 2, 5, 10, 15, 30];
const STALE_WAIT_DISPLAY = (n: number) => (n === 0 ? "off (no reminders)" : `${n} min`);

/** Translate a settings change (string value from the list) back into state. */
function applyValue(settings: ShepherdSettings, id: string, value: string): ShepherdSettings {
	const next = { ...settings };
	switch (id) {
		case "settingsScope":
			next.settingsScope = (value === "project" ? "project" : "user") as ConfigScope;
			break;
		case "agentScope":
			next.agentScope = value as ShepherdSettings["agentScope"];
			break;
		case "includeBundledAgents":
			next.includeBundledAgents = value === "on";
			break;
		case "confirmProjectAgents":
			next.confirmProjectAgents = value === "on";
			break;
		case "keepOpen":
			next.keepOpen = value === "on";
			break;
		case "stayOpen":
			next.stayOpen = value === "on";
			break;
		case "fieldnotes":
			next.fieldnotes = value === "on";
			break;
		case "emojiSheep":
			next.emojiSheep = value === "on";
			break;
		case "timeout": {
			// The list displays values as e.g. "30 min", so parse the
			// numeric portion rather than passing the decorated label to Number.
			const n = Number.parseInt(value, 10);
			if (Number.isFinite(n) && n > 0) next.timeout = n;
			break;
		}
		case "staleWaitThreshold": {
			const n = Number.parseInt(value, 10);
			// 0 (off) and values >= 1 are both valid; "off" stores 0, other
			// choices store their minute count.
			if (Number.isFinite(n) && n >= 0) next.staleWaitThreshold = n;
			break;
		}
	}
	return next;
}

function booleans(value: boolean): [string, string[]] {
	return value ? ["on", ["on", "off"]] : ["off", ["on", "off"]];
}

/** Render + drive the settings menu. */
export async function openSettings(ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	// Keep the in-memory state current while the menu is open. SettingsList can
	// invoke onChange multiple times in one session; applying every change to
	// the initial snapshot would otherwise discard earlier changes.
	let settings = loadSettings(cwd);
	const [keepOpenValue, keepOpenValues] = booleans(settings.keepOpen);
	const [stayOpenValue, stayOpenValues] = booleans(settings.stayOpen);
	const [fieldnotesValue, fieldnotesValues] = booleans(settings.fieldnotes);
	const [emojiSheepValue, emojiSheepValues] = booleans(settings.emojiSheep);
	const [bundledValue, bundledValues] = booleans(settings.includeBundledAgents);
	const [confirmValue, confirmValues] = booleans(settings.confirmProjectAgents);

	// All labels ≤ 30 chars — the SettingsList pads to the widest label (capped
	// at 30), so longer labels would push their value column out of alignment.
	const items: SettingItem[] = [
		{
			id: "settingsScope",
			label: "Settings scope",
			description:
				"Where settings values come from and where edits are written: the user file, or the project .shepherd/config.json (project values override user values).",
			currentValue: settings.settingsScope,
			values: ["user", "project"],
		},
		{
			id: "agentScope",
			label: "Agent scope",
			description: "Which agent directories to search. Project agents are repo-controlled.",
			currentValue: settings.agentScope,
			values: ["user", "project", "both"],
		},
		{
			id: "includeBundledAgents",
			label: "Include bundled agents",
			description: "Add built-in agents (scout, planner, worker, reviewer).",
			currentValue: bundledValue,
			values: bundledValues,
		},
		{
			id: "confirmProjectAgents",
			label: "Confirm project agents",
			description: "Prompt before running repo-controlled project agents.",
			currentValue: confirmValue,
			values: confirmValues,
		},
		{
			id: "keepOpen",
			label: "Keep tab open after done",
			description: "Leave the Herdr tab open after completion for inspection.",
			currentValue: keepOpenValue,
			values: keepOpenValues,
		},
		{
			id: "stayOpen",
			label: "Keep agent alive after done",
			description: "Keep the agent's pi alive so you can keep driving it in the tab.",
			currentValue: stayOpenValue,
			values: stayOpenValues,
		},
		{
			id: "fieldnotes",
			label: "Enable fieldnotes",
			description: "Create durable notes for delegated prompts. Takes effect next pi session.",
			currentValue: fieldnotesValue,
			values: fieldnotesValues,
		},
		{
			id: "emojiSheep",
			label: "Use sheep emoji",
			description: "Show 🐑 beside active agents; off uses a plain o instead.",
			currentValue: emojiSheepValue,
			values: emojiSheepValues,
		},
		{
			id: "timeout",
			label: "Default run timeout",
			description: "Time limit in minutes before a Herdr run is reported timed out.",
			currentValue: TIMEOUT_DISPLAY(settings.timeout),
			values: TIMEOUT_CHOICES.map(TIMEOUT_DISPLAY),
		},
		{
			id: "staleWaitThreshold",
			label: "Stale wait reminder",
			description:
				"Minutes before a task waiting on a required reply raises one stale-wait reminder. Off (no reminders) disables it.",
			currentValue: STALE_WAIT_DISPLAY(settings.staleWaitThreshold),
			values: STALE_WAIT_CHOICES.map(STALE_WAIT_DISPLAY),
		},
	];

	await ctx.ui.custom(
		(_tui, theme, _kb, done) => {
			const container = new Container();
			// Same framing pi uses for its own /settings menu.
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const list = new SettingsList(
				items,
				Math.min(items.length + 2, 12),
				getSettingsListTheme(),
				(id, value) => {
					settings = applyValue(settings, id, value);
					// Scope changes always persist to the user file (it owns
					// the scope pointer); every other field saves to the
					// current scope's file, so project saves only store the
					// delta against the user layer.
					const targetScope: ConfigScope =
						id === "settingsScope" ? "user" : settings.settingsScope;
					try {
						const { file, created } = saveSettings(settings, targetScope, cwd);
						if (created) {
							// A just-born project file holds at most the delta
							// of the field being set; reset the in-memory
							// state from it so the menu (which shows
							// effective values) matches disk.
							if (targetScope === "project") settings = loadProjectDelta(cwd);
							ctx.ui?.notify?.(`Config created at ${path.relative(cwd, file) || file}`, "info");
							return;
						}
						const note =
							id === "agentScope" && settings.agentScope !== "user"
								? `${id} = ${value} (project agents are repo-controlled)`
								: id === "fieldnotes"
									? `${id} = ${value} (takes effect next pi session)`
									: `${id} = ${value}`;
						ctx.ui?.notify?.(note, "info");
					} catch (error) {
						ctx.ui?.notify?.(
							`pi-shepherd: could not save ${id}: ${String((error as Error)?.message ?? error)}`,
							"error",
						);
					}
				},
				() => done(undefined), // close menu
				{ enableSearch: true },
			);
			container.addChild(list);

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => list.handleInput?.(data),
			};
		},
		// No `overlay` — renders inline in the writing-field slot (editor is
		// replaced by the menu and restored on close), like pi's own /settings.
	);
}
