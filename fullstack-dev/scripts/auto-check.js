/**
 * auto-check.js — FD 自动巡检：是否有待开发的 ready-to-dev issue + 并发检查
 *
 * 输出:
 *   PROCEED — 有待开发 issue 且无过多并发
 *   SKIP    — 无待开发 issue 或并发已满
 */

import { execSync } from 'child_process';
import { fetchNextTodoIssue } from '../../shared/lib/linear.js';
import { logInfo } from '../../shared/lib/logger.js';

const MAX_CONCURRENT = 2; // 最多同时运行的 Codex Agent 数

const projectName = process.argv[2];
if (!projectName) {
    console.error('用法: node auto-check.js "<ProjectName>"');
    process.exit(1);
}

// 1. 检查并发：统计活跃的 agent tmux sessions
let activeAgents = 0;
try {
    const tmuxOutput = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null || true').toString();
    activeAgents = tmuxOutput.split('\n').filter(s => s.startsWith('agent-')).length;
} catch {
    // tmux 未运行，没有活跃 session
}

if (activeAgents >= MAX_CONCURRENT) {
    logInfo(`已有 ${activeAgents} 个 Agent 在运行（上限 ${MAX_CONCURRENT}），跳过。`);
    console.log('SKIP');
    process.exit(0);
}

// 2. 检查是否有 ready-to-dev issue
const issue = await fetchNextTodoIssue(projectName, 'ready-to-dev');
if (!issue) {
    logInfo('没有找到 ready-to-dev issue。');
    console.log('SKIP');
} else {
    logInfo(`找到待开发 issue: ${issue.identifier} — ${issue.title} (并发: ${activeAgents}/${MAX_CONCURRENT})`);
    console.log('PROCEED');
}
