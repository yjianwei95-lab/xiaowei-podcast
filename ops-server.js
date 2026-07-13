// 小伟播客 · 运营系统（独立进程，端口 4000）
// 与播客前端(3000)共享同一本地 SQLite 数据层（见 db.js），但使用独立会话与独立界面。
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

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

// ===== 本地 SQLite 数据层（见 db.js，与播客前端共用）=====
const { db, dbAll, dbGet, dbRun } = require('./db');

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
      dbOk: true
    });
  });
}
function getOpsStats() {
  const out = { totalPodcasts:0, totalPlayed:0, totalVisitors:0, todayVisitors:0, totalSize:0, totalComments:0, totalUsers:0 };
  try {
    const totalPodcasts = dbGet("SELECT COUNT(*) AS c FROM episodes WHERE status = 1")?.c || 0;
    const podcasts = dbAll('SELECT play_count, file_size FROM episodes WHERE status = 1');
    const totalVisitors = dbGet('SELECT COUNT(*) AS c FROM visitors')?.c || 0;
    const today = localNow().slice(0, 10);
    const todayVisitors = dbGet('SELECT COUNT(*) AS c FROM visitors WHERE visited_at >= ? AND visited_at <= ?', today + ' 00:00:00', today + ' 23:59:59')?.c || 0;
    const totalComments = dbGet("SELECT COUNT(*) AS c FROM comments WHERE status = 1")?.c || 0;
    const totalUsers = dbGet('SELECT COUNT(*) AS c FROM users')?.c || 0;
    out.totalPodcasts = totalPodcasts;
    out.totalPlayed = podcasts.reduce((s,p)=>s+(p.play_count||0),0);
    out.totalSize = podcasts.reduce((s,p)=>s+(p.file_size||0),0);
    out.totalVisitors = totalVisitors;
    out.todayVisitors = todayVisitors;
    out.totalComments = totalComments;
    out.totalUsers = totalUsers;
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
  res.render('ops/login', { flash: null, dbOk: true });
});

app.post('/ops/login', (req, res) => {
  try {
    const user = dbGet('SELECT * FROM admins WHERE username = ? AND password = ?', req.body.username, req.body.password);
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
app.get('/ops', requireOps, (req, res) => {
  try {
    const stats = getOpsStats();
    const recentPodcasts = dbAll('SELECT * FROM episodes ORDER BY created_at DESC LIMIT 5');
    const recentVisitors = dbAll('SELECT * FROM visitors ORDER BY visited_at DESC LIMIT 10');
    const topEpisodes = dbAll('SELECT title, play_count FROM episodes WHERE status = 1 ORDER BY play_count DESC LIMIT 10');
    const allV = dbAll('SELECT visited_at FROM visitors');
    const visitorTrend = groupByDay(allV, 'visited_at', 30);
    const allE = dbAll('SELECT created_at FROM episodes');
    const uploadTrend = groupByDay(allE, 'created_at', 30);
    const allEp = dbAll('SELECT uuid, title FROM episodes');
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
app.get('/ops/content', requireOps, (req, res) => {
  try {
    const podcasts = dbAll('SELECT * FROM episodes ORDER BY created_at DESC');
    renderOps(req, res, 'content', { podcasts: podcasts || [], title: '内容运营' });
  } catch (e) {
    renderOps(req, res, 'content', { podcasts: [], flash: { category:'error', message:'加载失败: ' + e.message } });
  }
});

app.post('/ops/content/toggle/:id', requireOps, (req, res) => {
  try {
    const ep = dbGet('SELECT status FROM episodes WHERE id = ?', req.params.id);
    if (ep) dbRun('UPDATE episodes SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', ep.status ? 0 : 1, req.params.id);
  } catch (e) { console.error('toggle error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/pin/:id', requireOps, (req, res) => {
  try {
    const ep = dbGet('SELECT is_pinned FROM episodes WHERE id = ?', req.params.id);
    if (ep) dbRun('UPDATE episodes SET is_pinned = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', ep.is_pinned ? 0 : 1, req.params.id);
  } catch (e) { console.error('pin error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/feature/:id', requireOps, (req, res) => {
  try {
    const ep = dbGet('SELECT is_featured FROM episodes WHERE id = ?', req.params.id);
    if (ep) dbRun('UPDATE episodes SET is_featured = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', ep.is_featured ? 0 : 1, req.params.id);
  } catch (e) { console.error('feature error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/recommend/:id', requireOps, (req, res) => {
  try {
    const ep = dbGet('SELECT is_recommended FROM episodes WHERE id = ?', req.params.id);
    if (ep) dbRun('UPDATE episodes SET is_recommended = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', ep.is_recommended ? 0 : 1, req.params.id);
  } catch (e) { console.error('recommend error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/delete/:id', requireOps, (req, res) => {
  try {
    const ep = dbGet('SELECT uuid, filename FROM episodes WHERE id = ?', req.params.id);
    if (ep) {
      const localPath = path.join(UPLOAD_DIR, ep.filename);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      dbRun('DELETE FROM visitors WHERE episode_uuid = ?', ep.uuid);
      dbRun('DELETE FROM comments WHERE episode_uuid = ?', ep.uuid);
      dbRun('DELETE FROM episodes WHERE id = ?', req.params.id);
    }
  } catch (e) { console.error('delete error:', e.message); }
  res.redirect('/ops/content');
});
app.get('/ops/content/edit/:id', requireOps, (req, res) => {
  try {
    const podcast = dbGet('SELECT * FROM episodes WHERE id = ?', req.params.id);
    if (!podcast) return res.redirect('/ops/content');
    renderOps(req, res, 'content-edit', { podcast, title: '编辑内容' });
  } catch (e) { res.redirect('/ops/content'); }
});
app.post('/ops/content/edit/:id', requireOps, (req, res) => {
  try {
    dbRun('UPDATE episodes SET title = ?, uploader_name = ?, uploader_email = ?, description = ?, is_pinned = ?, is_featured = ?, is_recommended = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
      req.body.title,
      req.body.uploader_name,
      req.body.uploader_email,
      req.body.description || '',
      req.body.is_pinned === 'on' ? 1 : 0,
      req.body.is_featured === 'on' ? 1 : 0,
      req.body.is_recommended === 'on' ? 1 : 0,
      req.params.id
    );
  } catch (e) { console.error('edit error:', e.message); }
  res.redirect('/ops/content');
});
app.post('/ops/content/replace-audio/:id', requireOps, upload.single('audio'), (req, res) => {
  if (req.file) {
    try {
      const ep = dbGet('SELECT filename, uuid FROM episodes WHERE id = ?', req.params.id);
      if (ep) {
        const oldLocal = path.join(UPLOAD_DIR, ep.filename);
        if (fs.existsSync(oldLocal)) fs.unlinkSync(oldLocal);
        // multer 已把新文件直接写入 UPLOAD_DIR，文件名即 req.file.filename，无需再上传
        dbRun('UPDATE episodes SET filename = ?, original_name = ?, file_size = ?, created_at = datetime(\'now\',\'localtime\'), updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
          req.file.filename, req.file.originalname, req.file.size, req.params.id);
      }
    } catch (e) { console.error('replace audio error:', e.message); }
  }
  res.redirect('/ops/content/edit/' + req.params.id);
});

// ===================================================================
// 公告与活动
// ===================================================================
app.get('/ops/announcements', requireOps, (req, res) => {
  let announcements = [];
  try {
    announcements = dbAll('SELECT * FROM announcements ORDER BY sort DESC, created_at DESC');
  } catch (e) {
    console.error('list announcements error:', e.message);
  }
  renderOps(req, res, 'announcements', { announcements, dbErr: null, title: '公告与活动', flash: null });
});
app.post('/ops/announcements/add', requireOps, (req, res) => {
  try {
    dbRun('INSERT INTO announcements (text, date, active) VALUES (?, ?, ?)',
      req.body.text, req.body.date || null, req.body.active === 'on' ? 1 : 0);
  } catch (e) { console.error('add announcement error:', e.message); }
  res.redirect('/ops/announcements');
});
app.post('/ops/announcements/toggle/:id', requireOps, (req, res) => {
  try {
    const a = dbGet('SELECT active FROM announcements WHERE id = ?', req.params.id);
    if (a) dbRun('UPDATE announcements SET active = ? WHERE id = ?', a.active ? 0 : 1, req.params.id);
  } catch (e) { console.error('toggle announcement error:', e.message); }
  res.redirect('/ops/announcements');
});
app.post('/ops/announcements/delete/:id', requireOps, (req, res) => {
  try { dbRun('DELETE FROM announcements WHERE id = ?', req.params.id); } catch (e) { console.error('delete announcement error:', e.message); }
  res.redirect('/ops/announcements');
});

// ===================================================================
// 用户与创作者
// ===================================================================
app.get('/ops/users', requireOps, (req, res) => {
  let users = [], creators = [];
  try {
    users = dbAll('SELECT id, username, nickname, phone, email, created_at FROM users ORDER BY created_at DESC LIMIT 200');
    const eps = dbAll('SELECT uploader_name, play_count, status FROM episodes WHERE status = 1');
    const map = {};
    (eps || []).forEach(e => {
      if (!e.uploader_name) return;
      if (!map[e.uploader_name]) map[e.uploader_name] = { name: e.uploader_name, count: 0, plays: 0 };
      map[e.uploader_name].count++;
      map[e.uploader_name].plays += (e.play_count || 0);
    });
    creators = Object.values(map).sort((a,b)=>b.plays-a.plays).slice(0, 20);
  } catch (e) { console.error('users error:', e.message); }
  renderOps(req, res, 'users', { users, creators, title: '用户与创作者' });
});

// ===================================================================
// 评论审核（迁移自原后台评论管理）
// ===================================================================
app.get('/ops/comments', requireOps, (req, res) => {
  try {
    const comments = dbAll('SELECT * FROM comments ORDER BY created_at DESC');
    // 关联节目标题（兼容原 supabase episodes(title) 关联字段）
    const eps = dbAll('SELECT uuid, title FROM episodes');
    const titleMap = {}; (eps || []).forEach(e => titleMap[e.uuid] = e.title);
    comments.forEach(c => { c.episodes = { title: titleMap[c.episode_uuid] || '' }; });
    renderOps(req, res, 'comments', { comments: comments || [], title: '评论审核' });
  } catch (e) {
    renderOps(req, res, 'comments', { comments: [], flash: { category:'error', message:'加载失败: ' + e.message } });
  }
});
app.post('/ops/comments/delete/:id', requireOps, (req, res) => {
  try { dbRun('UPDATE comments SET status = 0 WHERE id = ?', req.params.id); } catch (e) { console.error('comment delete error:', e.message); }
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
app.get('/ops/export/episodes', requireOps, (req, res) => {
  const data = dbAll('SELECT * FROM episodes ORDER BY created_at DESC');
  sendCsv(res, 'episodes.csv', data || [],
    ['id','uuid','title','description','uploader_name','uploader_email','uploader_ip','play_count','file_size','status','is_pinned','is_featured','is_recommended','created_at','updated_at']);
});
app.get('/ops/export/visitors', requireOps, (req, res) => {
  const data = dbAll('SELECT * FROM visitors ORDER BY visited_at DESC');
  sendCsv(res, 'visitors.csv', data || [],
    ['id','episode_uuid','ip','user_agent','referer','device_type','os','os_version','browser','browser_version','device_brand','device_model','screen_resolution','language','platform','visited_at']);
});
app.get('/ops/export/comments', requireOps, (req, res) => {
  const data = dbAll('SELECT * FROM comments ORDER BY created_at DESC');
  sendCsv(res, 'comments.csv', data || [], ['id','episode_uuid','nickname','content','created_at','status']);
});

// ===================================================================
// 运营账号设置（修改密码，迁移自原后台修改密码）
// ===================================================================
app.get('/ops/settings', requireOps, (req, res) => renderOps(req, res, 'settings', { title: '运营账号设置' }));
app.post('/ops/settings', requireOps, (req, res) => {
  try {
    const user = dbGet('SELECT * FROM admins WHERE username = ? AND password = ?', req.session.opsUser, req.body.old_password);
    if (user) {
      dbRun('UPDATE admins SET password = ? WHERE username = ?', req.body.new_password, req.session.opsUser);
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
  console.log('  🗄️  数据库: 本地 SQLite（零外网依赖，工作区自包含）');
  console.log('='.repeat(50));
});
