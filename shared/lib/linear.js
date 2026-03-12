/**
 * linear.js — Linear GraphQL API 客户端
 */

import { getLinearApiKey } from './config.js';

async function callLinearAPI(query, variables) {
    const apiKey = getLinearApiKey();
    if (!apiKey) throw new Error('未设置 LINEAR_API_KEY。请配置 ~/.openclaw/openclaw.json 或环境变量。');
    const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
        body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    const result = await response.json();
    if (result.errors) throw new Error(`GraphQL Error: ${result.errors[0].message}`);
    return result.data;
}

// ── 查询类 ──────────────────────────────────────────────────────

export async function fetchProjectInfo(projectName) {
    const query = `
        query GetProject($name: String!) {
            projects(filter: { name: { eqIgnoreCase: $name } }, first: 1) {
                nodes {
                    id name description
                    state
                    progress
                    externalLinks { nodes { label url } }
                }
            }
        }
    `;
    const data = await callLinearAPI(query, { name: projectName });
    return data?.projects?.nodes?.[0] || null;
}

export async function fetchProjectIssues(projectName) {
    const query = `
        query GetIssuesByProject($projectName: String!) {
            issues(
                filter: { project: { name: { eqIgnoreCase: $projectName } } }
                first: 200
            ) {
                nodes {
                    id identifier title description priority createdAt
                    state { name type }
                    labels { nodes { name } }
                    parent { identifier title }
                    children { nodes { identifier title state { name } } }
                    project { name externalLinks { nodes { label url } } }
                    team { id key states { nodes { id name type } } }
                }
            }
        }
    `;
    const data = await callLinearAPI(query, { projectName });
    return data?.issues?.nodes || [];
}

export async function fetchNextTodoIssue(projectName, labelFilter = null) {
    let filter = `
        project: { name: { eqIgnoreCase: $projectName } }
        state: { type: { in: ["unstarted", "backlog"] } }
    `;
    if (labelFilter) {
        filter += `labels: { name: { eqIgnoreCase: "${labelFilter}" } }`;
    }

    const query = `
        query GetTodoIssues($projectName: String!) {
            issues(
                filter: { ${filter} }
                first: 50
            ) {
                nodes {
                    id identifier title description priority createdAt
                    state { name }
                    labels { nodes { name } }
                    parent { identifier title description }
                    team { id key states { nodes { id name type } } }
                    project { name externalLinks { nodes { label url } } }
                }
            }
        }
    `;
    const data = await callLinearAPI(query, { projectName });
    const issues = data?.issues?.nodes || [];
    if (issues.length === 0) return null;

    const w = (p) => (p === 0 ? 99 : p);
    issues.sort((a, b) => {
        const diff = w(a.priority) - w(b.priority);
        if (diff !== 0) return diff;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    return issues[0];
}

export async function fetchIssueById(issueIdentifier) {
    const query = `
        query Issue($id: String!) {
            issue(id: $id) {
                id identifier title description url
                state { name type }
                labels { nodes { name } }
                parent { identifier title description }
                children { nodes { identifier title state { name } } }
                team { id key states { nodes { id name type } } }
                project { name externalLinks { nodes { label url } } }
            }
        }
    `;
    const data = await callLinearAPI(query, { id: issueIdentifier });
    return data?.issue || null;
}

// ── 变更类 ──────────────────────────────────────────────────────

export async function updateIssueState(issueInternalId, stateId) {
    const query = `
        mutation UpdateIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }
    `;
    await callLinearAPI(query, { id: issueInternalId, stateId });
}

export async function createIssue({ teamId, projectId, title, description, priority, labelIds, parentId }) {
    const input = { teamId, title, description };
    if (projectId) input.projectId = projectId;
    if (priority != null) input.priority = priority;
    if (labelIds?.length) input.labelIds = labelIds;
    if (parentId) input.parentId = parentId;

    const query = `
        mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
                success
                issue { id identifier title url }
            }
        }
    `;
    const data = await callLinearAPI(query, { input });
    return data?.issueCreate?.issue || null;
}

export async function findOrCreateLabel(teamId, labelName) {
    // 先查找已有的
    const searchQuery = `
        query FindLabel($teamId: ID!, $name: String!) {
            issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }, first: 1) {
                nodes { id name }
            }
        }
    `;
    const searchData = await callLinearAPI(searchQuery, { teamId, name: labelName });
    const existing = searchData?.issueLabels?.nodes?.[0];
    if (existing) return existing.id;

    // 不存在则创建
    const createQuery = `
        mutation CreateLabel($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) { success issueLabel { id name } }
        }
    `;
    const createData = await callLinearAPI(createQuery, { input: { teamId, name: labelName } });
    return createData?.issueLabelCreate?.issueLabel?.id || null;
}

export function getRepoUrl(project) {
    const link = project?.externalLinks?.nodes?.find(
        l => l.label && l.label.toLowerCase().includes('repo')
    );
    return link?.url || null;
}

export function extractRepoName(repoUrl) {
    const clean = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    return clean.substring(clean.lastIndexOf('/') + 1);
}
