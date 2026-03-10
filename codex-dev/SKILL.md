---
name: codex-dev
description: Starts an autonomous dev task for a specific Linear Project. It automatically selects the highest-priority "Todo" issue, checks Codex quota, fetches the GitHub repo from the Project links, creates an isolated git worktree in the OpenClaw workspace, and spawns the Codex autonomous agent.
---

# codex-dev

This skill automates the execution of new development tasks by identifying priority issues from a Linear Project, fetching its associated codebase, and creating an isolated environment for the Codex autonomous agent.

## Capabilities

1. **Codex Quota Check**: Before doing anything, it reads the local `~/.codex/sessions/` data to ensure your primary message quota has at least 10% remaining. If not, it pauses development.
2. **Priority Issue Selection**: Given a Linear Project name, it will automatically query for `unstarted` (Todo) issues, sorting by priority (Urgent > High > Medium > Low) and creation date to pick the next most important task.
3. **Automatic Code Base Provisioning**: It extracts the GitHub repository URL from the Linear Project's External Links (looking for a link titled `Repo`). It then creates a `codex-dev-projects/` folder in your OpenClaw workspace (defined in `~/.openclaw/openclaw.json`) and either clones the repository or pulls the latest `main`/`master` branch if it already exists.
4. **Git Isolation**: It spins up a dedicated `git worktree` branch (`feat/<issue-id>-<title>`) to keep your main codebase clean.
5. **Prompt & Agent Invocation**: Prompts are auto-generated from the issue description, and a background `tmux` session seamlessly launches the agent inside the new worktree.
6. **Task Completion Hook**: Handles the post-execution state — inspecting the exit code, verifying GitHub PR creation, and moving the Linear issue to `In Review`.
7. **Task Auditing & Cleanup**: Features a `check-task.js` utility that queries all issues in a project, outputs a JSON summary of their states, and automatically deletes old `git worktree` and agent branches for `Done` or `Canceled` tasks.

## Usage Instructions

When the user asks to start working on a project (e.g., "work on Khala"), or you need to process tasks autonomously, invoke this skill by executing its main script with the project name.

### Prerequisites & Configuration
1. **OpenClaw Workspace**: The script reads the `agents.defaults.workspace` path from `~/.openclaw/openclaw.json`. If not set, it defaults to `~/.openclaw/workspace`.
2. **Linear Project Linked Repo**: In Linear, the Project you want to work on MUST have an **External Link** whose title contains the word `Repo` (case-insensitive) pointing to the GitHub repository URL.
3. **Environment Variables**: The `LINEAR_API_KEY` environment variable is required.

### Execution Commands

**To Start a Task**
To start working on a project's highest-priority Todo issue:

```bash
# Example: Starting the highest-priority task for the "Khala Frontend" project
LINEAR_API_KEY="<user_provided_key>" node ~/.openclaw/skills/codex-dev/scripts/start-task.js "Khala Frontend"
```

**To Audit States & Clean Up Worktrees**
To get a JSON report of the project's task states and automatically wipe worktrees for completed issues:

```bash
# Example: Audit priorities and clean up "Khala Frontend"
LINEAR_API_KEY="<user_provided_key>" node ~/.openclaw/skills/codex-dev/scripts/check-task.js "Khala Frontend"
```

### Script Execution Parameters
- `projectName`: The name of the project on Linear (e.g. `Khala Backend`, `Infra`). Provide this as the first positional argument. Wrap it in quotes if it contains spaces.
- `--post-hook`: Highly internal; invoked automatically by the background script.

### Important Notes
- The Codex Usage Check relies on the local log files stored at `~/.codex/sessions/`.
- Ensure standard dependencies like `gh` (GitHub CLI) and `tmux` are available in your shell.
