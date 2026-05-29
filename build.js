#!/usr/bin/env node
/**
 * 构建脚本：从 ima OpenAPI 抓取个人知识库数据 + 完整内容，生成纯静态站点
 * 用法: node build.js
 * 输出: dist/ 目录
 * 
 * 只处理个人/共享知识库（忽略订阅知识库）
 * 内容下载策略：
 *   - 图片 (type=9) → 下载 → base64 data URI
 *   - Markdown (type=7) → 下载原文 → 嵌入
 *   - Word (type=3) → 下载 .docx → mammoth 转 HTML → 嵌入
 *   - WebURL (type=2) → 存外部 URL
 *   - 文件夹 (type=99) → 跳过
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const IMA_BASE = 'https://ima.qq.com/openapi/wiki/v1';
const IMA_CLIENT_ID = process.env.IMA_CLIENT_ID || '5658e70b495f5226921bd8cb0acb48bb';
const IMA_API_KEY = process.env.IMA_API_KEY || 'Ll0kh/v5fbGlHgPFVWaU/lz7Cc6yRVvrn28NX+J3BCMl1D9UMim+Qvt8q/kFN2pCL0zlgd5fXg==';

const MEDIA_TYPES = { 1: 'PDF', 2: 'WebURL', 3: 'Word', 4: 'PPT', 6: 'WeChat', 7: 'Markdown', 9: 'Image', 11: 'Note', 99: 'Folder' };

// ===== HTTP helpers =====
function imaRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${IMA_BASE}/${endpoint}`);
    const postData = JSON.stringify(body);
    const options = {
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'ima-openapi-clientid': IMA_CLIENT_ID, 'ima-openapi-apikey': IMA_API_KEY,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0) resolve(json.data);
          else reject(new Error(`IMA API Error [${json.code}]: ${json.msg}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData); req.end();
  });
}

function downloadWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname, port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search, method: 'GET', headers: headers || {}
    };
    const req = mod.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadWithHeaders(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.end();
  });
}

function downloadText(url, headers) {
  return downloadWithHeaders(url, headers).then(buf => buf.toString('utf-8'));
}

// ===== mammoth for Word → HTML =====
let mammoth = null;
async function convertDocxToHtml(docxBuffer) {
  if (!mammoth) {
    try {
      mammoth = require('mammoth');
    } catch (e) {
      console.log('  ⚠️ mammoth 未安装，Word 文档将作为下载链接提供');
      return null;
    }
  }
  const result = await mammoth.convertToHtml({ buffer: docxBuffer });
  // Replace base64 images with placeholders to reduce size
  let html = result.value;
  html = html.replace(/<img[^>]*src="data:image\/[^"]*"[^>]*>/g, '<div style="background:#f0f0f5;border:1px dashed #ccc;border-radius:8px;padding:20px;text-align:center;color:#999;margin:12px 0">📎 图片（请下载原文查看）</div>');
  return html;
}

// ===== Main build =====
async function build() {
  console.log('🔨 开始构建静态站点（仅个人/共享知识库）...');

  // 1. Fetch all KBs
  const kbList = [];
  let cursor = '';
  do {
    const result = await imaRequest('search_knowledge_base', { query: '', cursor, limit: 20 });
    if (result.info_list) kbList.push(...result.info_list);
    cursor = result.is_end ? null : result.next_cursor;
  } while (cursor);
  console.log(`📚 找到 ${kbList.length} 个知识库`);

  // 2. Filter to personal/shared only
  const personalKBs = [];
  for (const kb of kbList) {
    let kbInfo = kb;
    try {
      const detail = await imaRequest('get_knowledge_base', { ids: [kb.kb_id] });
      if (detail.infos && detail.infos[kb.kb_id]) kbInfo = { ...kb, ...detail.infos[kb.kb_id] };
    } catch (e) { /* use basic info */ }

    // 只保留 LIANG-AI 知识库
    if (kb.kb_name !== 'LIANG-AI') {
      console.log(`  ⏭️ 跳过: "${kb.kb_name}"`);
      continue;
    }
    personalKBs.push(kbInfo);
  }

  if (personalKBs.length === 0) {
    console.log('❌ 没有找到个人/共享知识库');
    process.exit(1);
  }

  // 3. Fetch items for each personal KB
  const knowledgeBases = [];
  let totalItems = 0;

  for (const kb of personalKBs) {
    const items = [];
    let itemCursor = '';
    let page = 0;
    try {
      do {
        const listResult = await imaRequest('get_knowledge_list', {
          knowledge_base_id: kb.kb_id, cursor: itemCursor, limit: 50
        });
        if (listResult.knowledge_list) items.push(...listResult.knowledge_list);
        itemCursor = listResult.is_end ? null : listResult.next_cursor;
        page++;
        if (page > 20) break;
      } while (itemCursor);
    } catch (e) {
      console.log(`  ❌ 获取列表失败 "${kb.kb_name}": ${e.message}`);
    }

    // Filter out folders
    const contentItems = items.filter(item => item.media_type !== 99);
    totalItems += contentItems.length;
    console.log(`  ✅ "${kb.kb_name}" (${kb.base_type}): ${contentItems.length} 条内容`);

    knowledgeBases.push({
      id: kb.kb_id, name: kb.kb_name, description: kb.description || '',
      coverUrl: kb.cover_url || '', baseType: kb.base_type,
      contentCount: kb.content_count || String(contentItems.length),
      items: contentItems
    });
  }

  // 4. Fetch content details for each item
  console.log('\n📥 开始下载内容...');
  let successCount = 0;
  let failCount = 0;

  for (const kb of knowledgeBases) {
    for (const item of kb.items) {
      if (!item.media_id) continue;
      const typeLabel = MEDIA_TYPES[item.media_type] || `type${item.media_type}`;
      
      try {
        const mediaInfo = await imaRequest('get_media_info', { media_id: item.media_id });
        const urlInfo = mediaInfo.url_info;
        const notebookInfo = mediaInfo.notebook_ext_info;

        item.mediaTypeLabel = MEDIA_TYPES[mediaInfo.media_type] || typeLabel;

        if (notebookInfo && notebookInfo.content) {
          // Notebook with content directly
          item.contentData = { type: 'notebook', html: notebookInfo.content, title: notebookInfo.title || item.title };
          successCount++;
          console.log(`    ✅ [${item.mediaTypeLabel}] ${item.title} (notebook, ${notebookInfo.content.length} chars)`);
        } else if (urlInfo && urlInfo.url) {
          const downloadUrl = urlInfo.url;
          const downloadHeaders = urlInfo.headers || {};

          switch (mediaInfo.media_type) {
            case 9: { // Image → base64
              const buf = await downloadWithHeaders(downloadUrl, downloadHeaders);
              const ext = path.extname(item.title || downloadUrl).toLowerCase().replace('.', '') || 'png';
              const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
              item.contentData = { type: 'image', dataUri: `data:${mimeType};base64,${buf.toString('base64')}` };
              const sizeKB = (buf.length / 1024).toFixed(0);
              successCount++;
              console.log(`    ✅ [Image] ${item.title} (${sizeKB} KB)`);
              break;
            }
            case 7: { // Markdown → raw text
              const text = await downloadText(downloadUrl, downloadHeaders);
              item.contentData = { type: 'markdown', text };
              successCount++;
              console.log(`    ✅ [Markdown] ${item.title} (${text.length} chars)`);
              break;
            }
            case 3: { // Word → mammoth to HTML
              const buf = await downloadWithHeaders(downloadUrl, downloadHeaders);
              const html = await convertDocxToHtml(buf);
              if (html) {
                item.contentData = { type: 'html', html, docxSize: buf.length };
                successCount++;
                console.log(`    ✅ [Word→HTML] ${item.title} (${html.length} chars)`);
              } else {
                // mammoth not available, provide as download
                const base64 = buf.toString('base64');
                item.contentData = { type: 'download', dataUri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${base64}`, filename: item.title };
                successCount++;
                console.log(`    ✅ [Word→Download] ${item.title} (${(buf.length / 1024).toFixed(0)} KB)`);
              }
              break;
            }
            case 1: { // PDF → base64 data URI
              const buf = await downloadWithHeaders(downloadUrl, downloadHeaders);
              item.contentData = { type: 'pdf', dataUri: `data:application/pdf;base64,${buf.toString('base64')}` };
              successCount++;
              console.log(`    ✅ [PDF] ${item.title} (${(buf.length / 1024).toFixed(0)} KB)`);
              break;
            }
            case 2: { // WebURL → external link
              item.contentData = { type: 'weburl', url: downloadUrl };
              successCount++;
              console.log(`    ✅ [WebURL] ${item.title}`);
              break;
            }
            case 4: { // PPT → download
              const buf = await downloadWithHeaders(downloadUrl, downloadHeaders);
              item.contentData = { type: 'download', dataUri: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${buf.toString('base64')}`, filename: item.title };
              successCount++;
              console.log(`    ✅ [PPT→Download] ${item.title} (${(buf.length / 1024).toFixed(0)} KB)`);
              break;
            }
            case 6: { // WeChat article → try fetch content
              item.contentData = { type: 'weburl', url: downloadUrl };
              successCount++;
              console.log(`    ✅ [WeChat] ${item.title} (external link)`);
              break;
            }
            default: {
              item.contentData = { type: 'unknown', mediaType: mediaInfo.media_type };
              successCount++;
              console.log(`    ✅ [Unknown:${mediaInfo.media_type}] ${item.title}`);
            }
          }
        } else {
          item.contentData = { type: 'empty' };
          failCount++;
          console.log(`    ⚠️ 无URL: ${item.title}`);
        }
      } catch (e) {
        item.contentData = { type: 'error', message: e.message };
        failCount++;
        console.log(`    ❌ ${item.title}: ${e.message}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 150));
    }
  }

  console.log(`\n📊 内容下载完成: ${successCount} 成功, ${failCount} 失败`);

  // 5. Write dist
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  const data = {
    updatedAt: new Date().toISOString(),
    totalKBs: knowledgeBases.length,
    totalItems: knowledgeBases.reduce((s, kb) => s + kb.items.length, 0),
    knowledgeBases
  };

  const jsonStr = JSON.stringify(data);
  const sizeMB = (Buffer.byteLength(jsonStr) / 1024 / 1024).toFixed(2);
  fs.writeFileSync(path.join(distDir, 'data.json'), jsonStr);
  console.log(`💾 数据写入 dist/data.json (${sizeMB} MB)`);

  // 6. Copy index.html
  const htmlSrc = fs.readFileSync(path.join(__dirname, 'public', 'index-static.html'), 'utf8');
  fs.writeFileSync(path.join(distDir, 'index.html'), htmlSrc);
  console.log('📄 写入 dist/index.html');

  console.log('\n✅ 构建完成！');
  console.log(`   个人/共享知识库: ${data.totalKBs} 个`);
  console.log(`   内容条目: ${data.totalItems} 条`);
}

build().catch(e => { console.error('❌ 构建失败:', e); process.exit(1); });
