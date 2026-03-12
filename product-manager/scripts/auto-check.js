/**
 * auto-check.js — PM 自动巡检：Backlog 是否为空
 *
 * 输出:
 *   PROCEED — Backlog 为空，应创建新 feature-request
 *   SKIP    — Backlog 仍有 issue，无需创建
 */

import { fetchProjectIssues } from '../../shared/lib/linear.js';
import { logInfo } from '../../shared/lib/logger.js';

const projectName = process.argv[2];
if (!projectName) {
    console.error('用法: node auto-check.js "<ProjectName>"');
    process.exit(1);
}

const issues = await fetchProjectIssues(projectName);
const backlogIssues = issues.filter(i =>
    i.state.type === 'backlog' || i.state.type === 'unstarted'
);

if (backlogIssues.length > 0) {
    logInfo(`Backlog 有 ${backlogIssues.length} 个 issue，无需创建新 feature-request。`);
    const titles = backlogIssues.slice(0, 5).map(i => `  - ${i.identifier}: ${i.title}`).join('\n');
    logInfo(`当前 Backlog:\n${titles}`);
    console.log('SKIP');
} else {
    logInfo('Backlog 为空，应创建新 feature-request。');
    console.log('PROCEED');
}
