-- =====================================================================
-- 小伟播客 · 完整数据库初始化
-- 在 Supabase SQL Editor 中「全选 → Run」一次即可
-- 所有语句幂等（IF NOT EXISTS / ON CONFLICT DO NOTHING），可重复执行
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. users 用户表（含邮箱验证字段）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username            TEXT NOT NULL,
  email               TEXT,
  password_hash       TEXT NOT NULL,
  nickname            TEXT,
  phone               TEXT,
  email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token  TEXT,
  verification_expires TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ---------------------------------------------------------------------
-- 2. episodes 节目表
--    注意：uuid 由数据库自动生成（DEFAULT gen_random_uuid()）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS episodes (
  uuid          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT DEFAULT '',
  filename      TEXT NOT NULL,
  original_name TEXT,
  file_size     BIGINT DEFAULT 0,
  duration      TEXT DEFAULT '',
  uploader_name TEXT DEFAULT '匿名',
  uploader_email TEXT DEFAULT '',
  uploader_ip   TEXT,
  uploader_agent TEXT,
  play_count    INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 0,   -- 0=待审核, 1=已发布
  is_pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  is_featured   BOOLEAN NOT NULL DEFAULT FALSE,
  is_recommended BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_created_at ON episodes(created_at DESC);

-- ---------------------------------------------------------------------
-- 3. admins 运营后台账号表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id       SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
-- 初始化一个运营账号（请改成你自己的密码！明文存储，与现有逻辑一致）
-- 首次运行取消下面注释并替换密码，随后可注释掉避免重复插入：
-- INSERT INTO admins (username, password) VALUES ('ops', '改成你的密码')
--   ON CONFLICT (username) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. visitors 访问统计表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visitors (
  id          SERIAL PRIMARY KEY,
  episode_uuid UUID,
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visitors_visited_at ON visitors(visited_at DESC);

-- ---------------------------------------------------------------------
-- 5. comments 评论表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id           SERIAL PRIMARY KEY,
  episode_uuid UUID REFERENCES episodes(uuid) ON DELETE CASCADE,
  nickname     TEXT DEFAULT '匿名',
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       INTEGER NOT NULL DEFAULT 1   -- 1=正常, 0=已删除
);
CREATE INDEX IF NOT EXISTS idx_comments_episode_uuid ON comments(episode_uuid);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at DESC);

-- ---------------------------------------------------------------------
-- 6. donations 打赏记录表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS donations (
  id           SERIAL PRIMARY KEY,
  episode_uuid UUID REFERENCES episodes(uuid) ON DELETE CASCADE,
  nickname     TEXT DEFAULT '匿名',
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  message      TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_donations_episode_uuid ON donations(episode_uuid);
CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations(created_at DESC);

-- ---------------------------------------------------------------------
-- 7. announcements 公告表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  id         SERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  date       DATE DEFAULT CURRENT_DATE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active);
CREATE INDEX IF NOT EXISTS idx_announcements_sort ON announcements(sort);

-- ---------------------------------------------------------------------
-- 8. session 表（connect-pg-simple，用于 express-session 持久化）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
  "sid"  VARCHAR NOT NULL COLLATE "default",
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ---------------------------------------------------------------------
-- 9. 音频存储桶 audio（公开读，后端用 service_role 写）
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('audio', 'audio', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 10. 关闭所有表的 RLS（简化方案：后端统一用 service_role key 访问）
-- ---------------------------------------------------------------------
ALTER TABLE users          DISABLE ROW LEVEL SECURITY;
ALTER TABLE episodes       DISABLE ROW LEVEL SECURITY;
ALTER TABLE admins         DISABLE ROW LEVEL SECURITY;
ALTER TABLE visitors       DISABLE ROW LEVEL SECURITY;
ALTER TABLE comments       DISABLE ROW LEVEL SECURITY;
ALTER TABLE donations      DISABLE ROW LEVEL SECURITY;
ALTER TABLE announcements  DISABLE ROW LEVEL SECURITY;
ALTER TABLE "session"      DISABLE ROW LEVEL SECURITY;
