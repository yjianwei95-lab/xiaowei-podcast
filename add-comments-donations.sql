-- 添加评论和打赏功能 - 小伟播客
-- 在 Supabase SQL Editor 中运行此脚本

-- 1. 评论表
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  episode_uuid UUID REFERENCES episodes(uuid) ON DELETE CASCADE,
  nickname TEXT DEFAULT '匿名',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  status INTEGER DEFAULT 1 -- 1=正常, 0=已删除
);

-- 2. 打赏记录表
CREATE TABLE IF NOT EXISTS donations (
  id SERIAL PRIMARY KEY,
  episode_uuid UUID REFERENCES episodes(uuid) ON DELETE CASCADE,
  nickname TEXT DEFAULT '匿名',
  amount DECIMAL(10,2) DEFAULT 0,
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  status INTEGER DEFAULT 1 -- 1=正常, 0=已删除
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_comments_episode_uuid ON comments(episode_uuid);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_episode_uuid ON donations(episode_uuid);
CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations(created_at DESC);

-- 禁用 RLS（简化方案，后端用 service_role key 访问）
ALTER TABLE comments DISABLE ROW LEVEL SECURITY;
ALTER TABLE donations DISABLE ROW LEVEL SECURITY;
