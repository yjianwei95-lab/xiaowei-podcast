const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'podcast.db');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 使用内存数据库（JSON 文件持久化）替代 better-sqlite3
let db = { podcasts: [], visitors: [], admin: [], users: [] };
let nextId = 1;

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      nextId = db._nextId || 1;
    }
  } catch(e) { db = { podcasts: [], visitors: [], admin: [], users: [] }; }
}

function saveDB() {
  try {
  db._nextId = nextId;
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  delete db._nextId;
  } catch(e) { /* write error, using in-memory mode */ }
}

loadDB();

// 如果 admin 表为空，添加默认管理员
// 确保默认管理员始终存在
db.admin = db.admin || [];
if (db.admin.length === 0) {
  db.admin = [{ id: nextId++, username: 'admin', password: 'admin123' }];
  saveDB();
}

const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const allowedMimes = ['audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/aac','audio/flac','audio/x-m4a','audio/mp4','audio/webm','audio/x-wav'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  allowedMimes.includes(file.mimetype) ? cb(null, true) : cb(new Error('不支持的文件格式'));
}});

// 重置管理员密码（仅用于调试）
app.get('/admin/reset-password', (req, res) => {
  const admin = db.admin.find(u => u.username === 'admin');
  if (admin) {
    admin.password = 'admin123';
    saveDB();
    res.send('密码已重置为: admin123');
  } else {
    db.admin = [{ id: nextId++, username: 'admin', password: 'admin123' }];
    saveDB();
    res.send('管理员已创建，密码: admin123');
  }
});

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

function localNow() {
  const d = new Date();
  const local = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return local.toISOString().replace('Z', '+08:00');
}

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(session({ secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false, cookie: { maxAge: 24 * 60 * 60 * 1000 } }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function renderWithLayout(req, res, template, data = {}) {
  const isAdmin = template.startsWith('admin/');
  const layoutName = isAdmin ? 'admin/layout' : 'layout';
  res.render(template, { ...data, session: req.session }, (err, html) => {
    if (err) return res.status(500).send('渲染错误: ' + err.message);
    res.render(layoutName, { title: data.title || '小伟播客', flash: data.flash || null, session: req.session, content: html });
  });
}

function requireAdmin(req, res, next) {
  if (!req.session.loggedIn) return res.redirect('/admin/login');
  next();
}

function getStats() {
  return {
    totalPodcasts: db.podcasts.filter(p => p.status !== 0).length,
    totalPlayed: db.podcasts.reduce((s, p) => s + (p.play_count || 0), 0),
    totalVisitors: db.visitors.length,
    todayVisitors: db.visitors.filter(v => v.visited_at && v.visited_at.startsWith(localNow().slice(0, 10))).length,
    totalSize: db.podcasts.reduce((s, p) => s + (p.file_size || 0), 0)
  };
}

app.get('/', (req, res) => {
  const podcasts = db.podcasts.filter(p => p.status !== 0).sort((a, b) => b.created_at.localeCompare(a.created_at));
  renderWithLayout(req, res, 'index', { podcasts, stats: getStats(), title: '小伟播客' });
});

// PWA安装教程页面
app.get('/app', (req, res) => {
  renderWithLayout(req, res, 'app', { title: '安装APP - 小伟播客', domain: req.headers.host });
});

app.get('/play/:uuid', (req, res) => {
  const podcast = db.podcasts.find(p => p.uuid === req.params.uuid && p.status !== 0);
  if (!podcast) return renderWithLayout(req, res, '404', { title: '未找到' });
  podcast.play_count = (podcast.play_count || 0) + 1;
  db.visitors.push({ podcast_uuid: podcast.uuid, ip: getClientIP(req), user_agent: req.headers['user-agent'] || '', referer: req.headers['referer'] || '', visited_at: localNow() });
  saveDB();
  renderWithLayout(req, res, 'player', { podcast, title: podcast.title, req });
});

app.get('/upload', (req, res) => renderWithLayout(req, res, 'upload', { title: '上传声音' }));

app.post('/upload', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) return renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: err.message } });
    if (!req.file) return renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: '请选择文件' } });
    const { title, description, uploader_name, uploader_email } = req.body;
    if (!title || !title.trim()) { fs.unlinkSync(req.file.path); return renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: '请输入标题' } }); }
    const uuid = uuidv4();
    const now = localNow();
    db.podcasts.push({
      id: nextId++, uuid, title: title.trim(), description: (description || '').trim(),
      filename: req.file.filename, original_name: req.file.originalname,
      file_size: req.file.size, duration: '', uploader_name: (uploader_name || '匿名').trim(),
      uploader_email: (uploader_email || '').trim(), uploader_ip: getClientIP(req),
      uploader_agent: req.headers['user-agent'] || '', play_count: 0, status: 1, created_at: now
    });
    saveDB();
    renderWithLayout(req, res, 'upload', { title: '上传成功', flash: { category: 'success', message: `🎉 上传成功！《${title.trim()}》已发布` }, uploaded: { uuid, title: title.trim() }, req });
  });
});

// 音频编辑器
app.get('/audio-editor', (req, res) => {
  const podcastId = req.query.podcastId || null;
  const podcast = podcastId ? db.podcasts.find(p => p.id == podcastId) : null;
  renderWithLayout(req, res, 'audio-editor', { title: '音频编辑', podcast, podcastId });
});

app.post('/audio-editor/upload', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) return res.json({ error: '上传失败: ' + err.message });
    if (!req.file) return res.json({ error: '请选择文件' });
    res.json({ success: true, filename: req.file.filename, originalName: req.file.originalname, size: req.file.size, url: '/uploads/' + req.file.filename });
  });
});

// 登录/注册
app.get('/login', (req, res) => {
  if (req.session.userId || req.session.isAdmin) return res.redirect('/');
  renderWithLayout(req, res, 'auth/login', { title: '登录' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.userId = user.id; req.session.username = user.username; req.session.nickname = user.nickname || user.username;
    return res.redirect('/');
  }
  renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '用户名或密码错误' } });
});

app.get('/register', (req, res) => renderWithLayout(req, res, 'auth/register', { title: '注册' }));

app.post('/register', (req, res) => {
  const { username, password, nickname } = req.body;
  if (!username || !password || username.length < 2) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '用户名至少2个字符' } });
  if (password.length < 4) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '密码至少4位' } });
  if (db.users.find(u => u.username === username)) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '用户名已被注册' } });
  db.users.push({ id: nextId++, username, password, nickname: nickname || username, created_at: localNow() });
  saveDB();
  renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'success', message: '注册成功！请登录' } });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// 后台管理
app.get('/admin/login', (req, res) => req.session.loggedIn ? res.redirect('/admin') : res.render('admin/login', { flash: null }));
app.post('/admin/login', (req, res) => {
  const user = db.admin.find(u => u.username === req.body.username && u.password === req.body.password);
  if (user) { req.session.loggedIn = true; req.session.isAdmin = true; req.session.username = req.body.username; return res.redirect('/admin'); }
  res.render('admin/login', { flash: { category: 'error', message: '用户名或密码错误' } });
});
app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

app.get('/admin', requireAdmin, (req, res) => {
  const recentPodcasts = db.podcasts.sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);
  const recentVisitors = db.visitors.slice(-10).reverse().map(v => ({ ...v, podcast_title: (db.podcasts.find(p => p.uuid === v.podcast_uuid) || {}).title }));
  renderWithLayout(req, res, 'admin/dashboard', { stats: getStats(), recentPodcasts, recentVisitors, title: '后台总览' });
});

app.get('/admin/podcasts', requireAdmin, (req, res) => {
  const podcasts = [...db.podcasts].sort((a,b) => b.created_at.localeCompare(a.created_at));
  renderWithLayout(req, res, 'admin/podcasts', { podcasts, title: '播客管理' });
});

app.post('/admin/toggle/:id', requireAdmin, (req, res) => {
  const p = db.podcasts.find(p => p.id == req.params.id);
  if (p) { p.status = p.status ? 0 : 1; saveDB(); }
  res.redirect('/admin/podcasts');
});

app.post('/admin/delete/:id', requireAdmin, (req, res) => {
  const idx = db.podcasts.findIndex(p => p.id == req.params.id);
  if (idx > -1) {
    const oldFile = path.join(UPLOAD_DIR, db.podcasts[idx].filename);
    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    db.visitors = db.visitors.filter(v => v.podcast_uuid !== db.podcasts[idx].uuid);
    db.podcasts.splice(idx, 1);
    saveDB();
  }
  res.redirect('/admin/podcasts');
});

app.get('/admin/edit/:id', requireAdmin, (req, res) => {
  const p = db.podcasts.find(p => p.id == req.params.id);
  if (!p) return res.redirect('/admin/podcasts');
  renderWithLayout(req, res, 'admin/edit', { podcast: p, title: '编辑播客' });
});

app.post('/admin/edit/:id', requireAdmin, (req, res) => {
  const p = db.podcasts.find(p => p.id == req.params.id);
  if (p) { p.title = req.body.title; p.uploader_name = req.body.uploader_name; p.uploader_email = req.body.uploader_email; p.description = req.body.description || ''; saveDB(); }
  res.redirect('/admin/podcasts');
});

app.post('/admin/replace-audio/:id', requireAdmin, (req, res) => {
  upload.single('audio')(req, res, function(err) {
    if (err || !req.file) return res.redirect('/admin/edit/' + req.params.id);
    const p = db.podcasts.find(p => p.id == req.params.id);
    if (p) {
      const oldFile = path.join(UPLOAD_DIR, p.filename);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      p.filename = req.file.filename; p.original_name = req.file.originalname; p.file_size = req.file.size; p.created_at = localNow();
      saveDB();
    }
    res.redirect('/admin/edit/' + req.params.id);
  });
});

app.get('/admin/visitors', requireAdmin, (req, res) => {
  const visitors = db.visitors.slice().reverse().map(v => ({ ...v, podcast_title: (db.podcasts.find(p => p.uuid === v.podcast_uuid) || {}).title, uploader_name: (db.podcasts.find(p => p.uuid === v.podcast_uuid) || {}).uploader_name }));
  const byPodcast = db.podcasts.map(p => ({ uuid: p.uuid, title: p.title, visits: db.visitors.filter(v => v.podcast_uuid === p.uuid).length, last_visit: db.visitors.filter(v => v.podcast_uuid === p.uuid).pop()?.visited_at })).sort((a,b) => b.visits - a.visits);
  renderWithLayout(req, res, 'admin/visitors', { visitors, byPodcast, title: '访客记录' });
});

app.get('/admin/password', requireAdmin, (req, res) => renderWithLayout(req, res, 'admin/password', { title: '修改密码' }));

app.post('/admin/password', requireAdmin, (req, res) => {
  const user = db.admin.find(u => u.username === req.session.username && u.password === req.body.old_password);
  if (user) { user.password = req.body.new_password; saveDB(); res.redirect('/admin'); }
  else renderWithLayout(req, res, 'admin/password', { flash: { category: 'error', message: '原密码错误' } });
});


console.log('='.repeat(55));
console.log('  🎙️ 小伟播客已启动！');
console.log(`  🌐 前台地址: http://localhost:${PORT}`);
console.log(`  📤 上传页面: http://localhost:${PORT}/upload`);
console.log(`  🔐 后台地址: http://localhost:${PORT}/admin/login`);
console.log('  🙁 默认账号: admin');
console.log('  🔽 默认密码: admin123');
console.log('  💡  首次登录后请尽快修改密码！');
console.log('='.repeat(55));
app.listen(PORT, '0.0.0.0');
 
