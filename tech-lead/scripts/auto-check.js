/**
 * auto-check.js — TL 自动巡检：Backlog 中是否有未设计的 feature-request
 *
 * 输出:
 *   PROCEED <issueId> — 找到未设计的 feature，需要设计
 *   SKIP              — 所有 feature 都已设计完毕或无 feature
 */

import { fetchProjectIssues } from '../../shared/lib/linear.js';
import { logInfo } from '../../shared/lib/logger.js';

const projectName = process.argv[2];
if (!projectName) {
    console.error('用法: node auto-check.js "<ProjectName>"');
    process.exit(1);
}

const issues = await fetchProjectIssues(projectName);

// 找 Backlog 中的 feature-request issue
const featureRequests = issues.filter(i =>
    (i.state.type === 'backlog' || i.state.type === 'unstarted') &&
    i.labels.nodes.some(l => l.name.toLowerCase() === 'feature-request')
);

if (featureRequests.length === 0) {
    logInfo('Backlog 中没有 feature-request issue。');
    console.log('SKIP');
    process.exit(0);
}

// 检查哪些 feature-request 还没有子 issue（未设计）
const undesigned = featureRequests.filter(i =>
    !i.children || i.children.nodes.length === 0
);

if (undesigned.length === 0) {
    logInfo(`所有 ${featureRequests.length} 个 feature-request 都已完成设计。`);
    console.log('SKIP');
} else {
    // 按优先级排序，取最高优先级的
    const w = (p) => (p === 0 ? 99 : p);
    undesigned.sort((a, b) => w(a.priority) - w(b.priority));
    const target = undesigned[0];
    logInfo(`找到 ${undesigned.length} 个未设计的 feature-request，选择: ${target.identifier} — ${target.title}`);
    console.log(`PROCEED ${target.identifier}`);
}
