/**
 * check-usage.js
 * 从 ~/.codex/sessions/ 读取最近一次 session 的 rate_limits 数据，
 * 判断 Codex 余额是否充足。
 *
 * 用法 (standalone):  node check-usage.js
 * 用法 (module):      import { checkCodexUsage } from './check-usage.js';
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------
// 核心：从最近的 session jsonl 中提取 rate_limits
// ---------------------------------------------------------------

/**
 * 找到 ~/.codex/sessions/ 下最新的 .jsonl 文件
 */
function findLatestSessionFile() {
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (!existsSync(sessionsRoot)) return null;

    // 递归遍历 sessions/<year>/<month>/<day>/ 结构
    const allFiles = [];
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.jsonl')) allFiles.push(full);
        }
    }
    walk(sessionsRoot);

    if (allFiles.length === 0) return null;

    // 按文件名（含时间戳）降序排列，取最新的
    allFiles.sort().reverse();
    return allFiles[0];
}

/**
 * 从 .jsonl 文件中提取最后一条包含 rate_limits 的 token_count 事件
 */
function extractRateLimits(filePath) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');

    let lastRateLimits = null;
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry?.payload?.type === 'token_count' && entry?.payload?.rate_limits) {
                lastRateLimits = entry.payload.rate_limits;
            }
        } catch { /* skip malformed lines */ }
    }
    return lastRateLimits;
}

// ---------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------

/**
 * 检查 Codex 使用余额。
 * @param {number} thresholdPercent - 低于此百分比的剩余余额时视为不足 (默认 10)
 * @returns {{ ok: boolean, remainingPercent: number, usedPercent: number, message: string }}
 */
export function checkCodexUsage(thresholdPercent = 10) {
    const sessionFile = findLatestSessionFile();
    if (!sessionFile) {
        return {
            ok: true,
            remainingPercent: -1,
            usedPercent: -1,
            message: '⚠️ 未找到 Codex session 文件，跳过余额检查。',
        };
    }

    const rateLimits = extractRateLimits(sessionFile);
    if (!rateLimits || !rateLimits.primary) {
        return {
            ok: true,
            remainingPercent: -1,
            usedPercent: -1,
            message: '⚠️ Session 文件中未找到 rate_limits 数据，跳过余额检查。',
        };
    }

    // primary.used_percent: 已使用的百分比 (0-100 的小数, 如 1.0 表示 1%)
    // 转换为标准百分比
    const usedPercent = rateLimits.primary.used_percent;
    const remainingPercent = 100 - usedPercent;
    const ok = remainingPercent >= thresholdPercent;

    return {
        ok,
        remainingPercent: Math.round(remainingPercent * 100) / 100,
        usedPercent: Math.round(usedPercent * 100) / 100,
        message: ok
            ? `✅ Codex 余额充足: 剩余 ${remainingPercent.toFixed(1)}%`
            : `⛔ Codex 余额较低: 剩余 ${remainingPercent.toFixed(1)}% (阈值 ${thresholdPercent}%)`,
    };
}

// ---------------------------------------------------------------
// standalone 入口
// ---------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
    const result = checkCodexUsage();
    console.log(JSON.stringify(result, null, 2));
}
