/**
 * Worktree operations — create, remove, and configuration.
 * Reads pi-worktrees settings if installed, otherwise uses sensible defaults.
 */

import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

// ── pi-worktrees settings (optional) ────────────────────────────────────────

const PI_WORKTREES_SETTINGS = join(homedir(), ".pi", "agent", "pi-worktrees-settings.json");

interface WorktreeSettings {
	parentDir?: string;
	onCreate?: string;
}

function loadWorktreeSettings(): WorktreeSettings {
	try {
		if (existsSync(PI_WORKTREES_SETTINGS)) {
			const raw = JSON.parse(readFileSync(PI_WORKTREES_SETTINGS, "utf-8"));
			return raw?.worktree ?? {};
		}
	} catch {}
	return {};
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
	return execSync(`git ${args.join(" ")}`, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function getMainWorktreePath(cwd: string): string {
	const gitCommonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	return dirname(gitCommonDir);
}

function getProjectName(cwd: string): string {
	return basename(getMainWorktreePath(cwd));
}

// ── Path resolution ──────────────────────────────────────────────────────────

function expandTemplate(template: string, vars: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(vars)) {
		result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
	}
	return result.replace(/^~/, homedir());
}

/**
 * Get the parent directory where worktrees should be created.
 * Respects pi-worktrees settings if present.
 */
export function getWorktreeParentDir(cwd: string): string {
	const settings = loadWorktreeSettings();
	const project = getProjectName(cwd);
	const mainPath = getMainWorktreePath(cwd);

	if (settings.parentDir) {
		return expandTemplate(settings.parentDir, {
			project,
			path: "",
			name: "",
			branch: "",
		});
	}

	// Default: ../<project>.worktrees/
	return join(dirname(mainPath), `${project}.worktrees`);
}

// ── Worktree creation ────────────────────────────────────────────────────────

export interface CreateResult {
	success: boolean;
	path?: string;
	branch?: string;
	error?: string;
}

export function createWorktree(cwd: string, featureName: string): CreateResult {
	const mainPath = getMainWorktreePath(cwd);
	const project = getProjectName(cwd);
	const parentDir = getWorktreeParentDir(cwd);
	const worktreePath = join(parentDir, featureName);
	const branchName = `feature/${featureName}`;

	// Validate: branch doesn't already exist
	try {
		git(["rev-parse", "--verify", branchName], cwd);
		return { success: false, error: `Branch '${branchName}' already exists.` };
	} catch {
		// Good — branch doesn't exist
	}

	// Validate: worktree path doesn't exist
	if (existsSync(worktreePath)) {
		return { success: false, error: `Path already exists: ${worktreePath}` };
	}

	// Ensure parent directory exists
	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true });
	}

	// Create the worktree
	try {
		git(["worktree", "add", "-b", branchName, worktreePath], mainPath);
	} catch (err) {
		return { success: false, error: `git worktree add failed: ${(err as Error).message}` };
	}

	// Run onCreate hook if configured
	const settings = loadWorktreeSettings();
	if (settings.onCreate) {
		const command = expandTemplate(settings.onCreate, {
			path: worktreePath,
			name: featureName,
			branch: branchName,
			project,
		});

		try {
			// Run in background, non-blocking
			spawn(command, {
				cwd: worktreePath,
				shell: true,
				stdio: "ignore",
				detached: true,
			}).unref();
		} catch {
			// onCreate failure is non-fatal
		}
	}

	return { success: true, path: worktreePath, branch: branchName };
}

// ── Worktree removal ─────────────────────────────────────────────────────────

export interface RemoveResult {
	success: boolean;
	error?: string;
}

export function removeWorktree(cwd: string, worktreePath: string, force: boolean = false): RemoveResult {
	const mainPath = getMainWorktreePath(cwd);

	// Safety: don't remove main worktree
	if (worktreePath === mainPath) {
		return { success: false, error: "Cannot remove the main worktree." };
	}

	try {
		const args = ["worktree", "remove"];
		if (force) args.push("--force");
		args.push(worktreePath);
		git(args, cwd);
		return { success: true };
	} catch (err) {
		const msg = (err as Error).message;
		if (!force && (msg.includes("untracked") || msg.includes("modified") || msg.includes("changes"))) {
			return { success: false, error: "Worktree has uncommitted changes. Use force remove." };
		}
		return { success: false, error: `git worktree remove failed: ${msg}` };
	}
}

// ── List existing branches (for validation) ──────────────────────────────────

export function listBranches(cwd: string): string[] {
	try {
		const output = git(["branch", "--format=%(refname:short)"], cwd);
		return output.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}
