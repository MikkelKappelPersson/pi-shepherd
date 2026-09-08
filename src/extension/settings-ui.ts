/**
 * Settings menu for pi-shepherd, rendered inline like pi's own `/settings`.
 * Project scope is per-workspace; the project file is self-contained and the
 * project-agent confirmation gate remains user-owned.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	deactivateProjectScope,
	loadProjectFileValues,
	loadSettings,
	projectConfigFile,
	saveSettings,
	type ShepherdSettings,
} from "./config.ts";

const TIMEOUT_CHOICES = [1, 2, 5, 10, 20, 30, 60];
const STALE_WAIT_CHOICES = [0, 1, 2, 5, 10, 15, 30];
const TIMEOUT_DISPLAY = (minutes: number) => `${minutes} min`;
const STALE_WAIT_DISPLAY = (minutes: number) => (minutes === 0 ? "off (no reminders)" : `${minutes} min`);

function booleans(value: boolean): [string, string[]] {
	return value ? ["on", ["on", "off"]] : ["off", ["on", "off"]];
}

/** Translate a SettingsList value back into the typed settings object. */
function applyValue(settings: ShepherdSettings, id: string, value: string): ShepherdSettings {
	const next = { ...settings };
	switch (id) {
		case "projectScope":
			next.projectScope = value === "project";
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
			const minutes = Number.parseInt(value, 10);
			if (Number.isFinite(minutes) && minutes > 0) next.timeout = minutes;
			break;
		}
		case "staleWaitThreshold": {
			const minutes = value.startsWith("off") ? 0 : Number.parseInt(value, 10);
			if (Number.isFinite(minutes) && minutes >= 0) next.staleWaitThreshold = minutes;
			break;
		}
	}
	return next;
}

function refreshItems(items: SettingItem[], settings: ShepherdSettings, cwd: string): void {
	const scopeItem = items[0];
	if (settings.projectScope) {
		scopeItem.currentValue = "project";
		scopeItem.values = ["project", "user"];
	} else if (fs.existsSync(projectConfigFile(cwd))) {
		scopeItem.currentValue = "user (project file dormant)";
		scopeItem.values = ["user (project file dormant)", "project"];
	} else {
		scopeItem.currentValue = "user";
		scopeItem.values = ["user", "project"];
	}

	const [bundledValue, bundledValues] = booleans(settings.includeBundledAgents);
	const [confirmValue, confirmValues] = booleans(settings.confirmProjectAgents);
	const [keepOpenValue, keepOpenValues] = booleans(settings.keepOpen);
	const [stayOpenValue, stayOpenValues] = booleans(settings.stayOpen);
	const [fieldnotesValue, fieldnotesValues] = booleans(settings.fieldnotes);
	const [emojiSheepValue, emojiSheepValues] = booleans(settings.emojiSheep);
	items[1].currentValue = settings.agentScope;
	items[2].currentValue = bundledValue;
	items[2].values = bundledValues;
	items[3].currentValue = confirmValue;
	items[3].values = confirmValues;
	items[4].currentValue = keepOpenValue;
	items[4].values = keepOpenValues;
	items[5].currentValue = stayOpenValue;
	items[5].values = stayOpenValues;
	items[6].currentValue = fieldnotesValue;
	items[6].values = fieldnotesValues;
	items[7].currentValue = emojiSheepValue;
	items[7].values = emojiSheepValues;
	items[8].currentValue = TIMEOUT_DISPLAY(settings.timeout);
	items[9].currentValue = STALE_WAIT_DISPLAY(settings.staleWaitThreshold);
}

/** Render and drive the settings menu. */
export async function openSettings(ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	let settings = loadSettings(cwd);

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const items: SettingItem[] = [
			{
				id: "projectScope",
				label: "Settings scope",
				description:
					"Choose the settings source for this workspace. Project files are repository-controlled and self-contained.",
				currentValue: "user",
				values: ["user", "project"],
			},
			{
				id: "agentScope",
				label: "Agent scope",
				description: "Which agent directories to search. Project agents are repository-controlled.",
				currentValue: settings.agentScope,
				values: ["user", "project", "both"],
			},
			{
				id: "includeBundledAgents",
				label: "Include bundled agents",
				description: "Add built-in agents (scout, planner, worker, reviewer).",
				currentValue: "on",
				values: ["on", "off"],
			},
			{
				id: "confirmProjectAgents",
				label: "Confirm project agents",
				description: "User-only security gate; project files cannot disable confirmation.",
				currentValue: "on",
				values: ["on", "off"],
			},
			{
				id: "keepOpen",
				label: "Keep tab open after done",
				description: "Leave the Herdr tab open after completion for inspection.",
				currentValue: "on",
				values: ["on", "off"],
			},
			{
				id: "stayOpen",
				label: "Keep agent alive after done",
				description: "Keep the agent's pi process alive after completion.",
				currentValue: "off",
				values: ["on", "off"],
			},
			{
				id: "fieldnotes",
				label: "Enable fieldnotes",
				description: "Create durable notes for delegated prompts; takes effect next session.",
				currentValue: "on",
				values: ["on", "off"],
			},
			{
				id: "emojiSheep",
				label: "Use sheep emoji",
				description: "Show the animated sheep marker beside active agents.",
				currentValue: "on",
				values: ["on", "off"],
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
				description: "Minutes before one reminder for a task waiting on a required reply; off disables reminders.",
				currentValue: STALE_WAIT_DISPLAY(settings.staleWaitThreshold),
				values: STALE_WAIT_CHOICES.map(STALE_WAIT_DISPLAY),
			},
		];

		refreshItems(items, settings, cwd);
		let list: SettingsList;
		list = new SettingsList(
			items,
			Math.min(items.length + 2, 12),
			getSettingsListTheme(),
			(id, value) => {
				try {
					const next = applyValue(settings, id, value);
					if (id === "projectScope") {
						if (value === "project") {
							const parked = loadProjectFileValues(cwd);
							settings = { ...settings, ...parked, projectScope: true };
							const result = saveSettings(settings, "project", cwd);
							if (result.created) {
								ctx.ui?.notify?.(`Config created at ${path.relative(cwd, result.file) || result.file}`, "info");
							} else {
								ctx.ui?.notify?.("Project settings activated for this workspace.", "info");
							}
						} else {
							const result = deactivateProjectScope(cwd);
							ctx.ui?.notify?.(
								result.changed ? "Project settings deactivated; user settings are active." : "Project settings are already inactive.",
								"info",
							);
						}
					} else if (id === "confirmProjectAgents") {
						// This field is always persisted in the trusted user layer,
						// even when the menu is showing active project settings.
						const userSettings = loadSettings();
						saveSettings({ ...userSettings, confirmProjectAgents: next.confirmProjectAgents }, "user");
					} else {
						const targetScope = settings.projectScope ? "project" : "user";
						settings = next;
						saveSettings(settings, targetScope, cwd);
					}

					settings = loadSettings(cwd);
					refreshItems(items, settings, cwd);
					list.invalidate();

					const note =
						id === "agentScope" && settings.agentScope !== "user"
							? `${id} = ${value} (project agents are repository-controlled)`
							: id === "fieldnotes"
								? `${id} = ${value} (takes effect next pi session)`
								: id === "confirmProjectAgents"
									? `${id} = ${value} (user-only security setting)`
									: `${id} = ${value}`;
					ctx.ui?.notify?.(note, "info");
				} catch (error) {
					ctx.ui?.notify?.(
						`pi-shepherd: could not save ${id}: ${String((error as Error)?.message ?? error)}`,
						"error",
					);
				}
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => list.handleInput?.(data),
		};
	});
}
