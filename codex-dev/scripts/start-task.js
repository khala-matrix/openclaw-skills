import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkCodexUsage } from './check-usage.js';

// -----------------------------------------------------------------
// 环境与全局配置
// -----------------------------------------------------------------
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const isDebug = process.env.DEBUG === 'true';

const PROJECT_ROOT = path.resolve(process.cwd());
const OPENCLAW_DIR = path.join(PROJECT_ROOT, '.openclaw');
const TASKS_FILE = path.join(OPENCLAW_DIR, 'active-tasks.json');
const PROMPTS_DIR = path.join(OPENCLAW_DIR, 'prompts');
const LOGS_DIR = path.join(OPENCLAW_DIR, 'logs');
const RUNNERS_DIR = path.join(OPENCLAW_DIR, 'runners');

// 获取当前脚本的绝对路径，用于 Bash 回调
const __filename = fileURLToPath(import.meta.url);

function logInfo(msg) { console.log(`[INFO] ${msg}`); }
function logError(msg, err = '') { console.error(`[ERROR] ❌ ${msg}`, err); }
function logDebug(msg, data = null) {
    if (!isDebug) return;
    console.log(`[DEBUG] 🐛 ${msg}`);
    if (data) console.log(JSON.stringify(data, null, 2));
}

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

// 1. 根据 Project Name 查找优先级最高的 Todo Issue
async function fetchNextTodoIssue(projectName) {
    // 查找该 project 下，状态类型为 unstarted (对应的就是 Todo) 的所有 issues
    const query = `
        query GetIssuesByProject($projectName: String!) {
            issues(
                filter: {
                    project: { name: { eqIgnoreCase: $projectName } }
                    state: { type: { eq: "unstarted" } }
                }
                first: 50
            ) {
                nodes {
                    id
                    identifier
                    title
                    description
                    priority
                    createdAt
                    state { name }
                    team { states { nodes { id name type } } }
                    project {
                        name
                        externalLinks {
                            nodes {
                                label
                                url
                            }
                        }
                    }
                }
            }
        }
    `;

    const data = await callLinearAPI(query, { projectName });
    const issues = data?.issues?.nodes || [];

    if (issues.length === 0) {
        return null;
    }

    // Linear 优先级映射: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
    // 我们希望排序逻辑：1 -> 2 -> 3 -> 4 -> 0(最后)
    const getPriorityWeight = (p) => (p === 0 ? 99 : p);

    issues.sort((a, b) => {
        const weightA = getPriorityWeight(a.priority);
        const weightB = getPriorityWeight(b.priority);
        if (weightA !== weightB) {
            return weightA - weightB; // 优先级高的（数字小的）排前面
        }
        // 优先级相同，按创建时间排，最早的优先
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return issues[0]; // 返回最靠前的一个
}

// 2. 获取任务详情及该团队的所有可用状态 (States)
// 保留给 Post Hook 使用
async function fetchLinearTaskWithStates(issueId) {
    const query = `
        query Issue($id: String!) {
            issue(id: $id) { 
                id identifier title description url state { name } 
                team { states { nodes { id name type } } }
            }
        }
    `;
    const data = await callLinearAPI(query, { id: issueId });
    if (!data || !data.issue) throw new Error(`找不到 Issue: ${issueId}`);
    return data.issue;
}

// 3. 更新任务状态
async function updateLinearState(internalIssueId, stateId) {
    const query = `
        mutation UpdateIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }
    `;
    await callLinearAPI(query, { id: internalIssueId, stateId });
}

// =================================================================
// 后置钩子模式 (Post-Hook Mode)
// =================================================================
async function runPostHook(issueIdentifier, exitCode, branchName, worktreePath, logPath) {
    logInfo(`[POST-HOOK] 触发后置钩子，目标任务: ${issueIdentifier}，退出码: ${exitCode}`);
    const isSuccess = exitCode === '0';

    // 1. 提取 Token 与日志分析
    let tokenInfo = "未找到 Token 消耗数据";
    if (existsSync(logPath)) {
        const logContent = readFileSync(logPath, 'utf8');
        const matches = logContent.split('\n').filter(l => /(token|cost|usage)/i.test(l)).slice(-3);
        if (matches.length > 0) tokenInfo = matches.join(' | ');
    }

    // 2. 失败处理
    if (!isSuccess) {
        logInfo(`[POST-HOOK] Agent 执行失败。`);
        execSync(`osascript -e 'display notification "Token: ${tokenInfo}" with title "❌ 任务异常退出" subtitle "${issueIdentifier} 遇到报错"'`);
        return;
    }

    // 3. 成功处理：检查 GitHub PR
    logInfo(`[POST-HOOK] Agent 执行成功，开始检查 GitHub PR...`);
    let prUrl = null;
    try {
        const prOutput = execSync(`gh pr list --head ${branchName} --json url`, { cwd: worktreePath }).toString();
        const prs = JSON.parse(prOutput);
        if (prs.length > 0) prUrl = prs[0].url;
    } catch (e) {
        logError('检查 PR 失败，请确认是否安装并登录了 gh cli', e.message);
    }

    if (!prUrl) {
        logInfo(`[POST-HOOK] 未检测到 PR。可能 Agent 只是完成了本地验证。`);
        execSync(`osascript -e 'display notification "未检测到对应分支的 PR，请手动检查" with title "⚠️ 任务完成但无 PR" subtitle "${issueIdentifier}"'`);
        return;
    }

    // 4. 存在 PR，执行 Linear 状态流转 (In Progress -> In Review)
    logInfo(`[POST-HOOK] 检测到 PR: ${prUrl}。准备更新 Linear 状态...`);
    const issueData = await fetchLinearTaskWithStates(issueIdentifier);

    // 寻找团队中名为 'In Review' 的状态，或者类型为 'completed' 的状态
    const reviewState = issueData.team.states.nodes.find(s => s.name.toLowerCase() === 'in review') ||
        issueData.team.states.nodes.find(s => s.type === 'completed');

    if (reviewState) {
        await updateLinearState(issueData.id, reviewState.id);
        logInfo(`[POST-HOOK] 已将 Linear Issue 移动至: [${reviewState.name}]`);
    }

    // 5. 最终成功通知
    execSync(`osascript -e 'display notification "PR 已自动创建并移至 Review" with title "✅ ${issueIdentifier} 开发完成" subtitle "Token: ${tokenInfo}"'`);
}

// =================================================================
// 启动模式 (Start Mode)
// =================================================================
async function main() {
    // 拦截器：如果包含 --post-hook 参数，则直接进入钩子模式
    if (process.argv[2] === '--post-hook') {
        const [, , , issueId, exitCode, branch, wtPath, lPath] = process.argv;
        await runPostHook(issueId, exitCode, branch, wtPath, lPath);
        process.exit(0);
    }

    const projectName = process.argv[2];
    if (!projectName) {
        logError('请提供 Project 名称，例如: node start-task.js "My Project"');
        process.exit(1);
    }

    logInfo(`[Phase 1] 检查 Codex 余额...`);
    const usageCheck = checkCodexUsage(10);
    if (!usageCheck.ok) {
        logError(`Codex余额较低，暂停自动开发: ${usageCheck.message}`);
        process.exit(0);
    }
    logInfo(usageCheck.message);

    logInfo(`[Phase 2] 获取 Project [${projectName}] 下优先待办任务...`);
    const issueData = await fetchNextTodoIssue(projectName);

    if (!issueData) {
        logInfo(`✅ Project [${projectName}] 下没有找到 Todo (unstarted) 的任务。`);
        process.exit(0);
    }

    logInfo(`选定需求: [${issueData.identifier}] ${issueData.title} (当前状态: ${issueData.state.name}, Priority: ${issueData.priority})`);

    // --- A. Linear 状态前置流转 (Todo -> In Progress) ---
    // Linear 的 'started' 类型下可能有多个状态 (例如 In Progress, In Review)，甚至 In Review 可能排在前面。
    // 我们优先寻找名为 "In Progress" 的状态，否则找第一个类型为 started 且不是 review 相关的状态
    const startedStates = issueData.team.states.nodes.filter(s => s.type === 'started');
    let inProgressState = startedStates.find(s => s.name.toLowerCase() === 'in progress');
    if (!inProgressState && startedStates.length > 0) {
        // Fallback:找一个不包含 review 字眼的 started 状态
        inProgressState = startedStates.find(s => !s.name.toLowerCase().includes('review')) || startedStates[0];
    }

    if (inProgressState && issueData.state.name !== inProgressState.name) {
        logInfo(`正在将 Linear 状态更新为: [${inProgressState.name}]...`);
        await updateLinearState(issueData.id, inProgressState.id);
    }

    // --- B. 获取 Repo 与 OpenClaw Workspace，并准备项目目录 ---
    let repoUrl = null;
    if (issueData.project && issueData.project.externalLinks && issueData.project.externalLinks.nodes) {
        const repoLink = issueData.project.externalLinks.nodes.find(l => l.label && l.label.toLowerCase().includes('repo'));
        if (repoLink) repoUrl = repoLink.url;
    }

    if (!repoUrl) {
        logError(`无法在 Project [${projectName}] 的 External Links 中找到标题包含 "Repo" 的链接，无法自动拉取代码。`);
        process.exit(1);
    }

    logInfo(`找到项目 Repo: ${repoUrl}`);

    // 解析 Repo Name (例如从 https://github.com/khala-smith/openclaw-skills 提取 openclaw-skills)
    // 去掉结尾的 .git 和最后的斜杠
    const cleanRepoUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const repoName = cleanRepoUrl.substring(cleanRepoUrl.lastIndexOf('/') + 1);

    // 解析 ~/.openclaw/openclaw.json 获取 workspace
    const openclawConfigFile = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    let workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace'); // default fallback

    if (existsSync(openclawConfigFile)) {
        try {
            const configContent = readFileSync(openclawConfigFile, 'utf8');
            const configData = JSON.parse(configContent);
            if (configData?.agents?.defaults?.workspace) {
                // 如果是 "~/" 开头，则替换为 homedir
                let configuredWorkspace = configData.agents.defaults.workspace;
                if (configuredWorkspace.startsWith('~/')) {
                    configuredWorkspace = path.join(os.homedir(), configuredWorkspace.slice(2));
                }
                workspaceDir = configuredWorkspace;
            }
        } catch (e) {
            logError('读取 ~/.openclaw/openclaw.json 失败，使用默认 workspace。', e.message);
        }
    }

    logInfo(`使用 OpenClaw Workspace: ${workspaceDir}`);

    const codexProjectsDir = path.join(workspaceDir, 'codex-dev-projects');
    if (!existsSync(codexProjectsDir)) {
        logInfo(`创建 codex-dev-projects 目录...`);
        execSync(`mkdir -p "${codexProjectsDir}"`);
    }

    const targetRepoDir = path.join(codexProjectsDir, repoName);

    if (!existsSync(targetRepoDir)) {
        logInfo(`[Git] 目标目录不存在，开始 Clone 仓库...`);
        try {
            execSync(`git clone ${repoUrl} "${targetRepoDir}"`, { stdio: isDebug ? 'inherit' : 'ignore' });
        } catch (e) {
            logError('Git Clone 失败。', e.message); process.exit(1);
        }
    } else {
        logInfo(`[Git] 目录已存在，开始拉取最新代码 (Pull)...`);
        try {
            // 确保在主分支并且拉取最新
            execSync(`git fetch origin`, { cwd: targetRepoDir, stdio: 'ignore' });

            // 尝试找出默认主分支名 (main 或 master)
            let defaultBranch = 'main';
            const branches = execSync(`git branch -r`, { cwd: targetRepoDir }).toString();
            if (branches.includes('origin/master') && !branches.includes('origin/main')) {
                defaultBranch = 'master';
            }

            // 如果已经在工作树或者有未提交的更改可能会受影响，为了安全起见假设当前 repo 目录是干净的主干
            execSync(`git checkout ${defaultBranch}`, { cwd: targetRepoDir, stdio: 'ignore' });
            execSync(`git pull origin ${defaultBranch}`, { cwd: targetRepoDir, stdio: isDebug ? 'inherit' : 'ignore' });
        } catch (e) {
            logError('Git Pull 失败，请确保本地 codex-dev-projects 下的仓库没有未提交冲突。', e.message); process.exit(1);
        }
    }

    // --- C. 准备 Git Worktree 环境 ---
    // 之后的所有的操作都要基于 targetRepoDir!
    const safeTitle = issueData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const branchName = `feat/${issueData.identifier}-${safeTitle}`;
    // Worktree 创建在 targetRepoDir 同级，加上 -worktree 后缀，避免污染 repo 本身
    const worktreePath = path.resolve(targetRepoDir, '..', `${issueData.identifier}-worktree`);

    logInfo(`配置隔离开发环境 (Worktree)...`);
    if (existsSync(worktreePath)) {
        try { execSync(`git worktree remove -f "${worktreePath}"`, { cwd: targetRepoDir, stdio: 'ignore' }); }
        catch (e) { execSync(`rm -rf "${worktreePath}"`, { stdio: 'ignore' }); }
    }

    let baseBranch = 'origin/main';
    try {
        execSync(`git fetch origin`, { stdio: 'ignore' });
        const remoteBranches = execSync(`git branch -r`, { cwd: targetRepoDir }).toString();
        if (remoteBranches.includes('origin/master') && !remoteBranches.includes('origin/main')) {
            baseBranch = 'origin/master';
        }
    } catch (e) { baseBranch = 'HEAD'; }

    let branchExists = false;
    try { execSync(`git rev-parse --verify ${branchName}`, { cwd: targetRepoDir, stdio: 'ignore' }); branchExists = true; } catch (e) { }

    try {
        if (branchExists) execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: targetRepoDir, stdio: isDebug ? 'inherit' : 'ignore' });
        else execSync(`git worktree add "${worktreePath}" -b ${branchName} ${baseBranch}`, { cwd: targetRepoDir, stdio: isDebug ? 'inherit' : 'ignore' });

        if (existsSync(path.join(worktreePath, 'package.json'))) {
            logInfo(`📦 安装隔离区依赖...`);
            execSync(`npm install`, { cwd: worktreePath, stdio: isDebug ? 'inherit' : 'ignore' });
        }
    } catch (e) {
        logError('Worktree 创建失败。', e.message); process.exit(1);
    }

    // --- C. 生成 Prompt ---
    await fs.mkdir(PROMPTS_DIR, { recursive: true });
    const promptPath = path.join(PROMPTS_DIR, `${issueData.identifier}.txt`);
    const promptContent = `
# TASK: [${issueData.identifier}] ${issueData.title}
## DESCRIPTION
${issueData.description || 'N/A'}

## HARNESS RULES
You are an autonomous engineer. 
1. The repository is the single source of truth. Use tools to explore.
2. You MUST run local linters/tests to verify work.
3. FIX FORWARD: If a test fails, read output and fix it.
4. DEFINITION OF DONE: Code is verified, committed, pushed, and you have created a GitHub PR referencing ${issueData.identifier}.
`.trim();
    await fs.writeFile(promptPath, promptContent, 'utf-8');

    // --- D. 启动 Agent & 注入 Post-Hook 回调 ---
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.mkdir(RUNNERS_DIR, { recursive: true });

    const logPath = path.join(LOGS_DIR, `${issueData.identifier}.log`);
    const runnerPath = path.join(RUNNERS_DIR, `run-${issueData.identifier}.sh`);
    const sessionName = `agent-${issueData.identifier}`;

    // ✨ 核心：Runner 结束后，调用本脚本的 --post-hook 模式
    // 注意脚本路径现在可能是在 scripts/ 下，不需要变，只要 __filename 准确即可
    const runnerScript = `#!/bin/bash
source ~/.zshrc 2>/dev/null || true
cd "${worktreePath}"

echo "[$(date)] 🚀 开始执行 Agent: ${issueData.identifier}" > "${logPath}"

codex exec --model gpt-5.3-codex -c 'model_reasoning_effort=high' --dangerously-bypass-approvals-and-sandbox "$(cat '${promptPath}')" >> "${logPath}" 2>&1
AGENT_EXIT_CODE=$?

echo "[$(date)] 🏁 Agent 执行完毕，退出码: $AGENT_EXIT_CODE" >> "${logPath}"

# 回调触发 Post-Hook 状态流转
node "${__filename}" --post-hook "${issueData.identifier}" "$AGENT_EXIT_CODE" "${branchName}" "${worktreePath}" "${logPath}" >> "${logPath}" 2>&1

exec bash
`;

    await fs.writeFile(runnerPath, runnerScript, { mode: 0o755 });

    try {
        try { execSync(`tmux kill-session -t "${sessionName}" >/dev/null 2>&1`); } catch (e) { }
        execSync(`tmux new-session -d -s "${sessionName}" -c "${worktreePath}" "${runnerPath}"`);
        logInfo(`✅ Tmux 已启动，Agent 正在后台工作。`);
        logInfo(`👉 实时监控进度: tail -f ${logPath}`);
    } catch (e) {
        logError('启动 Tmux 失败', e.message); process.exit(1);
    }
}

main();
