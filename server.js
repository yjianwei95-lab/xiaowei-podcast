const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const { EdgeTTS } = require('edge-tts-universal');

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
const PORT = process.env.PORT || 3000;

// Supabase 配置（密钥从环境变量读取，不在代码中硬编码）
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// 优先使用 service_role key（后端需要写入权限），没有则用 anon key
const supabaseKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
let supabase = null;
try {
  supabase = createClient(SUPABASE_URL, supabaseKey, {
    realtime: {
      transport: ws
    }
  });
} catch(e) {
  console.warn('⚠️ Supabase 初始化失败（环境变量 SUPABASE_URL 未配置？）:', e.message);
  console.warn('  播客相关功能（首页/上传/播放）不可用，但 TTS 配音仍可正常使用');
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 音频文件扩展名 → Content-Type 映射
const AUDIO_CONTENT_TYPES = {
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'm4a': 'audio/mp4',
  'ogg': 'audio/ogg',
  'aac': 'audio/aac',
  'flac': 'audio/flac'
};

// 公告数据（可后续迁移到数据库）
const ANNOUNCEMENTS = [
  { id: 1, text: '🎉 小伟播客 v1.0.2 全新发布！支持手机号登录、主题切换、收藏功能', date: '2026-06-06' },
  { id: 2, text: '📢 欢迎上传你的声音作品，分享你的故事！', date: '2026-06-06' },
  { id: 3, text: '🔥 热门节目推荐：点击首页「热门排行」查看', date: '2026-06-06' },
];

// 标签关键词（用于自动提取）
const TAG_KEYWORDS = ['音乐','故事','科技','生活','教育','娱乐','新闻','健康','商业','投资','游戏','电影','读书','旅行','美食','运动','情感','心理','历史','文化','科学','技术','播客','访谈','脱口秀','相声','评书','有声书','电台','演唱会','怀旧','励志','职场','创业','理财','编程','AI','人工智能','大数据','区块链'];

// ===================================================================
// 工具函数
// ===================================================================

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

// 解析 User-Agent 获取设备信息
function parseUserAgent(req) {
  const ua = req.headers['user-agent'] || '';
  const result = {
    device_type: 'unknown',
    os: '',
    os_version: '',
    browser: '',
    browser_version: '',
    device_brand: '',
    device_model: '',
    screen_resolution: '',
    language: req.headers['accept-language']?.split(',')[0] || '',
    platform: ''
  };

  // 检测设备类型
  if (/iPad|tablet|PlayBook|Silk/i.test(ua)) {
    result.device_type = 'tablet';
  } else if (/Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    result.device_type = 'mobile';
  } else {
    result.device_type = 'desktop';
  }

  // 检测操作系统
  if (/iPhone OS (\d+_?\d*)/i.test(ua)) {
    result.os = 'iOS';
    result.os_version = ua.match(/iPhone OS (\d+_?\d*)/i)[1].replace(/_/g, '.');
    result.platform = 'iPhone';
  } else if (/iPad.*OS (\d+_?\d*)/i.test(ua)) {
    result.os = 'iOS';
    result.os_version = ua.match(/iPad.*OS (\d+_?\d*)/i)[1].replace(/_/g, '.');
    result.platform = 'iPad';
  } else if (/Android (\d+(\.\d+)?)/i.test(ua)) {
    result.os = 'Android';
    result.os_version = ua.match(/Android (\d+(\.\d+)?)/i)[1];
    result.platform = 'Android';
  } else if (/Windows NT (\d+\.\d+)/i.test(ua)) {
    result.os = 'Windows';
    const winVer = ua.match(/Windows NT (\d+\.\d+)/i)[1];
    const winMap = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista' };
    result.os_version = winMap[winVer] || winVer;
    result.platform = 'Windows';
  } else if (/Mac OS X (\d+[._]\d+)/i.test(ua)) {
    result.os = 'macOS';
    result.os_version = ua.match(/Mac OS X (\d+[._]\d+)/i)[1].replace(/_/g, '.');
    result.platform = 'MacIntel';
  } else if (/Linux/i.test(ua)) {
    result.os = 'Linux';
    result.platform = 'Linux';
  }

  // 检测浏览器
  if (/Edg(?:e|A|iOS)?\/(\d+\.\d+)/i.test(ua)) {
    result.browser = 'Edge';
    result.browser_version = ua.match(/Edg(?:e|A|iOS)?\/(\d+\.\d+)/i)[1];
  } else if (/Firefox\/(\d+\.\d+)/i.test(ua)) {
    result.browser = 'Firefox';
    result.browser_version = ua.match(/Firefox\/(\d+\.\d+)/i)[1];
  } else if (/Chrome\/(\d+\.\d+)/i.test(ua) && !/Edg/i.test(ua)) {
    result.browser = 'Chrome';
    result.browser_version = ua.match(/Chrome\/(\d+\.\d+)/i)[1];
  } else if (/Safari\/(\d+\.\d+)/i.test(ua) && !/Chrome/i.test(ua)) {
    result.browser = 'Safari';
    result.browser_version = ua.match(/Version\/(\d+\.\d+)/i)?.[1] || '';
  }

  // 检测设备品牌和型号（移动设备）
  if (/iPhone/i.test(ua)) {
    result.device_brand = 'Apple';
    result.device_model = 'iPhone';
    const modelMatch = ua.match(/iPhone\s*(?:OS\s*)?(\d*)/i);
    if (modelMatch) result.device_model = `iPhone (iOS ${result.os_version})`;
  } else if (/iPad/i.test(ua)) {
    result.device_brand = 'Apple';
    result.device_model = 'iPad';
  } else if (/SM-([A-Z0-9]+)/i.test(ua)) {
    result.device_brand = 'Samsung';
    result.device_model = `Galaxy ${ua.match(/SM-([A-Z0-9]+)/i)[1]}`;
  } else if (/HUAWEI|HarmonyOS/i.test(ua)) {
    result.device_brand = 'Huawei';
    const huaweiMatch = ua.match(/(HUAWEI|JNY|NOH|OCE|ANA)-?[A-Z0-9]*/i);
    result.device_model = huaweiMatch ? huaweiMatch[0] : 'Huawei Device';
  } else if (/Xiaomi|Redmi|POCO/i.test(ua)) {
    result.device_brand = 'Xiaomi';
    const xiaomiMatch = ua.match(/(Xiaomi|Redmi|POCO)[_\s]?([A-Z0-9]+)?/i);
    result.device_model = xiaomiMatch ? xiaomiMatch[0] : 'Xiaomi Device';
  } else if (/OPPO|OnePlus/i.test(ua)) {
    result.device_brand = 'OPPO';
    result.device_model = 'OPPO Device';
  } else if (/vivo/i.test(ua)) {
    result.device_brand = 'vivo';
    result.device_model = 'vivo Device';
  }

  // 尝试从请求中获取屏幕分辨率（如果有 Viewport-Width 头）
  const viewportWidth = req.headers['viewport-width'] || req.headers['x-requested-with'];
  if (req.headers['sec-ch-viewport-width']) {
    result.screen_resolution = `${req.headers['sec-ch-viewport-width']}px`;
  }

  return result;
}

function localNow() {
  const d = new Date();
  const local = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return local.toISOString().replace('Z', '+08:00');
}

function renderWithLayout(req, res, template, data = {}) {
  const isAdmin = template.startsWith('admin/');
  const layoutName = isAdmin ? 'admin/layout' : 'layout';
  res.render(template, { ...data, session: req.session }, (err, html) => {
    if (err) return res.status(500).send('渲染错误: ' + err.message);
    res.render(layoutName, { title: data.title || '小伟播客', flash: data.flash || null, session: req.session, content: html });
  });
}

function requireAdmin(req, res, next) {
  if (!req.session.loggedIn) return res.redirect('/ops/login');
  next();
}

// ===================================================================
// 统计函数（从 Supabase 读取）
// ===================================================================

async function getStats() {
  try {
    const { count: totalPodcasts } = await supabase
      .from('episodes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 1);

    const { data: podcasts } = await supabase
      .from('episodes')
      .select('play_count, file_size')
      .eq('status', 1);

    const { count: totalVisitors } = await supabase
      .from('visitors')
      .select('*', { count: 'exact', head: true });

    const today = localNow().slice(0, 10);
    const { count: todayVisitors } = await supabase
      .from('visitors')
      .select('*', { count: 'exact', head: true })
      .gte('visited_at', today + 'T00:00:00+08:00')
      .lt('visited_at', today + 'T23:59:59+08:00');

    const totalPlayed = podcasts?.reduce((s, p) => s + (p.play_count || 0), 0) || 0;
    const totalSize = podcasts?.reduce((s, p) => s + (p.file_size || 0), 0) || 0;

    return { totalPodcasts: totalPodcasts || 0, totalPlayed, totalVisitors: totalVisitors || 0, todayVisitors: todayVisitors || 0, totalSize };
  } catch (e) {
    console.error('getStats error:', e.message);
    return { totalPodcasts: 0, totalPlayed: 0, totalVisitors: 0, todayVisitors: 0, totalSize: 0 };
  }
}

// 公告：优先读数据库 announcements 表（由运营系统管理），无则回退硬编码
async function getAnnouncements() {
  if (!supabase) return ANNOUNCEMENTS;
  try {
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .eq('active', true)
      .order('sort', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (data && data.length) return data.map(a => ({ id: a.id, text: a.text, date: a.date }));
    return ANNOUNCEMENTS;
  } catch (e) {
    console.warn('[公告] 读取数据库失败，使用硬编码:', e.message);
    return ANNOUNCEMENTS;
  }
}

// ===================================================================
// Express 中间件
// ===================================================================

const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// 音频文件上传：本地暂存，然后上传到 Supabase Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/aac','audio/flac','audio/x-m4a','audio/mp4','audio/webm','audio/x-wav'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('不支持的文件格式'));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// CORS 中间件（支持安卓 APP 跨域请求）
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 信任反向代理（Railway 等平台使用 HTTPS 代理 → HTTP 应用）
// 必须设置在 session 之前，否则 secure cookie 不会被设置
app.set('trust proxy', 1);

// Session 中间件
let sessionStore = null;
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    sessionStore = new PgSession({ pool: pgPool, tableName: 'session', createTableIfMissing: true });
    console.log('[Session] 使用 PostgreSQL 持久化存储');
    // 数据库迁移：添加 custom_tags 字段
    pgPool.query(`
      DO $$ BEGIN
        ALTER TABLE episodes ADD COLUMN custom_tags TEXT[] DEFAULT '{}';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `).then(() => console.log('[Migration] custom_tags 字段已就绪'))
      .catch(e => console.log('[Migration] 跳过（可能表尚未创建）:', e.message));
  } catch (e) {
    console.error('[Session] PostgreSQL 连接失败，回退到内存存储:', e.message);
  }
} else {
  console.log('[Session] DATABASE_URL 未设置，使用内存存储（生产环境建议配置 PostgreSQL）');
}

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log(`[Session] isProduction=${isProduction}, trust proxy 已启用`);
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'xiaowei-podcast-fixed-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===================================================================
// 路由
// ===================================================================

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 诊断路由
app.get('/debug', async (req, res) => {
  const diagnostics = {
    env: {
      SUPABASE_URL: SUPABASE_URL ? SUPABASE_URL.replace(/\.co.*/, '.co') + '...' : '(未设置)',
      SUPABASE_SERVICE_KEY: SUPABASE_SERVICE_KEY ? '已设置 (长度:' + SUPABASE_SERVICE_KEY.length + ')' : '(未设置)',
      SUPABASE_ANON_KEY: SUPABASE_ANON_KEY ? '已设置 (长度:' + SUPABASE_ANON_KEY.length + ')' : '(未设置)',
      supabaseKey: supabaseKey ? '已设置 (长度:' + supabaseKey.length + ')' : '(未设置)',
      PORT: process.env.PORT || '(默认3000)'
    },
    connection: null,
    episodes: null,
    error: null
  };
  try {
    const { data: episodes, error } = await supabase.from('episodes').select('*').limit(3);
    if (error) {
      diagnostics.error = error.message;
      diagnostics.connection = '失败';
    } else {
      diagnostics.connection = '成功';
      diagnostics.episodes = { count: episodes ? episodes.length : 0, first: episodes && episodes[0] ? episodes[0].title : null };
    }
  } catch (e) {
    diagnostics.error = e.message;
    diagnostics.connection = '异常';
  }
  res.json(diagnostics);
});

// 音频文件路由（从 Supabase Storage 重定向）
app.get('/uploads/:filename', (req, res) => {
  const redirectUrl = `${SUPABASE_URL}/storage/v1/object/public/audio/${req.params.filename}`;
  res.redirect(302, redirectUrl);
});

// 首页
app.get('/', async (req, res) => {
  try {
    const { data: podcasts, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('status', 1)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('【首页Supabase错误】', error.message, error);
      throw error;
    }
    console.log('【首页查询成功】获取到', podcasts ? podcasts.length : 0, '条节目');
    const stats = await getStats();

    // 主列表：置顶（is_pinned）优先，其余按创建时间倒序（运营后台置顶开关实时生效）
    const sortedPodcasts = [...(podcasts || [])].sort((a, b) => {
      const pa = a.is_pinned ? 1 : 0;
      const pb = b.is_pinned ? 1 : 0;
      if (pa !== pb) return pb - pa; // 置顶排前
      return new Date(b.created_at) - new Date(a.created_at);
    });

    // 精选（is_featured）与推荐（is_recommended）区块数据，均按创建时间倒序
    const featuredPodcasts = [...(podcasts || [])]
      .filter(p => p.is_featured)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const recommendedPodcasts = [...(podcasts || [])]
      .filter(p => p.is_recommended)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 热门排行 Top 5（按播放量）
    const hotPodcasts = [...(podcasts || [])].sort((a, b) => (b.play_count || 0) - (a.play_count || 0)).slice(0, 5);

    // 最近更新 Top 3
    const recentPodcasts = [...(podcasts || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3);

    // 标签提取（从标题和描述中提取关键词）
    const tags = [...new Set((podcasts || []).flatMap(p =>
      TAG_KEYWORDS.filter(t => (p.title || '').includes(t) || (p.description || '').includes(t))
    ))];

    // 热门创作者 Top 5（按上传数量）
    const creatorCount = {};
    (podcasts || []).forEach(p => { creatorCount[p.uploader_name] = (creatorCount[p.uploader_name] || 0) + 1; });
    const topCreators = Object.entries(creatorCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    renderWithLayout(req, res, 'index', {
      podcasts: sortedPodcasts,
      featuredPodcasts,
      recommendedPodcasts,
      stats,
      hotPodcasts,
      recentPodcasts,
      tags,
      topCreators,
      announcements: await getAnnouncements(),
      title: '小伟播客'
    });
  } catch (e) {
    console.error('【首页错误】', e.message, e);
    renderWithLayout(req, res, 'index', {
      podcasts: [],
      featuredPodcasts: [],
      recommendedPodcasts: [],
      stats: { totalPodcasts:0, totalPlayed:0, totalVisitors:0, todayVisitors:0, totalSize:0 },
      hotPodcasts: [],
      recentPodcasts: [],
      tags: [],
      topCreators: [],
      announcements: await getAnnouncements(),
      title: '小伟播客'
    });
  }
});

// PWA安装教程页面
app.get('/app', (req, res) => {
  renderWithLayout(req, res, 'app', { title: '安装APP - 小伟播客', domain: req.headers.host });
});

// 播放页面
app.get('/play/:uuid', async (req, res) => {
  try {
    const { data: podcast, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('uuid', req.params.uuid)
      .eq('status', 1)
      .single();

    if (error || !podcast) return renderWithLayout(req, res, '404', { title: '未找到' });

    // 生成 Supabase Storage 音频 URL（公网可访问）
    const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/audio/${podcast.filename}`;

    // 增加播放次数
    await supabase
      .from('episodes')
      .update({ play_count: (podcast.play_count || 0) + 1 })
      .eq('uuid', req.params.uuid);

    // 记录访客（包含设备信息）
    const deviceInfo = parseUserAgent(req);
    await supabase
      .from('visitors')
      .insert([{
        episode_uuid: req.params.uuid,
        ip: getClientIP(req),
        user_agent: req.headers['user-agent'] || '',
        referer: req.headers['referer'] || '',
        device_type: deviceInfo.device_type,
        os: deviceInfo.os,
        os_version: deviceInfo.os_version,
        browser: deviceInfo.browser,
        browser_version: deviceInfo.browser_version,
        device_brand: deviceInfo.device_brand,
        device_model: deviceInfo.device_model,
        screen_resolution: deviceInfo.screen_resolution,
        language: deviceInfo.language,
        platform: deviceInfo.platform
      }]);

    renderWithLayout(req, res, 'player', { podcast, audioUrl, title: podcast.title, req, user: req.session.userId ? { id: req.session.userId, username: req.session.username, nickname: req.session.nickname } : null });
  } catch (e) {
    console.error('播放页面错误:', e.message);
    renderWithLayout(req, res, '404', { title: '未找到' });
  }
});

// 上传页面
app.get('/upload', (req, res) => renderWithLayout(req, res, 'upload', { title: '上传声音' }));

// 录音室页面
app.get('/recorder', (req, res) => renderWithLayout(req, res, 'recorder', { title: '录音室' }));

// 上传处理
app.post('/upload', (req, res) => {
  upload.single('audio')(req, res, async (err) => {
    if (err) return renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: err.message } });
    if (!req.file) return renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: '请选择文件' } });

    const { title, description, uploader_name, uploader_email } = req.body;
    if (!title || !title.trim()) {
      fs.unlinkSync(req.file.path);
      return renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: '请输入标题' } });
    }

    try {
      // 1. 上传音频文件到 Supabase Storage（必须成功）
      const fileBuffer = fs.readFileSync(req.file.path);
      const filePath = `${req.file.filename}`;
      
      // 根据文件扩展名检测正确的 Content-Type
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const contentType = AUDIO_CONTENT_TYPES[ext] || 'audio/mpeg';

      const { error: uploadError } = await supabase.storage
        .from('audio')
        .upload(filePath, fileBuffer, {
          contentType: contentType,
          upsert: false
        });

      if (uploadError) {
        console.error('❌ Storage上传失败:', uploadError.message);
        fs.unlinkSync(req.file.path); // 删除本地临时文件
        return renderWithLayout(req, res, 'upload', { 
          title: '上传声音', 
          flash: { category: 'error', message: '上传到云存储失败：' + uploadError.message } 
        });
      }

      // 上传成功，删除本地临时文件
      fs.unlinkSync(req.file.path);
      console.log('✅ Storage上传成功:', filePath);

      // 2. 插入数据库记录
      const { data: episode, error: dbError } = await supabase
        .from('episodes')
        .insert([{
          title: title.trim(),
          description: (description || '').trim(),
          filename: req.file.filename,
          original_name: req.file.originalname,
          file_size: req.file.size,
          duration: '',
          uploader_name: (uploader_name || '匿名').trim(),
          uploader_email: (uploader_email || '').trim(),
          uploader_ip: getClientIP(req),
          uploader_agent: req.headers['user-agent'] || '',
          play_count: 0,
          status: 1
        }])
        .select()
        .single();

      if (dbError) throw dbError;

      renderWithLayout(req, res, 'upload', {
        title: '上传成功',
        flash: { category: 'success', message: `🎉 上传成功！《${title.trim()}》已发布` },
        uploaded: { uuid: episode.uuid, title: title.trim() },
        req
      });
    } catch (e) {
      console.error('上传错误:', e.message);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      renderWithLayout(req, res, 'upload', { title: '上传声音', flash: { category: 'error', message: '上传失败: ' + e.message } });
    }
  });
});

// API 上传（录音室等场景用）
app.post('/api/upload', (req, res) => {
  upload.single('audio')(req, res, async (err) => {
    if (err) return res.json({ success: false, message: err.message });
    if (!req.file) return res.json({ success: false, message: '请选择文件' });

    const { title, description, uploader_name, uploader_email } = req.body;
    if (!title || !title.trim()) {
      fs.unlinkSync(req.file.path);
      return res.json({ success: false, message: '请输入标题' });
    }

    try {
      const fileBuffer = fs.readFileSync(req.file.path);
      const filePath = `${req.file.filename}`;
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const contentType = AUDIO_CONTENT_TYPES[ext] || 'audio/mpeg';

      const { error: uploadError } = await supabase.storage
        .from('audio')
        .upload(filePath, fileBuffer, { contentType, upsert: false });

      if (uploadError) {
        console.error('❌ Storage上传失败:', uploadError.message);
        fs.unlinkSync(req.file.path);
        return res.json({ success: false, message: '上传到云存储失败：' + uploadError.message });
      }

      fs.unlinkSync(req.file.path);
      console.log('✅ API Storage上传成功:', filePath);

      const { data: episode, error: dbError } = await supabase
        .from('episodes')
        .insert([{
          title: title.trim(),
          description: (description || '').trim(),
          filename: req.file.filename,
          original_name: req.file.originalname,
          file_size: req.file.size,
          duration: '',
          uploader_name: (uploader_name || '匿名').trim(),
          uploader_email: (uploader_email || '').trim(),
          uploader_ip: getClientIP(req),
          uploader_agent: req.headers['user-agent'] || '',
          play_count: 0,
          status: 1
        }])
        .select()
        .single();

      if (dbError) throw dbError;
      res.json({ success: true, uuid: episode.uuid, title: title.trim() });
    } catch (e) {
      console.error('API上传错误:', e.message);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.json({ success: false, message: '上传失败: ' + e.message });
    }
  });
});

// 音频编辑器
app.get('/audio-editor', async (req, res) => {
  const podcastId = req.query.podcastId || null;
  let podcast = null;
  if (podcastId) {
    const { data } = await supabase.from('episodes').select('*').eq('id', podcastId).single();
    podcast = data;
  }
  renderWithLayout(req, res, 'audio-editor', { title: '音频编辑', podcast, podcastId });
});

app.post('/audio-editor/upload', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) return res.json({ error: '上传失败: ' + err.message });
    if (!req.file) return res.json({ error: '请选择文件' });
    res.json({ success: true, filename: req.file.filename, originalName: req.file.originalname, size: req.file.size, url: '/uploads/' + req.file.filename });
  });
});

// ===================================================================
// 用户认证（手机号/用户名登录）
// ===================================================================

// 手机号登录页面
app.get('/phone-login', (req, res) => {
  if (req.session.userId || req.session.isAdmin) return res.redirect('/');
  renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录' });
});

app.post('/phone-login', async (req, res) => {
  const phone = (req.body.phone || '').trim().replace(/\s/g, '');
  const { password } = req.body;
  const isApi = req.headers['content-type']?.includes('application/json') || req.headers['accept']?.includes('application/json');

  if (!phone) {
    if (isApi) return res.json({ success: false, message: '请输入手机号' });
    return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '请输入手机号' } });
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    if (isApi) return res.json({ success: false, message: '请输入正确的11位手机号' });
    return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '请输入正确的11位手机号' }, phone });
  }
  if (!password) {
    if (isApi) return res.json({ success: false, message: '请输入密码' });
    return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '请输入密码' }, phone });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (error || !user) {
      if (isApi) return res.json({ success: false, message: '该手机号未注册，请先注册' });
      return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '该手机号未注册，请先注册' }, phone });
    }

    let passwordValid = bcrypt.compareSync(password, user.password_hash);
    if (!passwordValid) {
      if (isApi) return res.json({ success: false, message: '密码错误' });
      return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '密码错误' }, phone });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.nickname = user.nickname || user.username;
    req.session.phone = user.phone || '';

    req.session.save(function(err) {
      if (err) console.error('[Session Save Error]', err);
      if (isApi) return res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname } });
      return res.redirect('/');
    });
  } catch (e) {
    if (isApi) return res.json({ success: false, message: '登录失败' });
    return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '登录失败' }, phone });
  }
});

// 用户名/手机号登录
app.get('/login', (req, res) => {
  if (req.session.userId || req.session.isAdmin) return res.redirect('/');
  renderWithLayout(req, res, 'auth/login', { title: '登录' });
});

app.post('/login', async (req, res) => {
  const identifier = (req.body.username || '').trim();
  const isApi = req.headers['content-type']?.includes('application/json') || req.headers['accept']?.includes('application/json');

  if (!identifier) {
    if (isApi) return res.json({ success: false, message: '请输入手机号或用户名' });
    return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '请输入手机号或用户名' } });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .or(`username.eq.${identifier},phone.eq.${identifier}`)
      .single();

    if (error || !user) {
      if (isApi) return res.json({ success: false, message: '账号不存在' });
      return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '账号不存在' } });
    }

    let passwordValid = bcrypt.compareSync(req.body.password, user.password_hash);
    if (!passwordValid) {
      if (isApi) return res.json({ success: false, message: '密码错误' });
      return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '密码错误' } });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.nickname = user.nickname || user.username;
    req.session.phone = user.phone || '';

    req.session.save(function(err) {
      if (err) console.error('[Session Save Error]', err);
      if (isApi) return res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname } });
      return res.redirect('/');
    });
  } catch (e) {
    if (isApi) return res.json({ success: false, message: '登录失败' });
    return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '登录失败' } });
  }
});

// 注册
app.get('/register', (req, res) => renderWithLayout(req, res, 'auth/register', { title: '注册' }));

app.post('/register', async (req, res) => {
  const { username, phone, password, nickname } = req.body;
  const usernameTrim = (username || '').trim();
  const phoneTrim = (phone || '').trim();
  const isApi = req.headers['content-type']?.includes('application/json') || req.headers['accept']?.includes('application/json');

  if (!usernameTrim && !phoneTrim) {
    if (isApi) return res.json({ success: false, message: '请填写手机号或用户名' });
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '请填写手机号或用户名' } });
  }
  if (phoneTrim && !/^1[3-9]\d{9}$/.test(phoneTrim)) {
    if (isApi) return res.json({ success: false, message: '请输入正确的11位手机号' });
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '请输入正确的11位手机号' } });
  }
  if (usernameTrim && usernameTrim.length < 2) {
    if (isApi) return res.json({ success: false, message: '用户名至少2个字符' });
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '用户名至少2个字符' } });
  }
  if (!password || password.length < 4) {
    if (isApi) return res.json({ success: false, message: '密码至少4位' });
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '密码至少4位' } });
  }

  try {
    // 检查是否已注册
    if (phoneTrim) {
      const { data: existingPhone } = await supabase.from('users').select('id').eq('phone', phoneTrim).maybeSingle();
      if (existingPhone) {
        if (isApi) return res.json({ success: false, message: '该手机号已被注册' });
        return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '该手机号已被注册' } });
      }
    }
    if (usernameTrim) {
      const { data: existingUser } = await supabase.from('users').select('id').eq('username', usernameTrim).maybeSingle();
      if (existingUser) {
        if (isApi) return res.json({ success: false, message: '该用户名已被注册' });
        return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '该用户名已被注册' } });
      }
    }

    const finalUsername = usernameTrim || ('用户' + phoneTrim.slice(-4));
    const passwordHash = bcrypt.hashSync(password, 10);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{
        username: finalUsername,
        phone: phoneTrim || null,
        password_hash: passwordHash,
        nickname: (nickname || finalUsername).trim(),
      }])
      .select()
      .single();

    if (error) throw error;

    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.nickname = newUser.nickname;
    req.session.phone = newUser.phone || '';

    req.session.save(function(err) {
      if (err) console.error('[Session Save Error]', err);
      if (isApi) return res.json({ success: true, user: { id: newUser.id, username: newUser.username, nickname: newUser.nickname } });
      return res.redirect('/');
    });
  } catch (e) {
    console.error('注册错误:', e.message);
    if (isApi) return res.json({ success: false, message: '注册失败: ' + e.message });
    return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '注册失败: ' + e.message } });
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ===================================================================
// JSON API（供原生 App 调用）
// ===================================================================

app.post('/api/phone-login', async (req, res) => {
  const phone = (req.body.phone || '').trim().replace(/\s/g, '');
  const { password } = req.body;

  if (!phone) return res.json({ success: false, message: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.json({ success: false, message: '请输入正确的11位手机号' });
  if (!password) return res.json({ success: false, message: '请输入密码' });

  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (error || !user) return res.json({ success: false, message: '该手机号未注册，请先注册' });

    if (!bcrypt.compareSync(password, user.password_hash)) return res.json({ success: false, message: '密码错误' });

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.nickname = user.nickname || user.username;
    req.session.phone = user.phone || '';
    return res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname || user.username, phone: user.phone || '' } });
  } catch (e) {
    return res.json({ success: false, message: '登录失败' });
  }
});

app.post('/api/register', async (req, res) => {
  const { phone, password, nickname } = req.body;
  const phoneTrim = (phone || '').trim();
  const passwordTrim = (password || '').trim();

  if (!phoneTrim) return res.json({ success: false, message: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phoneTrim)) return res.json({ success: false, message: '请输入正确的11位手机号' });
  if (!passwordTrim || passwordTrim.length < 4) return res.json({ success: false, message: '密码至少4位' });

  try {
    const { data: existing } = await supabase.from('users').select('id').eq('phone', phoneTrim).maybeSingle();
    if (existing) return res.json({ success: false, message: '该手机号已被注册' });

    const finalUsername = '用户' + phoneTrim.slice(-4);
    const passwordHash = bcrypt.hashSync(passwordTrim, 10);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{ username: finalUsername, phone: phoneTrim, password_hash: passwordHash, nickname: (nickname || finalUsername).trim() }])
      .select()
      .single();

    if (error) throw error;

    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.nickname = newUser.nickname;
    req.session.phone = newUser.phone;
    return res.json({ success: true, user: { id: newUser.id, username: newUser.username, nickname: newUser.nickname, phone: newUser.phone } });
  } catch (e) {
    return res.json({ success: false, message: '注册失败: ' + e.message });
  }
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ success: false, message: '未登录' });
  try {
    const { data: user, error } = await supabase.from('users').select('id, username, nickname, phone').eq('id', req.session.userId).single();
    if (error || !user) return res.json({ success: false, message: '用户不存在' });
    return res.json({ success: true, user });
  } catch (e) {
    return res.json({ success: false, message: '查询失败' });
  }
});

// ===================================================================
// 原生 APP JSON API
// ===================================================================

// 播客列表（支持搜索、标签、排序）
app.get('/api/podcasts', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const tag = (req.query.tag || '').trim();
    const sort = req.query.sort || 'recent'; // recent | hot

    let query = supabase.from('episodes').select('*').eq('status', 1);

    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    }

    const { data: podcasts, error } = await query;
    if (error) throw error;

    let result = (podcasts || []).map(p => ({
      id: p.id,
      uuid: p.uuid,
      title: p.title,
      description: p.description || '',
      filename: p.filename,
      original_name: p.original_name,
      file_size: p.file_size,
      duration: p.duration || '',
      uploader_name: p.uploader_name,
      play_count: p.play_count || 0,
      created_at: p.created_at,
      audio_url: `${SUPABASE_URL}/storage/v1/object/public/audio/${p.filename}`,
      cover_url: null, // 后续可扩展封面
      custom_tags: p.custom_tags || []  // 用户自定义标签
    }));

    // 标签过滤（支持系统标签 + 自定义标签）
    if (tag) {
      result = result.filter(p =>
        (p.title || '').includes(tag) ||
        (p.description || '').includes(tag) ||
        (p.custom_tags || []).some(t => t === tag)
      );
    }

    // 排序
    if (sort === 'hot') {
      result.sort((a, b) => (b.play_count || 0) - (a.play_count || 0));
    } else {
      result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    res.json({ success: true, podcasts: result, total: result.length });
  } catch (e) {
    console.error('API播客列表错误:', e.message);
    res.json({ success: false, message: e.message, podcasts: [] });
  }
});

// 热门排行
app.get('/api/podcasts/hot', async (req, res) => {
  try {
    const { data: podcasts, error } = await supabase
      .from('episodes').select('*').eq('status', 1);
    if (error) throw error;
    const hot = (podcasts || [])
      .sort((a, b) => (b.play_count || 0) - (a.play_count || 0))
      .slice(0, 5)
      .map(p => ({
        uuid: p.uuid, title: p.title, uploader_name: p.uploader_name,
        play_count: p.play_count || 0, created_at: p.created_at
      }));
    res.json({ success: true, hot });
  } catch (e) {
    res.json({ success: false, message: e.message, hot: [] });
  }
});

// 最近更新
app.get('/api/podcasts/recent', async (req, res) => {
  try {
    const { data: podcasts, error } = await supabase
      .from('episodes').select('*').eq('status', 1)
      .order('created_at', { ascending: false }).limit(5);
    if (error) throw error;
    const recent = (podcasts || []).map(p => ({
      uuid: p.uuid, title: p.title, uploader_name: p.uploader_name, created_at: p.created_at
    }));
    res.json({ success: true, recent });
  } catch (e) {
    res.json({ success: false, message: e.message, recent: [] });
  }
});

// 单条播客详情
app.get('/api/podcasts/:uuid', async (req, res) => {
  try {
    const { data: podcast, error } = await supabase
      .from('episodes').select('*').eq('uuid', req.params.uuid).eq('status', 1).single();
    if (error || !podcast) return res.json({ success: false, message: '未找到' });

    // 增加播放计数
    await supabase.from('episodes').update({ play_count: (podcast.play_count || 0) + 1 }).eq('uuid', req.params.uuid);

    res.json({
      success: true,
      podcast: {
        id: podcast.id, uuid: podcast.uuid,
        title: podcast.title, description: podcast.description || '',
        filename: podcast.filename, original_name: podcast.original_name,
        file_size: podcast.file_size, duration: podcast.duration || '',
        uploader_name: podcast.uploader_name, play_count: (podcast.play_count || 0) + 1,
        created_at: podcast.created_at,
        audio_url: `${SUPABASE_URL}/storage/v1/object/public/audio/${podcast.filename}`,
        custom_tags: podcast.custom_tags || []
      }
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// 标签列表（系统标签 + 所有用户自定义标签）
app.get('/api/tags', async (req, res) => {
  try {
    const { data: episodes } = await supabase.from('episodes').select('custom_tags').eq('status', 1);
    const customTags = [...new Set((episodes || []).flatMap(e => e.custom_tags || []))];
    const allTags = [...new Set([...TAG_KEYWORDS, ...customTags])];
    res.json({ success: true, tags: allTags, system_tags: TAG_KEYWORDS, custom_tags: customTags });
  } catch (e) {
    res.json({ success: true, tags: TAG_KEYWORDS, system_tags: TAG_KEYWORDS, custom_tags: [] });
  }
});

// 自定义标签更新（需要登录）
app.put('/api/podcasts/:uuid/tags', async (req, res) => {
  if (!req.session.userId) return res.json({ success: false, message: '请先登录' });
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.json({ success: false, message: 'tags 必须是数组' });

    // 过滤空值和重复
    const cleanTags = [...new Set(tags.map(t => String(t).trim()).filter(t => t.length > 0))];

    const { error } = await supabase
      .from('episodes')
      .update({ custom_tags: cleanTags })
      .eq('uuid', req.params.uuid);

    if (error) throw error;
    res.json({ success: true, custom_tags: cleanTags });
  } catch (e) {
    console.error('更新标签失败:', e.message);
    res.json({ success: false, message: e.message });
  }
});

// 热门创作者
app.get('/api/creators', async (req, res) => {
  try {
    const { data: podcasts, error } = await supabase.from('episodes').select('uploader_name').eq('status', 1);
    if (error) throw error;
    const count = {};
    (podcasts || []).forEach(p => { count[p.uploader_name] = (count[p.uploader_name] || 0) + 1; });
    const creators = Object.entries(count)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, cnt]) => ({ name, count: cnt }));
    res.json({ success: true, creators });
  } catch (e) {
    res.json({ success: false, message: e.message, creators: [] });
  }
});

// 公告（读数据库，实时受运营系统控制）
app.get('/api/announcements', async (req, res) => {
  res.json({ success: true, announcements: await getAnnouncements() });
});

// 站点统计
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.json({ success: false, message: e.message, stats: {} });
  }
});

// 登出 API
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 注册页面
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('register', { title: '注册 - 小伟播客' });
});

// 登录页面
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: '登录 - 小伟播客' });
});

// 登出
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ===================================================================
// 评论和打赏 API
// ===================================================================

// 获取某节目的评论列表
app.get('/api/episodes/:uuid/comments', async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('comments')
      .select('*')
      .eq('episode_uuid', req.params.uuid)
      .eq('status', 1)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, comments: comments || [] });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// 提交评论（需要登录）
app.post('/api/episodes/:uuid/comments', async (req, res) => {
  if (!req.session.userId) return res.json({ success: false, message: '请先登录再评论' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.json({ success: false, message: '评论内容不能为空' });
  if (content.length > 500) return res.json({ success: false, message: '评论内容不能超过500字' });
  try {
    const nickname = req.session.nickname || req.session.username || '匿名';
    const { data: comment, error } = await supabase
      .from('comments')
      .insert([{ episode_uuid: req.params.uuid, nickname: nickname.trim().slice(0, 20), content: content.trim(), status: 1 }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, comment });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// TTS 语音配音（合并自语音工坊）
// ===================================================================

const TTS_VOICE_MAP = {
  'tongtong':   { name: '晓晓 · 温柔女声',    edge: 'zh-CN-XiaoxiaoNeural' },
  'chuichui':   { name: '晓伊 · 活泼女声',    edge: 'zh-CN-XiaoyiNeural' },
  'xiaochen':   { name: '云希 · 青年男声',    edge: 'zh-CN-YunxiNeural' },
  'jam':        { name: '云健 · 磁性男声',    edge: 'zh-CN-YunjianNeural' },
  'yunyang':    { name: '云扬 · 阳光男声',    edge: 'zh-CN-YunyangNeural' },
  'yunxia':     { name: '云夏 · 沉稳男声',    edge: 'zh-CN-YunxiaNeural' },
};

// 配音页面
app.get('/tts', (req, res) => {
  renderWithLayout(req, res, 'tts', { title: '语音配音' });
});

// 获取音色列表
app.get('/api/tts-voices', (req, res) => {
  const list = Object.entries(TTS_VOICE_MAP).map(([id, v]) => ({ id, name: v.name }));
  res.json({ success: true, voices: list });
});

// Edge TTS 合成
app.post('/api/free-tts', async (req, res) => {
  try {
    const { text, voice, speed, volume, pitch } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '缺少 text 参数' });

    const v = TTS_VOICE_MAP[voice] || TTS_VOICE_MAP['tongtong'];
    const edgeVoice = v.edge;
    const rate = speed ? `+${Math.round((speed - 1) * 50)}%` : '+0%';
    const vol = volume != null ? `+${Math.round((volume - 5) * 5)}%` : '+0%';
    const pt = pitch != null ? `${pitch >= 0 ? '+' : ''}${pitch}Hz` : '+0Hz';

    console.log(`[TTS] voice=${voice}(${v.name}), text="${text.slice(0,30)}..."`);

    // 先尝试无前缀合成，若失败则回退到带 '。' 前缀（防首字被吞）
    let audioBuffer;
    let usedGoogle = false;

    for (const inputText of [text, '。' + text]) {
      try {
        const tts = new EdgeTTS(inputText, edgeVoice, { rate, volume: vol, pitch: pt });
        const result = await tts.synthesize();
        if (result && result.audio) {
          const buf = Buffer.from(await result.audio.arrayBuffer());
          if (buf && buf.length > 100) {
            audioBuffer = buf;
            break;
          }
        }
      } catch (e) {
        console.log(`[TTS] 重试: ${e.message}`);
      }
    }

    if (!audioBuffer) {
      // Edge TTS 失败，尝试 Google TTS 兜底（仅限短文本，仅1种音色）
      if (text.length <= 200) {
        try {
          console.log(`[TTS] EdgeTTS 失败，尝试 Google TTS 兜底...`);
          const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=zh-CN&client=tw-ob`;
          const resp = await fetch(url);
          if (resp.ok) {
            audioBuffer = Buffer.from(await resp.arrayBuffer());
            usedGoogle = true;
            console.log(`[TTS] Google TTS 成功: size=${audioBuffer.length}`);
          }
        } catch(e) {
          console.log(`[TTS] Google TTS 也失败: ${e.message}`);
        }
      }
    }

    if (!audioBuffer) {
      return res.status(500).json({ success: false, error: '当前服务器环境不支持中文语音合成，请使用本地版本 localhost:3000 体验全部音色' });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Voice-Name', encodeURIComponent(v.name));
    res.set('X-Text-Snippet', encodeURIComponent(text.slice(0, 50)));
    if (usedGoogle) res.set('X-TTS-Engine', 'google');
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================================================
// SEO 路由
// ===================================================================

const BASE_URL = 'https://xiaowei-podcast-production.up.railway.app';

function escXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /ops
Disallow: /api/
Sitemap: ${BASE_URL}/sitemap.xml
`);
});

// sitemap.xml
app.get('/sitemap.xml', async (req, res) => {
  try {
    const urls = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/tts', priority: '0.9', changefreq: 'weekly' },
      { loc: '/upload', priority: '0.8', changefreq: 'weekly' },
      { loc: '/audio-editor', priority: '0.8', changefreq: 'weekly' },
    ];

    // 动态获取所有播客节目页面
    if (supabase) {
      try {
        const { data: episodes } = await supabase
          .from('episodes')
          .select('uuid, updated_at')
          .eq('status', 'published')
          .order('updated_at', { ascending: false })
          .limit(5000);

        if (episodes) {
          episodes.forEach(ep => {
            urls.push({
              loc: `/play/${ep.uuid}`,
              priority: '0.7',
              changefreq: 'weekly',
              lastmod: ep.updated_at
            });
          });
        }
      } catch (e) {
        console.warn('[Sitemap] 获取播客列表失败:', e.message);
      }
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    urls.forEach(u => {
      xml += '  <url>\n';
      xml += `    <loc>${BASE_URL}${u.loc}</loc>\n`;
      if (u.lastmod) {
        const d = new Date(u.lastmod);
        xml += `    <lastmod>${d.toISOString().split('T')[0]}</lastmod>\n`;
      }
      xml += `    <changefreq>${u.changefreq}</changefreq>\n`;
      xml += `    <priority>${u.priority}</priority>\n`;
      xml += '  </url>\n';
    });

    xml += '</urlset>';
    res.type('application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[Sitemap] 生成失败:', err.message);
    res.status(500).send('Sitemap generation error');
  }
});

// RSS Feed（播客订阅）
app.get('/feed.xml', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
    const host = req.headers.host || 'localhost:' + PORT;
    const siteUrl = `${protocol}://${host}`;
    const now = new Date().toUTCString();

    let itemsXml = '';

    if (supabase) {
      try {
        const { data: episodes, error } = await supabase
          .from('episodes')
          .select('uuid, title, description, filename, file_size, play_count, created_at, updated_at')
          .eq('status', 1)
          .order('created_at', { ascending: false })
          .limit(100);

        if (episodes && !error) {
          episodes.forEach(ep => {
            const pubDate = new Date(ep.created_at || ep.updated_at).toUTCString();
            const epUrl = `${siteUrl}/play/${ep.uuid}`;
            const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/audio/${ep.filename}`;
            itemsXml += '    <item>\n';
            itemsXml += `      <title>${escXml(ep.title)}</title>\n`;
            itemsXml += `      <link>${epUrl}</link>\n`;
            itemsXml += `      <guid isPermaLink="true">${epUrl}</guid>\n`;
            itemsXml += `      <pubDate>${pubDate}</pubDate>\n`;
            itemsXml += `      <description>${escXml(ep.description || '')}</description>\n`;
            itemsXml += `      <enclosure url="${audioUrl}" length="${ep.file_size || 0}" type="audio/mpeg"/>\n`;
            itemsXml += '    </item>\n';
          });
        }
      } catch (e) {
        console.warn('[RSS] 获取播客列表失败:', e.message);
      }
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n';
    xml += '  <channel>\n';
    xml += `    <title>小伟播客</title>\n`;
    xml += `    <link>${siteUrl}</link>\n`;
    xml += `    <description>上传你的声音，分享你的故事。支持语音配音、音频编辑、在线播放。</description>\n`;
    xml += `    <language>zh-CN</language>\n`;
    xml += `    <lastBuildDate>${now}</lastBuildDate>\n`;
    xml += `    <generator>小伟播客</generator>\n`;
    xml += `    <itunes:author>小伟播客</itunes:author>\n`;
    xml += `    <itunes:category text="Podcasts"></itunes:category>\n`;
    xml += `    <itunes:explicit>no</itunes:explicit>\n`;
    xml += itemsXml;
    xml += '  </channel>\n';
    xml += '</rss>';

    res.type('application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[RSS] 生成失败:', err.message);
    res.status(500).send('RSS generation error');
  }
});

// ===================================================================
// 启动
// ===================================================================

console.log('='.repeat(55));
console.log('  🎙️ 小伟播客已启动！');
console.log(`  🌐 前台地址: http://localhost:${PORT}`);
console.log(`  🎤 语音配音: http://localhost:${PORT}/tts`);
console.log(`  📤 上传页面: http://localhost:${PORT}/upload`);
console.log(`  🛠️  运营系统: http://localhost:4000/ops/login`);
console.log('  👤 运营账号见 admins 表（默认 admin / admin123，请尽快修改）');
console.log('='.repeat(55));
app.listen(PORT, '0.0.0.0');
// force redeploy Sat Jun  6 03:20:23     2026
