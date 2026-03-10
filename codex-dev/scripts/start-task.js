import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
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

    // 寻找团队中类型为 'review' 或 'completed' 的状态
    const reviewState = issueData.team.states.nodes.find(s => s.type === 'review') ||
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
    const inProgressState = issueData.team.states.nodes.find(s => s.type === 'started');
    if (inProgressState && issueData.state.name !== inProgressState.name) {
        logInfo(`正在将 Linear 状态更新为: [${inProgressState.name}]...`);
        await updateLinearState(issueData.id, inProgressState.id);
    }

    // --- B. 准备 Git Worktree 环境 ---
    const safeTitle = issueData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const branchName = `feat/${issueData.identifier}-${safeTitle}`;
    const worktreePath = path.resolve(PROJECT_ROOT, '..', `${issueData.identifier}-worktree`);

    logInfo(`配置隔离开发环境...`);
    if (existsSync(worktreePath)) {
        try { execSync(`git worktree remove -f ${worktreePath}`, { stdio: 'ignore' }); }
        catch (e) { execSync(`rm -rf ${worktreePath}`, { stdio: 'ignore' }); }
    }

    let baseBranch = 'origin/main';
    try {
        execSync(`git fetch origin`, { stdio: 'ignore' });
        const remoteBranches = execSync(`git branch -r`).toString();
        if (remoteBranches.includes('origin/master') && !remoteBranches.includes('origin/main')) {
            baseBranch = 'origin/master';
        }
    } catch (e) { baseBranch = 'HEAD'; }

    let branchExists = false;
    try { execSync(`git rev-parse --verify ${branchName}`, { stdio: 'ignore' }); branchExists = true; } catch (e) { }

    try {
        if (branchExists) execSync(`git worktree add ${worktreePath} ${branchName}`, { stdio: isDebug ? 'inherit' : 'ignore' });
        else execSync(`git worktree add ${worktreePath} -b ${branchName} ${baseBranch}`, { stdio: isDebug ? 'inherit' : 'ignore' });

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
