/**
 * 一键执行运营系统数据库迁移 (ops-setup.sql)
 * 用法：
 *   1. 在 .env 中配置 SUPABASE_URL 和 SUPABASE_SERVICE_KEY (service_role)
 *   2. node run-ops-setup.js
 *
 * 说明：通过 Supabase 的 /rest/v1/sql 端点执行 DDL，
 *       该端点对 service_role key 可用（即 Studio SQL Editor 底层接口）。
 */
const fs = require('fs');
const path = require('path');

// 极简 .env 解析（不依赖 dotenv）
function loadEnv(file) {
  const env = {};
  if (fs.existsSync(file)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
      const clean = line.replace(/\r$/, '');
      const m = clean.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  }
  return env;
}

const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };
const SUPABASE_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !KEY || KEY.length < 20) {
  console.error('❌ 未在 .env 找到有效的 SUPABASE_URL / SUPABASE_SERVICE_KEY');
  console.error('   请先配置：');
  console.error('   SUPABASE_URL=https://xxxx.supabase.co');
  console.error('   SUPABASE_SERVICE_KEY=your-service-role-key');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, 'ops-setup.sql'), 'utf8');
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;

function mask(u) { try { return new URL(u).host; } catch { return u.slice(0, 24) + '...'; } }
function projectRef(u) { try { return new URL(u.trim()).host.split('.')[0]; } catch { return ''; } }

(async () => {
  // 优先用 Management API（Personal Access Token）执行 DDL
  if (ACCESS_TOKEN) {
    const ref = projectRef(SUPABASE_URL);
    console.log('→ 使用 Management API 执行 (project:', ref + ')');
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify({ query: sql })
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('❌ Management API 执行失败 HTTP', res.status);
      console.error(text.slice(0, 800));
      process.exit(1);
    }
    console.log('✅ ops-setup.sql 执行成功');
  } else {
    // 回退：/rest/v1/sql（需项目开启 direct SQL execution，本项目不可用）
    console.log('→ 连接 Supabase:', mask(SUPABASE_URL));
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ApiKey': KEY, 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({ query: sql })
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('❌ 执行失败 HTTP', res.status);
      console.error(text.slice(0, 800));
      console.error('\n/rest/v1/sql 在本项目不可用。请改用：');
      console.error('  方式A：提供 SUPABASE_ACCESS_TOKEN（Supabase 个人访问令牌），用 Management API 执行');
      console.error('  方式B：登录 Supabase 控制台 SQL Editor 粘贴 ops-setup.sql 运行');
      process.exit(1);
    }
    console.log('✅ ops-setup.sql 执行成功');
  }

  // 验证 announcements 表已创建（用 service_role 读）
  const v = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/announcements?select=id&limit=1`, {
    headers: { 'ApiKey': KEY, 'Authorization': `Bearer ${KEY}` }
  });
  console.log('→ 验证 announcements 表可访问，HTTP', v.status);
  if (v.ok) {
    const rows = await v.json();
    console.log('→ announcements 当前记录数:', Array.isArray(rows) ? rows.length : 'n/a');
  }
  console.log('\n🎉 迁移完成。运营系统的「公告与活动」「内容运营(置顶/精选/推荐)」模块已具备数据支撑。');
})().catch(e => {
  console.error('异常:', e.message);
  process.exit(1);
});
