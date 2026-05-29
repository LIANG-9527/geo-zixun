/**
 * GEO资讯 - 动态服务端
 * 
 * 部署到任意支持 Node.js 的平台（Sealos / Railway / Render 等）
 * 启动后自动从 ima OpenAPI 实时拉取 LIANG-AI 知识库数据
 */

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 配置 =====
const IMA_BASE = 'https://ima.qq.com/openapi/wiki/v1';
const IMA_CLIENT_ID = process.env.IMA_CLIENT_ID || '5658e70b495f5226921bd8cb0acb48bb';
const IMA_API_KEY = process.env.IMA_API_KEY || 'Ll0kh/v5fbGlHgPFVWaU/lz7Cc6yRVvrn28NX+J3BCMl1D9UMim+Qvt8q/kFN2pCL0zlgd5fXg==';
const TARGET_KB = 'LIANG-AI';

// 缓存
let cache = { data: null, updatedAt: null, ttl: 60 * 60 * 1000 }; // 1小时

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== IMA API =====
function imaRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${IMA_BASE}/${endpoint}`);
    const postData = JSON.stringify(body);
    const options = {
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'ima-openapi-clientid': IMA_CLIENT_ID,
        'ima-openapi-apikey': IMA_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0) resolve(json.data);
          else reject(new Error(`API Error [${json.code}]: ${json.msg}`));
        } catch (e) { reject(new Error(`Parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData); req.end();
  });
}

// ===== 下载内容并转 base64 =====
function downloadContent(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname, port: parsed.port || 443,
      path: parsed.pathname + parsed.search, method: 'GET', headers
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadContent(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // 20MB 限制
        if (buf.length > 20 * 1024 * 1024) {
          resolve(null); // 太大，跳过
        } else {
          resolve(buf);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.end();
  });
}

// ===== 获取完整知识库数据（含内容） =====
async function fetchAllData() {
  console.log('[fetch] 开始获取数据...');
  const typeNames = { 1: 'PDF', 2: '网页', 3: 'Word', 4: 'PPT', 6: '微信文章', 7: 'Markdown', 9: '图片', 11: '笔记', 99: '文件夹' };

  // 1. 搜索知识库
  const kbList = [];
  let cursor = '';
  do {
    const result = await imaRequest('search_knowledge_base', { query: '', cursor, limit: 20 });
    if (result.info_list) kbList.push(...result.info_list);
    cursor = result.is_end ? null : result.next_cursor;
  } while (cursor);

  // 2. 只保留 LIANG-AI
  const targetKB = kbList.find(k => k.kb_name === TARGET_KB);
  if (!targetKB) throw new Error(`未找到知识库: ${TARGET_KB}`);

  console.log(`[fetch] 找到 "${TARGET_KB}"`);

  // 3. 获取知识库详情
  let kbInfo = targetKB;
  try {
    const detail = await imaRequest('get_knowledge_base', { ids: [targetKB.kb_id] });
    if (detail.infos && detail.infos[targetKB.kb_id]) kbInfo = { ...targetKB, ...detail.infos[targetKB.kb_id] };
  } catch (e) { console.log(`[fetch] 详情获取失败: ${e.message}`); }

  // 4. 获取知识条目列表
  const items = [];
  let itemCursor = '';
  do {
    const listResult = await imaRequest('get_knowledge_list', { knowledge_base_id: targetKB.kb_id, cursor: itemCursor, limit: 50 });
    if (listResult.knowledge_list) items.push(...listResult.knowledge_list);
    itemCursor = listResult.is_end ? null : listResult.next_cursor;
  } while (itemCursor);

  console.log(`[fetch] ${items.length} 条内容`);

  // 5. 下载每条内容的详情
  let success = 0, fail = 0;
  for (const item of items) {
    const mid = item.media_id;
    if (!mid || item.media_type === 99) continue;

    try {
      const mediaInfo = await imaRequest('get_media_info', { media_id: mid });
      const mt = mediaInfo.media_type || item.media_type;
      const typeLabel = typeNames[mt] || '其他';
      
      item.mediaType = mt;
      item.contentData = { type: 'unknown' };

      // 图片 → 下载转 base64
      if (mt === 9 && mediaInfo.url_info) {
        const buf = await downloadContent(mediaInfo.url_info.url, mediaInfo.url_info.headers || {});
        if (buf) {
          const ext = mediaInfo.url_info.url.split('.').pop().split('?')[0] || 'png';
          const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
          item.contentData = { type: 'image', src: `data:${mime};base64,${buf.toString('base64')}` };
        }
      }

      // Markdown / Word / PDF → 下载原文
      if ((mt === 7 || mt === 3 || mt === 1) && mediaInfo.url_info) {
        const buf = await downloadContent(mediaInfo.url_info.url, mediaInfo.url_info.headers || {});
        if (buf) {
          if (mt === 7) {
            item.contentData = { type: 'markdown', text: buf.toString('utf-8').substring(0, 50000) };
          } else if (mt === 3) {
            // Word: 存为 base64 供前端 mammoth.js 解析（或标记为需客户端查看）
            item.contentData = { type: 'document', label: 'Word文档', hint: '请使用 IMA 客户端查看完整内容' };
          } else if (mt === 1) {
            item.contentData = { type: 'document', label: 'PDF文档', size: buf.length, hint: '请使用 IMA 客户端查看完整内容' };
          }
        }
      }

      // 网页 → 外链
      if (mt === 2 && mediaInfo.url_info) {
        item.contentData = { type: 'web', url: mediaInfo.url_info.url };
      }

      // 微信文章 → 外链
      if (mt === 6) {
        item.contentData = { type: 'web', url: item.raw_url || item.url || '', label: '微信文章' };
      }

      // 笔记 → 文本内容
      if (mt === 11 && mediaInfo.notebook_ext_info) {
        const nb = mediaInfo.notebook_ext_info;
        item.contentData = { type: 'note', title: nb.title || '', content: nb.content || nb.markdown_content || '' };
      }

      success++;
      console.log(`  ✅ [${typeLabel}] ${item.title}`);
    } catch (e) {
      fail++;
      item.contentData = { type: 'error', error: e.message };
      console.log(`  ❌ ${item.title}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 100)); // 限速
  }

  console.log(`[fetch] 内容下载: ${success} 成功, ${fail} 失败`);

  const kb = {
    id: targetKB.kb_id,
    name: targetKB.kb_name,
    description: kbInfo.description || '',
    coverUrl: kbInfo.cover_url || '',
    baseType: kbInfo.base_type || '',
    roleType: kbInfo.role_type || '',
    items
  };

  return {
    updatedAt: new Date().toISOString(),
    totalKBs: 1,
    totalItems: items.length,
    knowledgeBases: [kb]
  };
}

// ===== 获取缓存数据 =====
async function getData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.data && cache.updatedAt && (now - cache.updatedAt < cache.ttl)) {
    return cache.data;
  }
  console.log('[cache] 缓存过期，重新获取...');
  const data = await fetchAllData();
  cache.data = data;
  cache.updatedAt = now;
  return data;
}

// ===== 路由 =====
app.get('/api/data', async (req, res) => {
  try {
    const data = await getData(req.query.refresh === '1');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const data = await getData(true);
    res.json({ success: true, updatedAt: data.updatedAt, totalItems: data.totalItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 启动 =====
app.listen(PORT, () => {
  console.log(`\n🚀 GEO资讯服务已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   数据: http://localhost:${PORT}/api/data\n`);
  getData(true).then(d => console.log(`✅ 数据预加载完成: ${d.totalItems} 条`)).catch(e => console.log(`⚠️ ${e.message}`));
});
