// 小伟播客 · 运营系统（独立进程，端口 4000）
// 与播客前端(3000)共享同一 Supabase 后端，但使用独立会话与独立界面。
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const ws = require('ws');

// 极简 .env 加载（不依赖 dotenv；已存在的 process.env 优先）
(function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const clean = line.replace(/\r$/, '');
      const m = clean.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        const k = m[1];
        if (process.env[k] === undefined) process.env[k] = m[2].replace(/^["']|["']$/g, '');
      }
    });
  } catch (e) {}
})();

const app = express();
const PORT = process.env.OPS_PORT || 4000;

// ===== Supabase（与播客共用）=====
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const supabaseKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
let supabase = null;
try {
  supabase = createClient(SUPABASE_URL, supabaseKey, { realtime: { transport: ws } });
} catch (e) {
  console.warn('[OPS] ⚠️ Supabase 未连接（环境变量未配置？）:', e.message);
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const AUDIO_CONTENT_TYPES = {
  'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'm4a': 'audio/mp4', 'ogg': 'audio/ogg',
  'aac': 'audio/aac', 'flac': 'audio/flac'
};

// ===== 会话（独立 cookie 名，避免与 3000 冲突）=====
app.use(session({
  name: 'ops.sid',
  secret: process.env.OPS_SESSION_SECRET || 'xiaowei-ops-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/ops/css', express.static(path.join(__dirname, 'public/ops/css')));
app.use('/ops/js', express.static(path.join(__dirname, 'public/ops/js')));
app.use('/uploads', express.static(UPLOAD_DIR)); // 内容运营内音频预览复用

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || '.mp3'}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/aac','audio/flac','audio/x-m4a','audio/mp4','audio/webm','audio/x-wav'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('不支持的文件格式'));
  }
});

// ===== 工具函数 =====
function localNow() {
  const d = new Date();
  const local = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return local.toISOString().replace('Z', '+08:00');
}
function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}
function requireOps(req, res, next) {
  if (!req.session.opsLoggedIn) return res.redirect('/ops/login');
  next();
}
function renderOps(req, res, template, data = {}) {
  res.render('ops/' + template, { ...data, session: req.session }, (err, html) => {
    if (err) return res.status(500).send('渲染错误: ' + err.message);
    res.render('ops/layout', {
      title: data.title || '运营系统',
      flash: data.flash || null,
      session: req.session,
      content: html,
      dbOk: !!supabase
    });
  });
}
async function getOpsStats() {
  const out = { totalPodcasts:0, totalPlayed:0, totalVisitors:0, todayVisitors:0, totalSize:0, totalComments:0, totalUsers:0 };
  if (!supabase) return out;
  try {
    const { count: totalPodcasts } = await supabase.from('episodes').select('*', { count:'exact', head:true }).eq('status', 1);
    const { data: podcasts } = await supabase.from('episodes').select('play_count, file_size').eq('status', 1);
    const { count: totalVisitors } = await supabase.from('visitors').select('*', { count:'exact', head:true });
    const today = localNow().slice(0, 10);
    const { count: todayVisitors } = await supabase.from('visitors').select('*', { count:'exact', head:true })
      .gte('visited_at', today + 'T00:00:00+08:00').lt('visited_at', today + 'T23:59:59+08:00');
    const { count: totalComments } = await supabase.from('comments').select('*', { count:'exact', head:true }).eq('status', 1);
    const { count: totalUsers } = await supabase.from('users').select('*', { count:'exact', head:true });
    out.totalPodcasts = totalPodcasts || 0;
    out.totalPlayed = podcasts?.reduce((s,p)=>s+(p.play_count||0),0) || 0;
    out.totalSize = podcasts?.reduce((s,p)=>s+(p.file_size||0),0) || 0;
    out.totalVisitors = totalVisitors || 0;
    out.todayVisitors = todayVisitors || 0;
    out.totalComments = totalComments || 0;
    out.totalUsers = totalUsers || 0;
  } catch (e) { console.error('[OPS] getOpsStats error:', e.message); }
  return out;
}
function groupByDay(rows, field, days = 30) {
  const map = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    map[d.toISOString().slice(0,10)] = 0;
  }
  (rows || []).forEach(r => {
    const k = (r[field] || '').slice(0,10);
    if (k in map) map[k]++;
  });
  return Object.entries(map).map(([date, count]) => ({ date, count }));
}
function toCsv(rows, headers) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  rows.forEach(r => lines.push(headers.map(h => esc(r[h])).join(',')));
  return '﻿' + lines.join('\n'); // BOM 保证 Excel 中文不乱码
}

// ===================================================================
// 登录（独立运营账号，读 admins 表）
// ===================================================================
app.get('/ops/login', (req, res) => {
  if (req.session.opsLoggedIn) return res.redirect('/ops');
  res.render('ops/login', { flash: null, dbOk: !!supabase });
});

app.post('/ops/login', async (req, res) => {
  if (!supabase) return res.render('ops/login', { flash: { category:'error', message:'数据库未连接，无法登录' }, dbOk:false });
  try {
    const { data: user, error } = await supabase
      .from('admins').select('*').eq('username', req.body.username).eq('password', req.body.password).single();
    if (user) {
      req.session.opsLoggedIn = true;
      req.session.opsUser = req.body.username;
      return res.redirect('/ops');
    }
    res.render('ops/login', { flash: { category:'error', message:'用户名或密码错误' }, dbOk:true });
  } catch (e) {
    res.render('ops/login', { flash: { category:'error', message:'登录失败: ' + e.message }, dbOk:true });
  }
});

app.get('/ops/logout', (req, res) => { req.session.destroy(); res.redirect('/ops/login'); });

// 根路径
app.get('/ops', requireOps, async (req, res) => {
  try {
    const stats = await getOpsStats();
    let recentPodcasts = [], recentVisitors = [], topEpisodes = [], visitorTrend = [], uploadTrend = [];
    if (supabase) {
      const { data: rp } = await supabase.from('episodes').select('*').order('created_at',{ascending:false}).limit(5);
      recentPodcasts = rp || [];
      const { data: rv } = await supabase.from('visitors').select('*').order('visited_at',{ascending:false}).limit(10);
      recentVisitors = rv || [];
      const { data: te } = await supabase.from('episodes').select('title, play_count').eq('status',1).order('play_count',{ascending:false}).limit(10);
      topEpisodes = te || [];
      const { data: allV } = await supabase.from('visitors').select('visited_at');
      visitorTrend = groupByDay(allV, 'visited_at', 30);
      const { data: allE } = await supabase.from('episodes').select('created_at');
      uploadTrend = groupByDay(allE, 'created_at', 30);
    }
    const { data: allEp } = supabase ? await supabase.from('episodes').select('uuid, title') : { data: [] };
    const titleMap = {}; (allEp || []).forEach(ep => titleMap[ep.uuid] = ep.title);
    const visitorsWithTitle = recentVisitors.map(v => ({ ...v, podcast_title: titleMap[v.episode_uuid] || '' }));
    renderOps(req, res, 'dashboard', {
      stats, recentPodcasts, visitorsWithTitle, topEpisodes, visitorTrend, uploadTrend, title: '数据看板'
    });
  } catch (e) {
    console.error('[OPS] dashboard error:', e.message);
    renderOps(req, res, 'dashboard', {
      stats: { totalPodcasts:0, totalPlayed:0, totalVisitors:0, todayVisitors:0, totalSize:0, totalComments:0, totalUsers:0 },
      recentPodcasts: [], visitorsWithTitle: [], topEpisodes: [], visitorTrend: [], uploadTrend: [], title: '数据看板'
    });
  }
});

// ===================================================================
// 内容运营（迁移自原后台播客管理 + 置顶/精选/推荐）
// ===================================================================
app.get('/ops/content', requireOps, async (req, res) => {
  try {
    const { data: podcasts, error } = supabase
      ? await supabase.from('episodes').select('*').order('created_at',{ascending:false})
      : { data: [], error: null };
    if (error) throw error;
    renderOps(req, res, 'content', { podcasts: podcasts || [], title: '内容运营' });
  } catch (e) {
    renderOps(req, res, 'content', { podcasts: [], flash: { category:'error', message:'加载失败: ' + e.message } });
  }
});

app.post('/ops/content/toggle/:id', requireOps, async (req, res) => {
  try {
    const { data: ep } = await supabase.from('episodes').select('status').eq('id', req.params.id).single();
    if (ep) await supabase.from('episodes').update({ status: ep.status ? 0 : 1 }).eq('id', req.params.id);
  } catch (e) { console.error('toggle error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/pin/:id', requireOps, async (req, res) => {
  try { const { data: ep } = await supabase.from('episodes').select('is_pinned').eq('id', req.params.id).single();
    if (ep) await supabase.from('episodes').update({ is_pinned: !ep.is_pinned }).eq('id', req.params.id); } catch(e){}
  res.redirect('/ops/content');
});
app.post('/ops/content/feature/:id', requireOps, async (req, res) => {
  try { const { data: ep } = await supabase.from('episodes').select('is_featured').eq('id', req.params.id).single();
    if (ep) await supabase.from('episodes').update({ is_featured: !ep.is_featured }).eq('id', req.params.id); } catch(e){}
  res.redirect('/ops/content');
});
app.post('/ops/content/recommend/:id', requireOps, async (req, res) => {
  try { const { data: ep } = await supabase.from('episodes').select('is_recommended').eq('id', req.params.id).single();
    if (ep) await supabase.from('episodes').update({ is_recommended: !ep.is_recommended }).eq('id', req.params.id); } catch(e){}
  res.redirect('/ops/content');
});
app.post('/ops/content/delete/:id', requireOps, async (req, res) => {
  try {
    const { data: ep } = await supabase.from('episodes').select('uuid, filename').eq('id', req.params.id).single();
    if (ep) {
      await supabase.storage.from('audio').remove([`${ep.filename}`]);
      const localPath = path.join(UPLOAD_DIR, ep.filename);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      await supabase.from('visitors').delete().eq('episode_uuid', ep.uuid);
      await supabase.from('episodes').delete().eq('id', req.params.id);
    }
  } catch (e) { console.error('delete error:', e.message); }
  res.redirect('/ops/content');
});
app.get('/ops/content/edit/:id', requireOps, async (req, res) => {
  try {
    const { data: podcast, error } = await supabase.from('episodes').select('*').eq('id', req.params.id).single();
    if (error || !podcast) return res.redirect('/ops/content');
    renderOps(req, res, 'content-edit', { podcast, title: '编辑内容' });
  } catch (e) { res.redirect('/ops/content'); }
});
app.post('/ops/content/edit/:id', requireOps, async (req, res) => {
  try {
    await supabase.from('episodes').update({
      title: req.body.title,
      uploader_name: req.body.uploader_name,
      uploader_email: req.body.uploader_email,
      description: req.body.description || '',
      is_pinned: req.body.is_pinned === 'on',
      is_featured: req.body.is_featured === 'on',
      is_recommended: req.body.is_recommended === 'on'
    }).eq('id', req.params.id);
  } catch (e) { console.error('edit error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/replace-audio/:id', requireOps, upload.single('audio'), async (req, res) => {
  if (req.file) {
    try {
      const { data: ep } = await supabase.from('episodes').select('filename, uuid').eq('id', req.params.id).single();
      if (ep) {
        await supabase.storage.from('audio').remove([`${ep.filename}`]);
        const oldLocal = path.join(UPLOAD_DIR, ep.filename);
        if (fs.existsSync(oldLocal)) fs.unlinkSync(oldLocal);
        const buf = fs.readFileSync(req.file.path);
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        const ct = AUDIO_CONTENT_TYPES[ext] || 'audio/mpeg';
        await supabase.storage.from('audio').upload(`${req.file.filename}`, buf, { contentType: ct });
        fs.unlinkSync(req.file.path);
        await supabase.from('episodes').update({ filename: req.file.filename, original_name: req.file.originalname, file_size: req.file.size, created_at: localNow() }).eq('id', req.params.id);
      }
    } catch (e) { console.error('replace audio error:', e.message); }
  }
  res.redirect('/ops/content/edit/' + req.params.id);
});

// ===================================================================
// 公告与活动
// ===================================================================
app.get('/ops/announcements', requireOps, async (req, res) => {
  let announcements = [];
  let dbErr = null;
  if (supabase) {
    const { data, error } = await supabase.from('announcements').select('*').order('sort',{ascending:false}).order('created_at',{ascending:false});
    if (error) dbErr = error.message; else announcements = data || [];
  }
  renderOps(req, res, 'announcements', {
    announcements, dbErr,
    title: '公告与活动',
    flash: dbErr ? { category:'error', message:'公告表不存在，请先执行 ops-setup.sql：' + dbErr } : null
  });
});
app.post('/ops/announcements/add', requireOps, async (req, res) => {
  try {
    await supabase.from('announcements').insert([{ text: req.body.text, date: req.body.date || null, active: req.body.active === 'on' }]);
  } catch (e) { console.error('add announcement error:', e.message); }
  res.redirect('/ops/announcements');
});
app.post('/ops/announcements/toggle/:id', requireOps, async (req, res) => {
  try { const { data: a } = await supabase.from('announcements').select('active').eq('id', req.params.id).single();
    if (a) await supabase.from('announcements').update({ active: !a.active }).eq('id', req.params.id); } catch(e){}
  res.redirect('/ops/announcements');
});
app.post('/ops/announcements/delete/:id', requireOps, async (req, res) => {
  try { await supabase.from('announcements').delete().eq('id', req.params.id); } catch(e){}
  res.redirect('/ops/announcements');
});

// ===================================================================
// 用户与创作者
// ===================================================================
app.get('/ops/users', requireOps, async (req, res) => {
  let users = [], creators = [];
  if (supabase) {
    const { data: ud } = await supabase.from('users').select('id, username, nickname, phone, created_at').order('created_at',{ascending:false}).limit(200);
    users = ud || [];
    const { data: eps } = await supabase.from('episodes').select('uploader_name, play_count, status').eq('status', 1);
    const map = {};
    (eps || []).forEach(e => {
      if (!e.uploader_name) return;
      if (!map[e.uploader_name]) map[e.uploader_name] = { name: e.uploader_name, count: 0, plays: 0 };
      map[e.uploader_name].count++;
      map[e.uploader_name].plays += (e.play_count || 0);
    });
    creators = Object.values(map).sort((a,b)=>b.plays-a.plays).slice(0, 20);
  }
  renderOps(req, res, 'users', { users, creators, title: '用户与创作者' });
});

// ===================================================================
// 评论审核（迁移自原后台评论管理）
// ===================================================================
app.get('/ops/comments', requireOps, async (req, res) => {
  try {
    const { data: comments, error } = supabase
      ? await supabase.from('comments').select('*, episodes(title)').order('created_at',{ascending:false})
      : { data: [] };
    if (error) throw error;
    renderOps(req, res, 'comments', { comments: comments || [], title: '评论审核' });
  } catch (e) {
    renderOps(req, res, 'comments', { comments: [], flash: { category:'error', message:'加载失败: ' + e.message } });
  }
});
app.post('/ops/comments/delete/:id', requireOps, async (req, res) => {
  try { await supabase.from('comments').update({ status: 0 }).eq('id', req.params.id); } catch(e){}
  res.redirect('/ops/comments');
});

// ===================================================================
// 数据导出
// ===================================================================
app.get('/ops/export', requireOps, (req, res) => {
  renderOps(req, res, 'export', { title: '数据导出' });
});
function sendCsv(res, filename, rows, headers) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows, headers));
}
app.get('/ops/export/episodes', requireOps, async (req, res) => {
  if (!supabase) return res.status(500).send('数据库未连接');
  const { data } = await supabase.from('episodes').select('*').order('created_at',{ascending:false});
  sendCsv(res, 'episodes.csv', data || [],
    ['id','uuid','title','description','uploader_name','uploader_email','uploader_ip','play_count','file_size','status','is_pinned','is_featured','is_recommended','created_at']);
});
app.get('/ops/export/visitors', requireOps, async (req, res) => {
  if (!supabase) return res.status(500).send('数据库未连接');
  const { data } = await supabase.from('visitors').select('*').order('visited_at',{ascending:false});
  sendCsv(res, 'visitors.csv', data || [],
    ['id','episode_uuid','ip','device_type','os','os_version','browser','browser_version','device_brand','device_model','visited_at']);
});
app.get('/ops/export/comments', requireOps, async (req, res) => {
  if (!supabase) return res.status(500).send('数据库未连接');
  const { data } = await supabase.from('comments').select('*').order('created_at',{ascending:false});
  sendCsv(res, 'comments.csv', data || [], ['id','episode_uuid','nickname','content','created_at','status']);
});

// ===================================================================
// 运营账号设置（修改密码，迁移自原后台修改密码）
// ===================================================================
app.get('/ops/settings', requireOps, (req, res) => renderOps(req, res, 'settings', { title: '运营账号设置' }));
app.post('/ops/settings', requireOps, async (req, res) => {
  try {
    const { data: user } = await supabase.from('admins').select('*').eq('username', req.session.opsUser).eq('password', req.body.old_password).single();
    if (user) {
      await supabase.from('admins').update({ password: req.body.new_password }).eq('username', req.session.opsUser);
      return renderOps(req, res, 'settings', { flash: { category:'success', message:'密码已修改' }, title: '运营账号设置' });
    }
    renderOps(req, res, 'settings', { flash: { category:'error', message:'原密码错误' }, title: '运营账号设置' });
  } catch (e) {
    renderOps(req, res, 'settings', { flash: { category:'error', message:'修改失败: ' + e.message }, title: '运营账号设置' });
  }
});

// 其他路径重定向到登录
app.get('/', (req, res) => res.redirect('/ops/login'));

app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  🛠️  小伟播客 · 运营系统已启动');
  console.log(`  🌐 运营后台: http://localhost:${PORT}/ops/login`);
  console.log(`  🔌 端口: ${PORT}（独立进程）`);
  console.log(`  🗄️  Supabase: ${supabase ? '已连接' : '未连接（仅界面，无数据）'}`);
  console.log('='.repeat(50));
});
