/**
 * Heartbeat system — each pi instance writes a PID-keyed JSON file
 * so other instances can discover who's alive and what they're doing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const FLEET_DIR = join(homedir(), ".pi", "agent", "fleet");

export interface Heartbeat {
	pid: number;
	cwd: string;
	gitRepo: string | null;
	gitBranch: string | null;
	worktreeName: string;
	model: string | null;
	status: "idle" | "streaming" | "tool_running";
	currentTool: string | null;
	lastUserMessage: string | null;
	lastAssistantSnippet: string | null;
	turns: number;
	sessionFile: string | null;
	startedAt: string;
	updatedAt: string;
}

function ensureFleetDir(): void {
	if (!existsSync(FLEET_DIR)) {
		mkdirSync(FLEET_DIR, { recursive: true });
	}
}

function isPidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function writeHeartbeat(data: Heartbeat): void {
	ensureFleetDir();
	const file = join(FLEET_DIR, `${data.pid}.json`);
	writeFileSync(file, JSON.stringify(data, null, 2));
}

export function removeHeartbeat(pid: number): void {
	try {
		unlinkSync(join(FLEET_DIR, `${pid}.json`));
	} catch {
		// Already gone — that's fine
	}
}

export function readAllHeartbeats(): Heartbeat[] {
	ensureFleetDir();
	const heartbeats: Heartbeat[] = [];

	for (const file of readdirSync(FLEET_DIR)) {
		if (!file.endsWith(".json")) continue;
		const pid = parseInt(file.replace(".json", ""), 10);
		if (isNaN(pid)) continue;

		try {
			const raw = readFileSync(join(FLEET_DIR, file), "utf-8");
			const data: Heartbeat = JSON.parse(raw);

			if (isPidRunning(pid)) {
				heartbeats.push(data);
			} else {
				// Stale — process died without cleanup
				try {
					unlinkSync(join(FLEET_DIR, file));
				} catch {}
			}
		} catch {
			// Corrupted file — remove it
			try {
				unlinkSync(join(FLEET_DIR, file));
			} catch {}
		}
	}

	return heartbeats;
}
