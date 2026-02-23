/**
 * Terminal helpers — provides commands for the user to run manually.
 * User opens a new tab (Cmd+T) and runs the command themselves.
 */

/**
 * Get the command to launch pi in a worktree.
 */
export function getPiLaunchCommand(worktreePath: string): string {
	return `cd ${worktreePath} && pi`;
}

/**
 * Get the command to just cd to a worktree.
 */
export function getCdCommand(worktreePath: string): string {
	return `cd ${worktreePath}`;
}
