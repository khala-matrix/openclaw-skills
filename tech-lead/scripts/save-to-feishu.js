/**
 * save-to-feishu.js — 将设计文档发布到飞书
 *
 * 用法: node save-to-feishu.js "<designFilePath>" [folderToken]
 *
 * 读取本地 Markdown 设计文档，创建为飞书云文档。
 * 输出: JSON { doc_id, doc_url }
 */

import { readFileSync } from 'fs';
import { createFeishuDoc } from '../../shared/lib/feishu.js';
import { logInfo, logError } from '../../shared/lib/logger.js';

async function main() {
    const designFilePath = process.argv[2];
    const folderToken = process.argv[3]; // 可选

    if (!designFilePath) {
        logError('用法: node save-to-feishu.js "<designFilePath>" [folderToken]');
        process.exit(1);
    }

    // 读取设计文档
    let content;
    try {
        content = readFileSync(designFilePath, 'utf8');
    } catch (e) {
        logError(`无法读取文件: ${designFilePath} — ${e.message}`);
        process.exit(1);
    }

    // 从内容中提取标题（第一个 # 开头的行）
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : '技术设计文档';

    // 去掉第一行标题（飞书会用 title 参数作为文档标题）
    const markdown = titleMatch
        ? content.replace(/^#\s+.+\n*/, '').trim()
        : content;

    // 创建飞书文档
    const options = {};
    if (folderToken) options.folderToken = folderToken;

    const result = await createFeishuDoc(title, markdown, options);

    console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
    logError('save-to-feishu 执行异常', err.message);
    process.exit(1);
});
