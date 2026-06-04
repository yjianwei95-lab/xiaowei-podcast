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
const bcrypt = require('bcryptjs');

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

app.use(express.json());
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

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
// 手机号登录（基础版）
app.get('/phone-login', (req, res) => {
  if (req.session.userId || req.session.isAdmin) return res.redirect('/');
  renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录' });
});

app.post('/phone-login', (req, res) => {
  const phone = (req.body.phone || '').trim().replace(/\s/g, '');
  const { password } = req.body;

  if (!phone) {
    return renderWithLayout(req, res, 'auth/phone-login', {
      title: '手机号登录',
      flash: { category: 'error', message: '请输入手机号' }
    });
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return renderWithLayout(req, res, 'auth/phone-login', {
      title: '手机号登录',
      flash: { category: 'error', message: '请输入正确的11位手机号' },
      phone
    });
  }
  if (!password) {
    return renderWithLayout(req, res, 'auth/phone-login', {
      title: '手机号登录',
      flash: { category: 'error', message: '请输入密码' },
      phone
    });
  }

  const user = db.users.find(u => u.phone === phone);
  if (!user) {
    return renderWithLayout(req, res, 'auth/phone-login', {
      title: '手机号登录',
      flash: { category: 'error', message: '该手机号未注册，请先注册' },
      phone
    });
  }

  // 密码验证
  let passwordValid = false;
  if (user.password_hash) {
    passwordValid = bcrypt.compareSync(password, user.password_hash);
  } else if (user.password) {
    passwordValid = (user.password === password);
    if (passwordValid) {
      user.password_hash = bcrypt.hashSync(password, 10);
      delete user.password;
      saveDB();
    }
  }

  if (!passwordValid) {
    return renderWithLayout(req, res, 'auth/phone-login', {
      title: '手机号登录',
      flash: { category: 'error', message: '密码错误' },
      phone
    });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.nickname = user.nickname || user.username;
  req.session.phone = user.phone || '';
  return res.redirect('/');
});

app.get('/login', (req, res) => {
  if (req.session.userId || req.session.isAdmin) return res.redirect('/');
  renderWithLayout(req, res, 'auth/login', { title: '登录' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  // 支持手机号或用户名登录
  const identifier = (username || '').trim();
  if (!identifier) {
    return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '请输入手机号或用户名' } });
  }
  let user = db.users.find(u => u.username === identifier || u.phone === identifier);
  if (!user) {
    return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '账号不存在' } });
  }
  // 密码验证：优先用 bcrypt（新用户），兼容明文密码（旧用户）
  let passwordValid = false;
  if (user.password_hash) {
    passwordValid = bcrypt.compareSync(password, user.password_hash);
  } else if (user.password) {
    passwordValid = (user.password === password);
    // 自动升级旧密码为 bcrypt 哈希
    if (passwordValid) {
      user.password_hash = bcrypt.hashSync(password, 10);
      delete user.password;
      saveDB();
    }
  }
  if (!passwordValid) {
    return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '密码错误' } });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.nickname = user.nickname || user.username;
  req.session.phone = user.phone || '';
  return res.redirect('/');
});

app.get('/register', (req, res) => renderWithLayout(req, res, 'auth/register', { title: '注册' }));

app.post('/register', (req, res) => {
  const { username, phone, password, nickname } = req.body;
  const usernameTrim = (username || '').trim();
  const phoneTrim = (phone || '').trim();
  // 手机号或用户名至少填一个
  if (!usernameTrim && !phoneTrim) {
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '请填写手机号或用户名' } });
  }
  // 手机号格式校验（中国大陆）
  if (phoneTrim && !/^1[3-9]\d{9}$/.test(phoneTrim)) {
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '请输入正确的11位手机号' } });
  }
  if (usernameTrim && usernameTrim.length < 2) {
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '用户名至少2个字符' } });
  }
  if (!password || password.length < 4) {
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '密码至少4位' } });
  }
  // 检查手机号是否已注册
  if (phoneTrim && db.users.find(u => u.phone === phoneTrim)) {
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '该手机号已被注册' } });
  }
  // 检查用户名是否已注册
  if (usernameTrim && db.users.find(u => u.username === usernameTrim)) {
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '该用户名已被注册' } });
  }
  // 生成唯一的用户名（如果只提供了手机号）
  const finalUsername = usernameTrim || ('用户' + phoneTrim.slice(-4));
  // 密码哈希存储
  const passwordHash = bcrypt.hashSync(password, 10);
  db.users.push({
    id: nextId++,
    username: finalUsername,
    phone: phoneTrim || null,
    password_hash: passwordHash,
    nickname: (nickname || finalUsername).trim(),
    created_at: localNow()
  });
  saveDB();
  renderWithLayout(req, res, 'auth/login', {
    title: '登录',
    flash: { category: 'success', message: '注册成功！请使用手机号或用户名登录' }
  });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ─── JSON API（供原生 App 调用） ───
// 手机号登录 API
app.post('/api/phone-login', (req, res) => {
  const phone = (req.body.phone || '').trim().replace(/\s/g, '');
  const { password } = req.body;

  if (!phone) return res.json({ success: false, message: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.json({ success: false, message: '请输入正确的11位手机号' });
  if (!password) return res.json({ success: false, message: '请输入密码' });

  const user = db.users.find(u => u.phone === phone);
  if (!user) return res.json({ success: false, message: '该手机号未注册，请先注册' });

  let passwordValid = false;
  if (user.password_hash) {
    passwordValid = bcrypt.compareSync(password, user.password_hash);
  } else if (user.password) {
    passwordValid = (user.password === password);
    if (passwordValid) {
      user.password_hash = bcrypt.hashSync(password, 10);
      delete user.password;
      saveDB();
    }
  }

  if (!passwordValid) return res.json({ success: false, message: '密码错误' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.nickname = user.nickname || user.username;
  req.session.phone = user.phone || '';
  return res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname || user.username, phone: user.phone || '' } });
});

// 手机号注册 API
app.post('/api/register', (req, res) => {
  const { phone, password, nickname } = req.body;
  const phoneTrim = (phone || '').trim();
  const passwordTrim = (password || '').trim();

  if (!phoneTrim) return res.json({ success: false, message: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phoneTrim)) return res.json({ success: false, message: '请输入正确的11位手机号' });
  if (!passwordTrim || passwordTrim.length < 4) return res.json({ success: false, message: '密码至少4位' });
  if (db.users.find(u => u.phone === phoneTrim)) return res.json({ success: false, message: '该手机号已被注册' });

  const finalUsername = '用户' + phoneTrim.slice(-4);
  const passwordHash = bcrypt.hashSync(passwordTrim, 10);
  const newUser = {
    id: nextId++,
    username: finalUsername,
    phone: phoneTrim,
    password_hash: passwordHash,
    nickname: (nickname || finalUsername).trim(),
    created_at: localNow()
  };
  db.users.push(newUser);
  saveDB();

  // 注册成功自动登录
  req.session.userId = newUser.id;
  req.session.username = newUser.username;
  req.session.nickname = newUser.nickname;
  req.session.phone = newUser.phone;
  return res.json({ success: true, user: { id: newUser.id, username: newUser.username, nickname: newUser.nickname, phone: newUser.phone } });
});

// 获取当前登录用户
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ success: false, message: '未登录' });
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ success: false, message: '用户不存在' });
  return res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname || user.username, phone: user.phone || '' } });
});

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
 
