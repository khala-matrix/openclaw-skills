---
name: codex-dev
description: Starts an autonomous dev task for a specific Linear Project. It automatically selects the highest-priority "Todo" issue, checks Codex quota, creates an isolated git worktree, and spawns the Codex autonomous agent.
---

# codex-dev

This skill automates the execution of new development tasks by identifying priority issues from a Linear Project and creating an isolated environment for the Codex autonomous agent.

## Capabilities

1. **Codex Quota Check**: Before doing anything, it reads the local `~/.codex/sessions/` data to ensure your primary message quota has at least 10% remaining. If not, it pauses development.
2. **Priority Issue Selection**: Given a Linear Project name, it will automatically query for `unstarted` (Todo) issues, sorting by priority (Urgent > High > Medium > Low) and creation date to pick the next most important task.
3. **Linear Status Updates**: It automatically moves the picked issue into the `In Progress` status on Linear.
4. **Git Isolation**: It spins up a dedicated `git worktree` branch (`feat/<issue-id>-<title>`) to keep your main workspace clean.
5. **Prompt & Agent Invocation**: Prompts are auto-generated from the issue description, and a background `tmux` session seamlessly launches the agent.
6. **Task Completion Hook**: Handles the post-execution state — inspecting the exit code, verifying GitHub PR creation, and moving the Linear issue to `In Review`.

## Usage Instructions

When the user asks to start working on a project (e.g., "work on Khala"), or you need to process tasks autonomously, invoke this skill by executing its main script with the project name.

### Execution Command
To start working on a project, call the Start script with the Project Name as its first argument.

```bash
# Example: Starting the highest-priority task for the "Khala Frontend" project
LINEAR_API_KEY="<user_provided_key>" node /Users/mars/claude-projects/openclaw-skills/codex-dev/scripts/start-task.js "Khala Frontend"
```

### Script Execution Parameters
- `projectName`: The name of the project on Linear (e.g. `Khala Backend`, `Infra`). Provide this as the first positional argument. Wrap it in quotes if it contains spaces.
- `--post-hook`: Highly internal; invoked automatically by the background script, do not trigger manually unless debugging webhook behavior.

### Important Notes
- The Codex Usage Check relies on the local log files stored at `~/.codex/sessions/`.
- Ensure standard dependencies like `gh` (GitHub CLI) and `tmux` are available in your shell.
- The `LINEAR_API_KEY` environment variable is required.
