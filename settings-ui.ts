/**
 * Settings menu for pi-shepherd — rendered inline in the writing field slot,
 * exactly like pi's own `/settings`: a `SettingsList` framed by `DynamicBorder`s
 * (Pattern 3). When the command runs, the editor is replaced by the menu;
 * arrows navigate, Enter cycles a value, `/` fuzzy-searches, esc closes and the
 * editor comes back.
 *
 * Alignment note: the SettingsList pads the label column to the widest label
 * (capped at 30). Keep every label ≤ 30 visible chars so the value column
 * stays aligned.
 *
 * Commands: `/shepherd settings` and the dedicated `/shepherd-settings`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { type ShepherdSettings, loadSettings, saveSettings } from "./settings.ts";

const TIMEOUT_CHOICES = [1, 2, 5, 10, 20, 30, 60];
const TIMEOUT_DISPLAY = (n: number) => `${n} min`;

/** Translate a settings change (string value from the list) back into state. */
function applyValue(settings: ShepherdSettings, id: string, value: string): ShepherdSettings {
	const next = { ...settings };
	switch (id) {
		case "agentScope":
			next.agentScope = value as ShepherdSettings["agentScope"];
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
		case "timeout": {
			// The list displays values as e.g. "30 min", so parse the
			// numeric portion rather than passing the decorated label to Number.
			const n = Number.parseInt(value, 10);
			if (Number.isFinite(n) && n > 0) next.timeout = n;
			break;
		}
	}
	return next;
}

function booleans(value: boolean): [string, string[]] {
	return value ? ["on", ["on", "off"]] : ["off", ["on", "off"]];
}

/** Render + drive the settings menu. Shared by the two commands. */
export async function openSettings(ctx: ExtensionCommandContext): Promise<void> {
	// Keep the in-memory state current while the menu is open. SettingsList can
	// invoke onChange multiple times in one session; applying every change to
	// the initial snapshot would otherwise discard earlier changes.
	let settings = loadSettings();
	const [keepOpenValue, keepOpenValues] = booleans(settings.keepOpen);
	const [stayOpenValue, stayOpenValues] = booleans(settings.stayOpen);
	const [confirmValue, confirmValues] = booleans(settings.confirmProjectAgents);

	// All labels ≤ 30 chars — the SettingsList pads to the widest label (capped
	// at 30), so longer labels would push their value column out of alignment.
	const items: SettingItem[] = [
		{
			id: "agentScope",
			label: "Agent scope",
			description: "Which agent directories to search. Project agents are repo-controlled.",
			currentValue: settings.agentScope,
			values: ["user", "project", "both"],
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
			label: "Keep sheep alive after done",
			description: "Keep the sheep's pi alive so you can keep driving it in the tab.",
			currentValue: stayOpenValue,
			values: stayOpenValues,
		},
		{
			id: "timeout",
			label: "Default run timeout",
			description: "Time limit in minutes before a Herdr run is reported timed out.",
			currentValue: TIMEOUT_DISPLAY(settings.timeout),
			values: TIMEOUT_CHOICES.map(TIMEOUT_DISPLAY),
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
					saveSettings(settings);
					const note =
						id === "agentScope" && settings.agentScope !== "user"
							? `${id} = ${value} (project agents are repo-controlled)`
							: `${id} = ${value}`;
					ctx.ui?.notify?.(note, "info");
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

export function registerSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("shepherd-settings", {
		description: "pi-shepherd settings menu (inline, like /settings)",
		handler: async (_args, ctx) => {
			await openSettings(ctx);
		},
	});
}