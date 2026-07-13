// 小伟播客 · 本地 SQLite 数据层（零外网依赖，Cloud Studio 工作区自包含）
// 用 better-sqlite3 替代 Supabase，所有表建在工作区 data.db 文件中。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// ============ 建表（幂等，可重复执行）============
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL,
  email               TEXT,
  password_hash       TEXT NOT NULL,
  nickname            TEXT,
  phone               TEXT,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  verification_token  TEXT,
  verification_expires TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS episodes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid              TEXT UNIQUE NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT DEFAULT '',
  filename          TEXT NOT NULL,
  original_name     TEXT,
  file_size         INTEGER DEFAULT 0,
  duration          TEXT DEFAULT '',
  uploader_name     TEXT DEFAULT '匿名',
  uploader_email    TEXT DEFAULT '',
  uploader_ip       TEXT,
  uploader_agent    TEXT,
  custom_tags       TEXT DEFAULT '[]',
  play_count        INTEGER NOT NULL DEFAULT 0,
  status            INTEGER NOT NULL DEFAULT 0,
  is_pinned         INTEGER NOT NULL DEFAULT 0,
  is_featured       INTEGER NOT NULL DEFAULT 0,
  is_recommended    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_uuid ON episodes(uuid);

CREATE TABLE IF NOT EXISTS admins (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL UNIQUE,
  password  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visitors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_uuid    TEXT,
  ip              TEXT,
  user_agent      TEXT,
  referer         TEXT,
  device_type     TEXT,
  os              TEXT,
  os_version      TEXT,
  browser         TEXT,
  browser_version TEXT,
  device_brand    TEXT,
  device_model    TEXT,
  screen_resolution TEXT,
  language        TEXT,
  platform        TEXT,
  visited_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_visitors_visited_at ON visitors(visited_at);

CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_uuid  TEXT,
  nickname      TEXT DEFAULT '匿名',
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_comments_episode_uuid ON comments(episode_uuid);

CREATE TABLE IF NOT EXISTS donations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_uuid  TEXT,
  nickname      TEXT DEFAULT '匿名',
  amount        REAL NOT NULL DEFAULT 0,
  message       TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  date        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ============ 初始化运营后台 admin 账号 ============
const adminUser = process.env.ADMIN_USERNAME || 'admin';
const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
try {
  const exist = db.prepare('SELECT id FROM admins WHERE username = ?').get(adminUser);
  if (!exist) {
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run(adminUser, adminPass);
    console.log(`[DB] 已初始化运营后台账号: ${adminUser} / ${adminPass}（请尽快修改密码）`);
  }
} catch (e) {
  console.error('[DB] 初始化 admin 失败:', e.message);
}

// ============ 便捷查询封装 ============
// 注意：better-sqlite3 是同步 API；custom_tags 等数组字段以 JSON 文本存储
function dbAll(sql, ...params) { return db.prepare(sql).all(...params); }
function dbGet(sql, ...params) { return db.prepare(sql).get(...params); }
function dbRun(sql, ...params) { return db.prepare(sql).run(...params); }

// 解析 custom_tags（存成 JSON 文本，兼容原 Supabase 数组用法）
function parseTags(raw) {
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ============ SQLite Session Store（重启不丢登录态）============
// 实现express-session的Store接口，session数据存入sessions表，服务重启后自动恢复。
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expired INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

function SqliteSessionStore(options) {
  this._ttlMs = (options && options.ttl) || 86400000; // 默认7天(ms)
  this._checkInterval = (options && options.checkPeriod) || 3600000;
  // 定期清理过期 session（每小时）
  const self = this;
  this._timer = setInterval(function () {
    try {
      db.prepare('DELETE FROM sessions WHERE expired <= ?').run(Date.now());
    } catch (_) {}
  }, this._checkInterval);
  if (this._timer.unref) this._timer.unref();
}
// express-session 要求 store 有 .on() 方法（EventEmitter 风格）
SqliteSessionStore.prototype.on = function () {}; // no-op
SqliteSessionStore.prototype.createSession = function (req, sess) {
  // 返回一个新的 session 对象，合并默认 cookie 配置
  return {
    cookie: {
      originalMaxAge: this._ttlMs,
      maxAge: this._ttlMs,
      expires: new Date(Date.now() + this._ttlMs),
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: false
    },
    ...(sess || {})
  };
};
SqliteSessionStore.prototype.get = function (sid, cb) {
  try {
    const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
    return cb(null, row ? JSON.parse(row.sess) : null);
  } catch (e) { return cb(e); }
};
SqliteSessionStore.prototype.set = function (sid, sess, cb) {
  try {
    const expires = Date.now() + (sess.cookie.maxAge || this._ttlMs);
    db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(
      sid, JSON.stringify(sess), expires
    );
    if (cb) cb(null);
  } catch (e) { if (cb) cb(e); }
};
SqliteSessionStore.prototype.destroy = function (sid, cb) {
  try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); if (cb) cb(null); }
  catch (e) { if (cb) cb(e); }
};
SqliteSessionStore.prototype.touch = function (sid, sess, cb) {
  try {
    const expires = Date.now() + (sess.cookie.maxAge || this._ttlMs);
    db.prepare('UPDATE sessions SET sess = ?, expired = ? WHERE sid = ?').run(
      JSON.stringify(sess), expires, sid
    );
    if (cb) cb(null);
  } catch (e) { if (cb) cb(e); }
};
SqliteSessionStore.prototype.all = function (cb) {
  try {
    const rows = db.prepare('SELECT sess FROM sessions WHERE expired > ?').all(Date.now());
    const result = {};
    rows.forEach(function (r) {
      var parsed;
      try { parsed = JSON.parse(r.sess); } catch (_) { return; }
      result[r.sid] = parsed;
    });
    cb(null, result);
  } catch (e) { cb(e); }
};

module.exports = { db, dbAll, dbGet, dbRun, parseTags, SqliteSessionStore };
