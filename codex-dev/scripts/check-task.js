import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

// -----------------------------------------------------------------
// 环境与全局配置
// -----------------------------------------------------------------
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const isDebug = process.env.DEBUG === 'true';

function logInfo(msg) { console.log(`[INFO] ${msg}`); }
function logError(msg, err = '') { console.error(`[ERROR] ❌ ${msg}`, err); }

// =================================================================
// 工具区：Linear GraphQL API
// =================================================================
async function callLinearAPI(query, variables) {
    if (!LINEAR_API_KEY) throw new Error("未设置 LINEAR_API_KEY 环境变量。");
    const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': LINEAR_API_KEY },
        body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error(`HTTP Error! status: ${response.status}`);
    const result = await response.json();
    if (result.errors) throw new Error(`GraphQL Error: ${result.errors[0].message}`);
    return result.data;
}

// 1. 根据 Project Name 查找所有的 Issues
async function fetchProjectIssues(projectName) {
    const query = `
        query GetIssuesByProject($projectName: String!) {
            issues(
                filter: { project: { name: { eqIgnoreCase: $projectName } } }
                first: 100
            ) {
                nodes {
                    id
                    identifier
                    title
                    state { name type }
                    project {
                        name
                        externalLinks { nodes { label url } }
                    }
                }
            }
        }
    `;

    const data = await callLinearAPI(query, { projectName });
    return data?.issues?.nodes || [];
}

// =================================================================
// 主逻辑
// =================================================================
async function main() {
    const projectName = process.argv[2];
    if (!projectName) {
        logError('请提供 Project 名称，例如: node check-task.js "Khala Frontend"');
        process.exit(1);
    }

    logInfo(`获取 Project [${projectName}] 下的所有任务...`);
    const issues = await fetchProjectIssues(projectName);

    if (issues.length === 0) {
        logInfo(`✅ Project [${projectName}] 下没有找到任何任务。`);
        console.log(JSON.stringify({}));
        process.exit(0);
    }

    const stateIssues = {};
    const cleanupCandidates = [];
    let repoUrl = null;

    for (const issue of issues) {
        const stateName = issue.state.name;
        if (!stateIssues[stateName]) {
            stateIssues[stateName] = [];
        }
        stateIssues[stateName].push({
            identifier: issue.identifier,
            title: issue.title
        });

        if (issue.state.type === 'completed' || issue.state.type === 'canceled') {
            cleanupCandidates.push(issue.identifier);
        }

        if (!repoUrl && issue.project?.externalLinks?.nodes) {
            const repoLink = issue.project.externalLinks.nodes.find(l => l.label && l.label.toLowerCase().includes('repo'));
            if (repoLink) repoUrl = repoLink.url;
        }
    }

    // JSON 输出需求
    logInfo(`===== 状态统计 JSON =====`);
    console.log(JSON.stringify(stateIssues, null, 2));
    logInfo(`=========================`);

    // --- B. 执行清理 ---
    if (cleanupCandidates.length === 0) {
        logInfo(`没有状态为 'completed' 或 'canceled' 的任务，无需清理。`);
        process.exit(0);
    }

    if (!repoUrl) {
        logError(`无法在 Project 的 External Links 中找到 Repo，无法定位需要清理的工作区`);
        process.exit(1);
    }

    const cleanRepoUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const repoName = cleanRepoUrl.substring(cleanRepoUrl.lastIndexOf('/') + 1);

    // 解析 ~/.openclaw/openclaw.json 获取 workspace
    const openclawConfigFile = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    let workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace');

    if (existsSync(openclawConfigFile)) {
        try {
            const configContent = readFileSync(openclawConfigFile, 'utf8');
            const configData = JSON.parse(configContent);
            if (configData?.agents?.defaults?.workspace) {
                let configuredWorkspace = configData.agents.defaults.workspace;
                if (configuredWorkspace.startsWith('~/')) {
                    configuredWorkspace = path.join(os.homedir(), configuredWorkspace.slice(2));
                }
                workspaceDir = configuredWorkspace;
            }
        } catch (e) {
            // ignore
        }
    }

    const targetRepoDir = path.join(workspaceDir, 'codex-dev-projects', repoName);
    if (!existsSync(targetRepoDir)) {
        logInfo(`项目目录不存在: ${targetRepoDir}。跳过清理。`);
        process.exit(0);
    }

    logInfo(`开始检查并清理以下任务的相关 Git Worktree: ${cleanupCandidates.join(', ')}`);

    for (const issueId of cleanupCandidates) {
        const worktreePath = path.resolve(targetRepoDir, '..', `${issueId}-worktree`);

        // 尝试删除工作树文件夹
        if (existsSync(worktreePath)) {
            logInfo(`🧹 删除无用的 Worktree: ${worktreePath}`);
            try {
                execSync(`git worktree remove -f "${worktreePath}"`, { cwd: targetRepoDir, stdio: 'ignore' });
            } catch (e) {
                try { execSync(`rm -rf "${worktreePath}"`, { stdio: 'ignore' }); } catch (ignore) { }
            }
        }

        // 尝试删除相关分支 (分支名默认是 feat/issueId-*)
        try {
            const branches = execSync(`git branch --list "feat/${issueId}-*"`, { cwd: targetRepoDir }).toString().split('\n').map(b => b.trim().replace(/^\*\s*/, '')).filter(Boolean);
            for (const branch of branches) {
                logInfo(`🌿 删除对应的已完成分支: ${branch}`);
                execSync(`git branch -D ${branch}`, { cwd: targetRepoDir, stdio: 'ignore' });
            }
        } catch (e) {
            // 忽略错误
        }
    }

    logInfo(`✅ 清理完成！`);
}

main().catch(err => {
    logError("脚本执行异常", err);
    process.exit(1);
});
