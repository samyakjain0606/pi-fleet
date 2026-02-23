/**
 * Pi Fleet — manage multiple pi instances across git worktrees.
 *
 * All-in-one: create worktrees, see live status, switch between them.
 * Shows commands for the user to run in a new tab (Cmd+T).
 *
 * Commands:
 *   /fleet                Open the TUI dashboard
 *   /fleet status         Quick summary notification
 *   /fleet create <name>  Create a new worktree
 *   /fleet switch <name>  Show command to switch to another worktree
 *   /fleet launch <name>  Show command to launch pi in a worktree
 *   /fleet remove <name>  Remove a worktree
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import { basename } from "path";
import { writeHeartbeat, removeHeartbeat, type Heartbeat } from "./heartbeat.js";
import { discoverFleet, isGitRepo, getRepoName, type WorktreeEntry } from "./discovery.js";
import { FleetDashboard, type FleetAction } from "./dashboard.js";
import { getPiLaunchCommand, getCdCommand } from "./terminal.js";
import { createWorktree, removeWorktree, getWorktreeParentDir } from "./worktree.js";

// ── Heartbeat state ──────────────────────────────────────────────────────────

let hb: Heartbeat | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function initHeartbeat(cwd: string, sessionFile: string | null): void {
	let gitBranch: string | null = null;
	let gitRepo: string | null = null;

	try {
		gitBranch = execSync("git branch --show-current", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
	} catch {}

	try {
		gitRepo = getRepoName(cwd);
	} catch {}

	hb = {
		pid: process.pid,
		cwd,
		gitRepo,
		gitBranch,
		worktreeName: basename(cwd),
		model: null,
		status: "idle",
		currentTool: null,
		lastUserMessage: null,
		lastAssistantSnippet: null,
		turns: 0,
		sessionFile,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	writeHeartbeat(hb);
}

function updateHb(partial: Partial<Heartbeat>): void {
	if (!hb) return;
	Object.assign(hb, partial, { updatedAt: new Date().toISOString() });
	writeHeartbeat(hb);
}

// ── Message text extraction ──────────────────────────────────────────────────

function extractText(message: any): string | null {
	if (!message) return null;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return (
			message.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join(" ")
				.slice(0, 200) || null
		);
	}
	return null;
}

// ── Command: /fleet (dashboard) ──────────────────────────────────────────────

async function showDashboard(ctx: ExtensionCommandContext): Promise<void> {
	if (!isGitRepo(ctx.cwd)) {
		ctx.ui.notify("Not in a git repository — /fleet requires git.", "error");
		return;
	}

	const repoName = getRepoName(ctx.cwd);

	// Dashboard loop — re-opens after create/remove so user sees the result
	let keepOpen = true;
	while (keepOpen) {
		keepOpen = false;

		const action = await ctx.ui.custom<FleetAction | null>((tui, theme, _kb, done) => {
			let entries = discoverFleet(ctx.cwd);
			const dashboard = new FleetDashboard(entries, theme, repoName);

			return {
				render: (w: number) => dashboard.render(w),
				invalidate: () => dashboard.invalidate(),
				handleInput: (data: string) => {
					if (data === "r") {
						entries = discoverFleet(ctx.cwd);
						dashboard.setEntries(entries);
						tui.requestRender();
						return;
					}

					const result = dashboard.handleInput(data);
					if (result === "close") {
						done(null);
					} else if (result) {
						done(result);
					}
					tui.requestRender();
				},
			};
		});

		if (!action) return;

		if (action.type === "create") {
			const created = await handleCreate(ctx);
			if (created) keepOpen = true;
			continue;
		}

		if (action.type === "remove" && action.entry) {
			const removed = await handleRemove(action.entry, ctx);
			if (removed) keepOpen = true;
			continue;
		}

		// open / launch / switch — show the command
		if (action.entry) {
			showRunCommand(action, ctx);
		}
	}
}

// ── Show run command ─────────────────────────────────────────────────────────

function showRunCommand(action: FleetAction, ctx: ExtensionCommandContext): void {
	const entry = action.entry!;
	const hasPi = !!entry.heartbeat;

	const cmd = hasPi ? getCdCommand(entry.path) : getPiLaunchCommand(entry.path);
	const hint = hasPi ? `Pi already running (PID ${entry.heartbeat!.pid}). cd to the directory:` : "Open a new tab (Cmd+T) and run:";

	if (action.type === "switch") {
		ctx.ui.notify(
			[
				`⚡ Switch to ${entry.name}`,
				"",
				hint,
				"",
				`  ${cmd}`,
				"",
				"Then you can close this tab / pi instance.",
			].join("\n"),
			"info"
		);
	} else {
		ctx.ui.notify(
			[
				`⚡ ${hasPi ? "Go to" : "Launch pi in"} ${entry.name}`,
				"",
				hint,
				"",
				`  ${cmd}`,
			].join("\n"),
			"info"
		);
	}
}

// ── Worktree creation flow ───────────────────────────────────────────────────

async function handleCreate(ctx: ExtensionCommandContext): Promise<boolean> {
	const parentDir = getWorktreeParentDir(ctx.cwd);

	const name = await ctx.ui.input(`Feature name (creates feature/<name> branch in ${parentDir}/):`, "");

	if (!name || !name.trim()) {
		ctx.ui.notify("Cancelled.", "info");
		return false;
	}

	const featureName = name.trim().replace(/\s+/g, "-").toLowerCase();
	const result = createWorktree(ctx.cwd, featureName);

	if (!result.success) {
		ctx.ui.notify(`Failed: ${result.error}`, "error");
		return false;
	}

	ctx.ui.notify(
		[
			`✓ Created worktree: ${featureName}`,
			`  Path:   ${result.path}`,
			`  Branch: ${result.branch}`,
			"",
			"Open a new tab (Cmd+T) and run:",
			"",
			`  ${getPiLaunchCommand(result.path!)}`,
		].join("\n"),
		"info"
	);

	return true;
}

// ── Worktree removal flow ────────────────────────────────────────────────────

async function handleRemove(entry: WorktreeEntry, ctx: ExtensionCommandContext): Promise<boolean> {
	if (entry.isMain) {
		ctx.ui.notify("Cannot remove the main worktree.", "error");
		return false;
	}

	if (entry.isCurrent) {
		ctx.ui.notify("Cannot remove the current worktree. Switch to another first.", "error");
		return false;
	}

	if (entry.heartbeat) {
		ctx.ui.notify(`Pi is running in ${entry.name} (PID ${entry.heartbeat.pid}). Stop it first.`, "error");
		return false;
	}

	const confirmed = await ctx.ui.confirm(
		`Remove ${entry.name}?`,
		`This will remove:\n  Path: ${entry.path}\n  Branch: ${entry.branch}\n\nThe branch will NOT be deleted.`
	);

	if (!confirmed) {
		ctx.ui.notify("Cancelled.", "info");
		return false;
	}

	let result = removeWorktree(ctx.cwd, entry.path);

	if (!result.success && result.error?.includes("uncommitted")) {
		const force = await ctx.ui.confirm("Force remove?", "Worktree has uncommitted changes. Force remove anyway?");
		if (force) {
			result = removeWorktree(ctx.cwd, entry.path, true);
		} else {
			ctx.ui.notify("Cancelled.", "info");
			return false;
		}
	}

	if (result.success) {
		ctx.ui.notify(`✓ Removed worktree: ${entry.name}`, "info");
		return true;
	} else {
		ctx.ui.notify(`Failed: ${result.error}`, "error");
		return false;
	}
}

// ── Command: /fleet status ───────────────────────────────────────────────────

function showStatus(ctx: ExtensionCommandContext): void {
	if (!isGitRepo(ctx.cwd)) {
		ctx.ui.notify("Not in a git repository.", "error");
		return;
	}

	const entries = discoverFleet(ctx.cwd);
	const running = entries.filter((e) => e.heartbeat);
	const idle = running.filter((e) => e.heartbeat?.status === "idle").length;
	const streaming = running.filter((e) => e.heartbeat?.status === "streaming").length;
	const tooling = running.filter((e) => e.heartbeat?.status === "tool_running").length;

	const parts = [`⚡ Fleet: ${entries.length} worktree${entries.length !== 1 ? "s" : ""}`];

	if (running.length > 0) {
		const details: string[] = [];
		if (idle) details.push(`${idle} idle`);
		if (streaming) details.push(`${streaming} streaming`);
		if (tooling) details.push(`${tooling} running tools`);
		parts.push(`${running.length} active (${details.join(", ")})`);
	} else {
		parts.push("none active");
	}

	const stopped = entries.length - running.length;
	if (stopped > 0) parts.push(`${stopped} without pi`);

	ctx.ui.notify(parts.join(" • "), "info");
}

// ── Command: /fleet switch <name> ────────────────────────────────────────────

function switchToWorktree(name: string, ctx: ExtensionCommandContext): void {
	if (!isGitRepo(ctx.cwd)) {
		ctx.ui.notify("Not in a git repository.", "error");
		return;
	}

	const entries = discoverFleet(ctx.cwd);
	const target = findWorktree(entries, name);

	if (!target) {
		ctx.ui.notify(`Worktree "${name}" not found. Available: ${entries.map((e) => e.name).join(", ")}`, "error");
		return;
	}

	if (target.isCurrent) {
		ctx.ui.notify("You're already in this worktree.", "warning");
		return;
	}

	showRunCommand({ type: "switch", entry: target }, ctx);
}

// ── Command: /fleet launch <name> ────────────────────────────────────────────

function launchInWorktree(name: string, ctx: ExtensionCommandContext): void {
	if (!isGitRepo(ctx.cwd)) {
		ctx.ui.notify("Not in a git repository.", "error");
		return;
	}

	const entries = discoverFleet(ctx.cwd);
	const target = findWorktree(entries, name);

	if (!target) {
		ctx.ui.notify(`Worktree "${name}" not found. Available: ${entries.map((e) => e.name).join(", ")}`, "error");
		return;
	}

	const cmd = getPiLaunchCommand(target.path);
	ctx.ui.notify(
		[
			`⚡ Launch pi in ${target.name}`,
			"",
			"Open a new tab (Cmd+T) and run:",
			"",
			`  ${cmd}`,
		].join("\n"),
		"info"
	);
}

// ── Command: /fleet create <name> ────────────────────────────────────────────

async function createFromCommand(name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isGitRepo(ctx.cwd)) {
		ctx.ui.notify("Not in a git repository.", "error");
		return;
	}

	const featureName = name.trim().replace(/\s+/g, "-").toLowerCase();
	const result = createWorktree(ctx.cwd, featureName);

	if (!result.success) {
		ctx.ui.notify(`Failed: ${result.error}`, "error");
		return;
	}

	ctx.ui.notify(
		[
			`✓ Created worktree: ${featureName}`,
			`  Path:   ${result.path}`,
			`  Branch: ${result.branch}`,
			"",
			"Open a new tab (Cmd+T) and run:",
			"",
			`  ${getPiLaunchCommand(result.path!)}`,
		].join("\n"),
		"info"
	);
}

// ── Command: /fleet remove <name> ────────────────────────────────────────────

async function removeFromCommand(name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isGitRepo(ctx.cwd)) {
		ctx.ui.notify("Not in a git repository.", "error");
		return;
	}

	const entries = discoverFleet(ctx.cwd);
	const target = findWorktree(entries, name);

	if (!target) {
		ctx.ui.notify(`Worktree "${name}" not found. Available: ${entries.map((e) => e.name).join(", ")}`, "error");
		return;
	}

	await handleRemove(target, ctx);
}

// ── Action execution ─────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────────────

function findWorktree(entries: WorktreeEntry[], name: string): WorktreeEntry | undefined {
	const lower = name.toLowerCase();
	return (
		entries.find((e) => e.name.toLowerCase() === lower) ||
		entries.find((e) => e.name.toLowerCase().includes(lower)) ||
		entries.find((e) => e.branch.toLowerCase().includes(lower))
	);
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Heartbeat lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		initHeartbeat(ctx.cwd, sessionFile);

		if (ctx.model) {
			updateHb({ model: ctx.model.id });
		}

		heartbeatInterval = setInterval(() => updateHb({}), 30_000);
	});

	pi.on("session_shutdown", async () => {
		if (heartbeatInterval) {
			clearInterval(heartbeatInterval);
			heartbeatInterval = null;
		}
		removeHeartbeat(process.pid);
	});

	// ── Status tracking ────────────────────────────────────────────────────

	pi.on("agent_start", async () => {
		updateHb({ status: "streaming", currentTool: null });
	});

	pi.on("agent_end", async () => {
		updateHb({ status: "idle", currentTool: null });
	});

	pi.on("tool_execution_start", async (event) => {
		updateHb({ status: "tool_running", currentTool: event.toolName });
	});

	pi.on("tool_execution_end", async () => {
		updateHb({ status: "streaming", currentTool: null });
	});

	pi.on("model_select", async (event) => {
		updateHb({ model: event.model.id });
	});

	pi.on("turn_end", async () => {
		if (hb) {
			updateHb({ turns: hb.turns + 1 });
		}
	});

	pi.on("message_end", async (event) => {
		const msg = (event as any).message;
		if (!msg) return;

		if (msg.role === "user") {
			const text = extractText(msg);
			if (text) updateHb({ lastUserMessage: text.slice(0, 200) });
		} else if (msg.role === "assistant") {
			const text = extractText(msg);
			if (text) updateHb({ lastAssistantSnippet: text.slice(0, 200) });
		}
	});

	// ── Commands ───────────────────────────────────────────────────────────

	pi.registerCommand("fleet", {
		description: "Pi Fleet — manage pi instances across git worktrees",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();
			const rest = parts.slice(1).join(" ").trim();

			switch (sub) {
				case "":
				case undefined:
					await showDashboard(ctx);
					break;

				case "status":
					showStatus(ctx);
					break;

				case "create":
					if (!rest) {
						if (!isGitRepo(ctx.cwd)) {
							ctx.ui.notify("Not in a git repository.", "error");
							return;
						}
						await handleCreate(ctx);
					} else {
						await createFromCommand(rest, ctx);
					}
					break;

				case "switch":
					if (!rest) {
						ctx.ui.notify("Usage: /fleet switch <worktree-name>", "error");
						return;
					}
					switchToWorktree(rest, ctx);
					break;

				case "launch":
					if (!rest) {
						ctx.ui.notify("Usage: /fleet launch <worktree-name>", "error");
						return;
					}
					launchInWorktree(rest, ctx);
					break;

				case "remove":
				case "rm":
					if (!rest) {
						ctx.ui.notify("Usage: /fleet remove <worktree-name>", "error");
						return;
					}
					await removeFromCommand(rest, ctx);
					break;

				default:
					ctx.ui.notify(
						[
							"⚡ Pi Fleet — manage pi across git worktrees",
							"",
							"  /fleet                Open dashboard",
							"  /fleet status         Quick summary",
							"  /fleet create [name]  Create worktree",
							"  /fleet launch <name>  Show command to launch pi in worktree",
							"  /fleet switch <name>  Show command to switch to worktree",
							"  /fleet remove <name>  Remove a worktree",
							"",
							"Dashboard: ↑↓ navigate, enter/s/l show command,",
							"           c create, x remove, d details, r refresh, q quit",
						].join("\n"),
						"info"
					);
			}
		},
	});
}
