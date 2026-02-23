/**
 * TUI dashboard component — shows all worktrees with live pi status.
 */

import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type WorktreeEntry, relativeTime } from "./discovery.ts";

export interface FleetAction {
	type: "open" | "switch" | "launch" | "create" | "remove";
	entry?: WorktreeEntry; // undefined for "create"
}

type Theme = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

export class FleetDashboard {
	private entries: WorktreeEntry[];
	private selected: number = 0;
	private theme: Theme;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private title: string;
	private expanded: Set<number> = new Set();

	constructor(entries: WorktreeEntry[], theme: Theme, title: string) {
		this.entries = entries;
		this.theme = theme;
		this.title = title;
	}

	setEntries(entries: WorktreeEntry[]): void {
		const selectedPath = this.entries[this.selected]?.path;
		this.entries = entries;

		if (selectedPath) {
			const idx = entries.findIndex((e) => e.path === selectedPath);
			this.selected = idx >= 0 ? idx : Math.min(this.selected, Math.max(0, entries.length - 1));
		} else {
			this.selected = 0;
		}

		this.expanded.clear();
		this.invalidate();
	}

	handleInput(data: string): FleetAction | "close" | null {
		// Navigation
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.selected > 0) {
				this.selected--;
				this.invalidate();
			}
			return null;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.selected < this.entries.length - 1) {
				this.selected++;
				this.invalidate();
			}
			return null;
		}

		// Details toggle
		if (data === "d") {
			if (this.expanded.has(this.selected)) {
				this.expanded.delete(this.selected);
			} else {
				this.expanded.add(this.selected);
			}
			this.invalidate();
			return null;
		}

		// Actions on selected entry
		if (matchesKey(data, Key.enter)) {
			const entry = this.entries[this.selected];
			if (entry && !entry.isCurrent) {
				return { type: "open", entry };
			}
			return null;
		}

		if (data === "s") {
			const entry = this.entries[this.selected];
			if (entry && !entry.isCurrent) {
				return { type: "switch", entry };
			}
			return null;
		}

		if (data === "l") {
			const entry = this.entries[this.selected];
			if (entry && !entry.isCurrent) {
				return { type: "launch", entry };
			}
			return null;
		}

		// Create new worktree
		if (data === "c") {
			return { type: "create" };
		}

		// Remove worktree
		if (data === "x") {
			const entry = this.entries[this.selected];
			if (entry && !entry.isCurrent && !entry.isMain) {
				return { type: "remove", entry };
			}
			return null;
		}

		// Close
		if (matchesKey(data, Key.escape) || data === "q") {
			return "close";
		}

		return null;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const t = this.theme;
		const lines: string[] = [];

		// ── Header ───────────────────────────────────────────────────────
		lines.push("");
		const headerLeft = `  ${t.fg("accent", t.bold("⚡ Pi Fleet"))} ${t.fg("muted", "─")} ${t.fg("text", this.title)}`;
		const headerRight = t.fg("dim", `${this.entries.length} worktree${this.entries.length !== 1 ? "s" : ""}`);
		const headerPad = Math.max(2, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 2);
		lines.push(truncateToWidth(headerLeft + " ".repeat(headerPad) + headerRight, width));
		lines.push("");

		// ── Empty state ──────────────────────────────────────────────────
		if (this.entries.length === 0) {
			lines.push(`  ${t.fg("muted", "No worktrees found.")}`);
			lines.push(`  ${t.fg("dim", 'Press c to create one, or use "git worktree add".')}`);
			lines.push("");
		}

		// ── Entries ──────────────────────────────────────────────────────
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			const isSelected = i === this.selected;
			const isExpanded = this.expanded.has(i);
			const hb = entry.heartbeat;

			// Line 1: [selector] [status] name + branch + model
			const selector = isSelected ? t.fg("accent", "▸ ") : "  ";
			const statusIcon = this.getStatusIcon(entry);
			const namePart = this.formatName(entry, isSelected);
			const branchPart = t.fg("muted", this.truncStr(entry.branch, 28));
			const modelPart = hb
				? t.fg("dim", this.shortModel(hb.model))
				: entry.hasSessionHistory
					? t.fg("dim", "(stopped)")
					: t.fg("dim", "(new)");
			const currentTag = entry.isCurrent ? t.fg("warning", " ★ you") : "";

			lines.push(truncateToWidth(`  ${selector}${statusIcon} ${namePart}${currentTag}  ${branchPart}  ${modelPart}`, width));

			// Line 2: Status detail
			lines.push(truncateToWidth(`      ${this.formatStatusLine(entry)}`, width));

			// Line 3: Last message (only for running pi instances)
			if (hb?.lastUserMessage) {
				const msg = this.truncStr(hb.lastUserMessage, 64);
				lines.push(truncateToWidth(`      ${t.fg("dim", `"${msg}"`)}`, width));
			}

			// Expanded details
			if (isExpanded) {
				lines.push(truncateToWidth(`      ${t.fg("muted", "path:")} ${t.fg("dim", entry.path)}`, width));
				if (hb) {
					lines.push(truncateToWidth(`      ${t.fg("muted", "pid:")} ${t.fg("dim", String(hb.pid))}  ${t.fg("muted", "started:")} ${t.fg("dim", relativeTime(hb.startedAt))}`, width));
					if (hb.lastAssistantSnippet) {
						const snippet = this.truncStr(hb.lastAssistantSnippet, 64);
						lines.push(truncateToWidth(`      ${t.fg("muted", "last reply:")} ${t.fg("dim", `"${snippet}"`)}`, width));
					}
				}
				if (entry.hasSessionHistory) {
					lines.push(truncateToWidth(`      ${t.fg("muted", "sessions:")} ${t.fg("dim", String(entry.sessionCount))}`, width));
				}
			}

			lines.push("");
		}

		// ── Footer ───────────────────────────────────────────────────────
		const sep = t.fg("muted", " │ ");
		const helpLine1 = [
			`${t.fg("accent", "↑↓")} navigate`,
			`${t.fg("accent", "enter")} open`,
			`${t.fg("accent", "s")} switch`,
			`${t.fg("accent", "l")} launch`,
			`${t.fg("accent", "d")} details`,
		].join(sep);

		const helpLine2 = [
			`${t.fg("accent", "c")} create worktree`,
			`${t.fg("accent", "x")} remove`,
			`${t.fg("accent", "r")} refresh`,
			`${t.fg("accent", "q")} quit`,
		].join(sep);

		lines.push(truncateToWidth(`  ${helpLine1}`, width));
		lines.push(truncateToWidth(`  ${helpLine2}`, width));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	// ── Private helpers ──────────────────────────────────────────────────

	private getStatusIcon(entry: WorktreeEntry): string {
		const t = this.theme;
		if (!entry.heartbeat) {
			return entry.hasSessionHistory ? t.fg("muted", "○") : t.fg("dim", "○");
		}
		switch (entry.heartbeat.status) {
			case "idle":
				return t.fg("success", "●");
			case "streaming":
				return t.fg("accent", "●");
			case "tool_running":
				return t.fg("warning", "●");
			default:
				return t.fg("muted", "●");
		}
	}

	private formatName(entry: WorktreeEntry, isSelected: boolean): string {
		const t = this.theme;
		const label = entry.isMain ? `${entry.name} (main)` : entry.name;
		return isSelected ? t.fg("accent", t.bold(label)) : t.fg("text", label);
	}

	private formatStatusLine(entry: WorktreeEntry): string {
		const t = this.theme;
		const hb = entry.heartbeat;

		if (!hb) {
			if (entry.hasSessionHistory) {
				return t.fg("muted", `${entry.sessionCount} session${entry.sessionCount !== 1 ? "s" : ""}`);
			}
			return t.fg("dim", "no sessions yet");
		}

		const parts: string[] = [];

		switch (hb.status) {
			case "idle":
				parts.push(t.fg("success", "idle"));
				break;
			case "streaming":
				parts.push(t.fg("accent", "streaming"));
				break;
			case "tool_running":
				parts.push(t.fg("warning", `tool: ${hb.currentTool || "?"}`));
				break;
		}

		if (hb.turns > 0) {
			parts.push(t.fg("muted", `${hb.turns} turn${hb.turns !== 1 ? "s" : ""}`));
		}

		parts.push(t.fg("dim", relativeTime(hb.updatedAt)));

		return parts.join(t.fg("dim", " • "));
	}

	private shortModel(model: string | null): string {
		if (!model) return "";
		return model
			.replace(/^claude-/, "")
			.replace(/-\d{8}$/, "")
			.replace(/-\d{4}-\d{2}-\d{2}$/, "");
	}

	private truncStr(str: string, maxLen: number): string {
		if (str.length <= maxLen) return str;
		return str.slice(0, maxLen - 3) + "...";
	}
}
