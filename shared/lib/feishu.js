/**
 * feishu.js — 飞书文档操作（通过 MCP 接口）
 *
 * 从 macOS Keychain 读取已存储的 UAT，调用飞书 MCP 接口创建/更新文档。
 * 依赖 openclaw-feishu-uat keychain 条目（由 openclaw feishu 插件 OAuth 流程写入）。
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { logInfo, logError } from './logger.js';

const MCP_ENDPOINT = process.env.FEISHU_MCP_ENDPOINT || 'https://mcp.feishu.cn/mcp';
const KEYCHAIN_SERVICE = 'openclaw-feishu-uat';

/**
 * 从 openclaw.json 读取飞书 appId
 */
function getFeishuAppId() {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        return config?.channels?.feishu?.appId || null;
    } catch {
        return null;
    }
}

/**
 * 从 macOS Keychain 读取存储的 UAT
 */
function getStoredUAT(appId) {
    try {
        // 列出所有该 service 下的条目，找到匹配 appId 的
        const raw = execSync(
            `security find-generic-password -s "${KEYCHAIN_SERVICE}" -g 2>&1`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );

        // 提取 account 名（格式: appId:userOpenId）
        const acctMatch = raw.match(/"acct"<blob>="([^"]+)"/);
        if (!acctMatch) return null;

        const account = acctMatch[1];
        if (!account.startsWith(appId + ':')) return null;

        // 读取密码（即 token JSON）
        const password = execSync(
            `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
            { encoding: 'utf8' }
        ).trim();

        return JSON.parse(password);
    } catch {
        return null;
    }
}

/**
 * 刷新 UAT（如果即将过期）
 */
async function refreshUATIfNeeded(token) {
    const now = Date.now();
    const REFRESH_AHEAD_MS = 5 * 60 * 1000;

    if (now < token.expiresAt - REFRESH_AHEAD_MS) {
        return token; // 还有效
    }

    if (now >= token.refreshExpiresAt) {
        throw new Error('UAT 和 refresh_token 均已过期，请通过飞书重新授权');
    }

    // 刷新 token
    logInfo('UAT 即将过期，正在刷新...');
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const appSecret = config?.channels?.feishu?.appSecret;

    if (!appSecret) throw new Error('未找到飞书 appSecret');

    const resp = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: token.refreshToken,
            client_id: token.appId,
            client_secret: appSecret,
        }).toString(),
    });

    const data = await resp.json();
    if (data.code !== 0 && data.error) {
        throw new Error(`UAT 刷新失败: ${data.error_description || data.msg || JSON.stringify(data)}`);
    }

    const updated = {
        ...token,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || token.refreshToken,
        expiresAt: now + (data.expires_in || 7200) * 1000,
        refreshExpiresAt: data.refresh_token_expires_in
            ? now + data.refresh_token_expires_in * 1000
            : token.refreshExpiresAt,
    };

    // 写回 Keychain（用 execFileSync 避免 shell 注入）
    const account = `${token.appId}:${token.userOpenId}`;
    try {
        try { execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]); } catch { /* not found */ }
        execFileSync('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', JSON.stringify(updated)]);
    } catch {
        logError('写回 Keychain 失败，但 token 仍可使用');
    }

    logInfo('UAT 刷新成功');
    return updated;
}

/**
 * 获取可用的 UAT access_token
 */
async function getAccessToken() {
    const appId = getFeishuAppId();
    if (!appId) throw new Error('未找到飞书 appId，请检查 ~/.openclaw/openclaw.json');

    const token = getStoredUAT(appId);
    if (!token) throw new Error('未找到飞书 UAT，请先通过飞书对话完成 OAuth 授权');

    const refreshed = await refreshUATIfNeeded(token);
    return refreshed.accessToken;
}

/**
 * 调用飞书 MCP 工具
 */
async function callMcp(toolName, args) {
    const uat = await getAccessToken();
    const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const body = {
        jsonrpc: '2.0',
        id: toolCallId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    };

    const resp = await fetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Lark-MCP-UAT': uat,
            'X-Lark-MCP-Allowed-Tools': toolName,
        },
        body: JSON.stringify(body),
    });

    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`MCP HTTP ${resp.status}: ${text.slice(0, 1000)}`);
    }

    const data = JSON.parse(text);
    if (data.error) {
        throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    }

    // 解包 JSON-RPC result
    let result = data.result || data;
    if (result.result) result = result.result;

    // 解析 content
    if (result.content && Array.isArray(result.content)) {
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent) {
            try { return JSON.parse(textContent.text); } catch { return textContent.text; }
        }
    }

    return result;
}

/**
 * 创建飞书文档
 * @param {string} title 文档标题
 * @param {string} markdown 文档内容（Lark-flavored Markdown）
 * @param {object} options 可选参数
 * @param {string} options.folderToken 父文件夹 token
 * @param {string} options.wikiNode 知识库节点 token
 * @param {string} options.wikiSpace 知识空间 ID
 * @returns {{ doc_id: string, doc_url: string, message: string }}
 */
export async function createFeishuDoc(title, markdown, options = {}) {
    const args = { title, markdown };
    if (options.folderToken) args.folder_token = options.folderToken;
    if (options.wikiNode) args.wiki_node = options.wikiNode;
    if (options.wikiSpace) args.wiki_space = options.wikiSpace;

    logInfo(`正在创建飞书文档: ${title}`);
    const result = await callMcp('create-doc', args);
    logInfo(`飞书文档创建成功: ${result.doc_url || JSON.stringify(result)}`);
    return result;
}
