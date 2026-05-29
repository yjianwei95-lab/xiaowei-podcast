// 小伟播客 - 声音文件分享平台
// 支持用户上传音频文件、在线播放、后台管理

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'podcast.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── 文件上传配置 ─────────────────────────────────
const allowedMimes = [
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg',
  'audio/aac', 'audio/flac', 'audio/x-m4a', 'audio/mp4',
  'audio/webm', 'audio/x-wav'
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 最大 200MB
  fileFilter: (req, file, cb) => {
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式，仅支持 mp3/wav/ogg/aac/flac'));
    }
  }
});

// ─── 数据库 ──────────────────────────────────────────
function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS podcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      duration TEXT DEFAULT '',
      uploader_name TEXT DEFAULT '匿名',
      uploader_email TEXT DEFAULT '',
      uploader_ip TEXT DEFAULT '',
      uploader_agent TEXT DEFAULT '',
      play_count INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      podcast_uuid TEXT NOT NULL,
      ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      referer TEXT DEFAULT '',
      visited_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  const row = db.prepare('SELECT COUNT(*) as count FROM admin').get();
  if (row.count === 0) {
    db.prepare('INSERT INTO admin (username, password) VALUES (?, ?)').run('admin', 'admin123');
  }

  db.close();
}

// ─── 工具 ──────────────────────────────────────────
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function getStats(db) {
  const totalPodcasts = db.prepare('SELECT COUNT(*) as c FROM podcasts').get().c;
  const totalPlayed = db.prepare('SELECT COALESCE(SUM(play_count), 0) as c FROM podcasts').get().c;
  const totalVisitors = db.prepare('SELECT COUNT(*) as c FROM visitors').get().c;
  const todayVisitors = db.prepare(
    "SELECT COUNT(*) as c FROM visitors WHERE visited_at >= date('now', 'localtime')"
  ).get().c;
  const totalSize = db.prepare('SELECT COALESCE(SUM(file_size), 0) as c FROM podcasts').get().c;
  return { totalPodcasts, totalPlayed, totalVisitors, todayVisitors, totalSize };
}

// ─── Express 中间件 ──────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 自定义渲染
function renderWithLayout(res, template, data = {}) {
  const layoutData = {
    title: data.title || '小伟播客',
    flash: data.flash || null,
  };
  res.render(template, data, (err, html) => {
    if (err) {
      console.error('Render error:', err);
      return res.status(500).send('页面渲染出错: ' + err.message);
    }
    res.render('layout', { ...layoutData, content: html });
  });
}

function requireLogin(req, res, next) {
  if (!req.session.loggedIn) return res.redirect('/admin/login');
  next();
}

// ─── 前台路由 ─────────────────────────────────────

// 首页 - 播客列表
app.get('/', (req, res) => {
  const db = new Database(DB_PATH);
  const podcasts = db.prepare(
    'SELECT * FROM podcasts WHERE status = 1 ORDER BY created_at DESC'
  ).all();
  const stats = getStats(db);
  db.close();
  renderWithLayout(res, 'index', { podcasts, stats, title: '小伟播客' });
});

// 播放页面
app.get('/play/:uuid', (req, res) => {
  const db = new Database(DB_PATH);
  const podcast = db.prepare('SELECT * FROM podcasts WHERE uuid = ? AND status = 1').get(req.params.uuid);
  if (!podcast) {
    db.close();
    return renderWithLayout(res, '404', { title: '页面未找到' });
  }
  // 记录访客
  const ip = getClientIP(req);
  db.prepare(
    'INSERT INTO visitors (podcast_uuid, ip, user_agent, referer, visited_at) VALUES (?, ?, ?, ?, ?)'
  ).run(podcast.uuid, ip, req.headers['user-agent'] || '', req.headers['referer'] || '', new Date().toISOString());
  // 增加播放计数
  db.prepare('UPDATE podcasts SET play_count = play_count + 1 WHERE uuid = ?').run(podcast.uuid);
  db.close();
  // 把 req 也传进模板，分享链接需要用到 host
  renderWithLayout(res, 'player', { podcast, title: podcast.title, req });
});

// 上传页面
app.get('/upload', (req, res) => {
  renderWithLayout(res, 'upload', { title: '上传声音' });
});

// 处理上传
app.post('/upload', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return renderWithLayout(res, 'upload', {
            title: '上传声音',
            flash: { category: 'error', message: '文件太大！最大支持 200MB' }
          });
        }
        return renderWithLayout(res, 'upload', {
          title: '上传声音',
          flash: { category: 'error', message: err.message }
        });
      }
      return renderWithLayout(res, 'upload', {
        title: '上传声音',
        flash: { category: 'error', message: err.message }
      });
    }

    if (!req.file) {
      return renderWithLayout(res, 'upload', {
        title: '上传声音',
        flash: { category: 'error', message: '请选择一个音频文件' }
      });
    }

    const { title, description, uploader_name, uploader_email } = req.body;
    if (!title || !title.trim()) {
      // 删除已上传的文件
      fs.unlinkSync(req.file.path);
      return renderWithLayout(res, 'upload', {
        title: '上传声音',
        flash: { category: 'error', message: '请输入节目标题' }
      });
    }

    const uuid = uuidv4();
    const now = new Date().toISOString();

    const db = new Database(DB_PATH);
    db.prepare(`
      INSERT INTO podcasts (uuid, title, description, filename, original_name, file_size, uploader_name, uploader_email, uploader_ip, uploader_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid,
      title.trim(),
      (description || '').trim(),
      req.file.filename,
      req.file.originalname,
      req.file.size,
      (uploader_name || '匿名').trim(),
      (uploader_email || '').trim(),
      getClientIP(req),
      req.headers['user-agent'] || '',
      now
    );
    db.close();

    renderWithLayout(res, 'upload', {
      title: '上传成功',
      flash: { category: 'success', message: `🎉 上传成功！《${title.trim()}》已发布` },
      uploaded: { uuid, title: title.trim() },
      req
    });
  });
});

// ─── 后台路由 ─────────────────────────────────────

app.get('/admin/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.render('admin/login', { flash: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const db = new Database(DB_PATH);
  const user = db.prepare('SELECT * FROM admin WHERE username = ? AND password = ?').get(username, password);
  db.close();
  if (user) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.redirect('/admin');
  }
  res.render('admin/login', { flash: { category: 'error', message: '用户名或密码错误' } });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// 后台首页 - 总览
app.get('/admin', requireLogin, (req, res) => {
  const db = new Database(DB_PATH);
  const stats = getStats(db);
  const recentPodcasts = db.prepare('SELECT * FROM podcasts ORDER BY created_at DESC LIMIT 5').all();
  const recentVisitors = db.prepare(`
    SELECT v.*, p.title as podcast_title FROM visitors v
    LEFT JOIN podcasts p ON v.podcast_uuid = p.uuid
    ORDER BY v.visited_at DESC LIMIT 10
  `).all();
  db.close();
  renderWithLayout(res, 'admin/dashboard', { stats, recentPodcasts, recentVisitors, title: '后台总览' });
});

// 播客管理
app.get('/admin/podcasts', requireLogin, (req, res) => {
  const db = new Database(DB_PATH);
  const podcasts = db.prepare('SELECT * FROM podcasts ORDER BY created_at DESC').all();
  db.close();
  renderWithLayout(res, 'admin/podcasts', { podcasts, title: '播客管理' });
});

// 切换发布状态
app.post('/admin/toggle/:id', requireLogin, (req, res) => {
  const db = new Database(DB_PATH);
  const p = db.prepare('SELECT * FROM podcasts WHERE id = ?').get(req.params.id);
  if (p) {
    db.prepare('UPDATE podcasts SET status = ? WHERE id = ?').run(p.status ? 0 : 1, req.params.id);
  }
  db.close();
  res.redirect('/admin/podcasts');
});

// 删除播客
app.post('/admin/delete/:id', requireLogin, (req, res) => {
  const db = new Database(DB_PATH);
  const p = db.prepare('SELECT * FROM podcasts WHERE id = ?').get(req.params.id);
  if (p) {
    // 删除文件
    const filePath = path.join(UPLOAD_DIR, p.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // 删除数据库记录
    db.prepare('DELETE FROM visitors WHERE podcast_uuid = ?').run(p.uuid);
    db.prepare('DELETE FROM podcasts WHERE id = ?').run(req.params.id);
  }
  db.close();
  res.redirect('/admin/podcasts');
});

// 访客记录
app.get('/admin/visitors', requireLogin, (req, res) => {
  const db = new Database(DB_PATH);
  const visitors = db.prepare(`
    SELECT v.*, p.title as podcast_title, p.uploader_name
    FROM visitors v
    LEFT JOIN podcasts p ON v.podcast_uuid = p.uuid
    ORDER BY v.visited_at DESC
  `).all();
  const byPodcast = db.prepare(`
    SELECT p.uuid, p.title, COUNT(v.id) as visits, MAX(v.visited_at) as last_visit
    FROM podcasts p
    LEFT JOIN visitors v ON p.uuid = v.podcast_uuid
    GROUP BY p.uuid
    ORDER BY visits DESC
  `).all();
  db.close();
  renderWithLayout(res, 'admin/visitors', { visitors, byPodcast, title: '访客记录' });
});

// 修改密码
app.get('/admin/password', requireLogin, (req, res) => {
  renderWithLayout(res, 'admin/password', { title: '修改密码' });
});

app.post('/admin/password', requireLogin, (req, res) => {
  const { old_password, new_password } = req.body;
  const db = new Database(DB_PATH);
  const user = db.prepare('SELECT * FROM admin WHERE username = ? AND password = ?').get(req.session.username, old_password);
  if (user) {
    db.prepare('UPDATE admin SET password = ? WHERE username = ?').run(new_password, req.session.username);
    db.close();
    res.redirect('/admin');
  } else {
    db.close();
    renderWithLayout(res, 'admin/password', { flash: { category: 'error', message: '原密码错误' } });
  }
});

// ─── 启动 ─────────────────────────────────────────────
initDB();

console.log('='.repeat(55));
console.log('  🎙️  小伟播客已启动！');
console.log(`  🌐 前台地址: http://localhost:${PORT}`);
console.log(`  📤 上传页面: http://localhost:${PORT}/upload`);
console.log(`  🔐 后台地址: http://localhost:${PORT}/admin/login`);
console.log('  👤 默认账号: admin');
console.log('  🔑 默认密码: admin123');
console.log('  ⚠️  首次登录后请尽快修改密码！');
console.log('='.repeat(55));

app.listen(PORT, '0.0.0.0');
