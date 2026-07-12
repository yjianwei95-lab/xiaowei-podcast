-- 小伟播客 · 运营系统 数据库迁移
-- 在 Supabase SQL Editor 中运行一次即可
-- （episodes / visitors / comments / users / admins 表应已存在）

-- 1. 公告表（运营系统「公告与活动」模块使用）
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  date DATE DEFAULT CURRENT_DATE,
  active BOOLEAN DEFAULT TRUE,
  sort INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active);
CREATE INDEX IF NOT EXISTS idx_announcements_sort ON announcements(sort);

-- 2. episodes 增加运营标记字段（内容运营：置顶 / 精选 / 推荐）
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS is_recommended BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_episodes_pinned ON episodes(is_pinned);
CREATE INDEX IF NOT EXISTS idx_episodes_featured ON episodes(is_featured);

-- 3. 现有 admins 表即「运营账号」，无需改动；
--    若需新建运营账号，可执行（密码为明文，与现有逻辑一致）：
--    INSERT INTO admins (username, password) VALUES ('ops', 'yourpassword');

-- 禁用 RLS（后端用 service_role key 访问）
ALTER TABLE announcements DISABLE ROW LEVEL SECURITY;
