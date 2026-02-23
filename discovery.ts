/**
 * Fleet discovery — merges three data layers:
 *   1. git worktree list   → all worktrees (ground truth)
 *   2. session directories → which worktrees have history
 *   3. heartbeat files     → which worktrees have a LIVE pi
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { readAllHeartbeats, type Heartbeat } from "./heartbeat.ts";

export interface WorktreeEntry {
	path: string;
	branch: string;
	name: string; // friendly name (basename of path)
	isMain: boolean;
	isCurrent: boolean;
	heartbeat: Heartbeat | null;
	hasSessionHistory: boolean;
	sessionCount: number;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
	return execSync(`git ${args.join(" ")}`, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

export function isGitRepo(cwd: string): boolean {
	try {
		git(["rev-parse", "--git-dir"], cwd);
		return true;
	} catch {
		return false;
	}
}

function getMainWorktreePath(cwd: string): string {
	const gitCommonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	return dirname(gitCommonDir);
}

export function getRepoName(cwd: string): string {
	try {
		const url = git(["remote", "get-url", "origin"], cwd);
		// git@github.com:org/repo.git  →  repo
		// https://github.com/org/repo.git  →  repo
		const match = url.match(/\/([^/]+?)(?:\.git)?$/);
		if (match) return match[1];
	} catch {}
	// Fallback to directory name of main worktree
	return basename(getMainWorktreePath(cwd));
}

// ── Session path encoding ────────────────────────────────────────────────────

function encodeSessionPath(absolutePath: string): string {
	// /Users/sjain/foo → --Users-sjain-foo--
	const stripped = absolutePath.startsWith("/") ? absolutePath.slice(1) : absolutePath;
	return "--" + stripped.replace(/\//g, "-") + "--";
}

// ── Main discovery ───────────────────────────────────────────────────────────

export function discoverFleet(cwd: string): WorktreeEntry[] {
	const output = git(["worktree", "list", "--porcelain"], cwd);
	const currentPath = resolve(cwd);
	const mainPath = getMainWorktreePath(cwd);

	// Parse porcelain output
	const raw: Array<{ path: string; branch: string }> = [];
	let current: { path?: string; branch?: string } = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			current.path = line.slice(9);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace("refs/heads/", "");
		} else if (line === "detached") {
			current.branch = "HEAD (detached)";
		} else if (line === "") {
			if (current.path) {
				raw.push({ path: current.path, branch: current.branch || "unknown" });
			}
			current = {};
		}
	}
	if (current.path) {
		raw.push({ path: current.path, branch: current.branch || "unknown" });
	}

	// Index heartbeats by cwd
	const heartbeats = readAllHeartbeats();
	const heartbeatByCwd = new Map<string, Heartbeat>(heartbeats.map((h) => [h.cwd, h]));

	// Check session directories
	const sessionsBase = join(homedir(), ".pi", "agent", "sessions");

	return raw.map((wt) => {
		const sessionDirName = encodeSessionPath(wt.path);
		const sessionDir = join(sessionsBase, sessionDirName);
		let sessionCount = 0;

		if (existsSync(sessionDir)) {
			try {
				sessionCount = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).length;
			} catch {}
		}

		return {
			path: wt.path,
			branch: wt.branch,
			name: basename(wt.path),
			isMain: wt.path === mainPath,
			isCurrent: wt.path === currentPath,
			heartbeat: heartbeatByCwd.get(wt.path) ?? null,
			hasSessionHistory: sessionCount > 0,
			sessionCount,
		};
	});
}

// ── Relative time formatting ─────────────────────────────────────────────────

export function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const sec = Math.floor(diff / 1000);
	if (sec < 5) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hrs = Math.floor(min / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}
