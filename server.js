const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase 配置（密钥从环境变量读取，不在代码中硬编码）
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// 优先使用 service_role key（后端需要写入权限），没有则用 anon key
const supabaseKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, supabaseKey, {
  realtime: {
    transport: ws
  }
});

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

// ===================================================================
// 工具函数
// ===================================================================

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
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
  if (!req.session.loggedIn) return res.redirect('/admin/login');
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

// ===================================================================
// Express 中间件
// ===================================================================

const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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
// 音频文件：从 Supabase Storage 读取（/uploads/:filename 路由在下方定义）
app.use(session({ secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false, cookie: { maxAge: 24 * 60 * 60 * 1000 } }));
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
    renderWithLayout(req, res, 'index', { podcasts: podcasts || [], stats, title: '小伟播客' });
  } catch (e) {
    console.error('【首页错误】', e.message, e);
    renderWithLayout(req, res, 'index', { podcasts: [], stats: { totalPodcasts:0, totalPlayed:0, totalVisitors:0, todayVisitors:0, totalSize:0 }, title: '小伟播客' });
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

    // 记录访客
    await supabase
      .from('visitors')
      .insert([{
        episode_uuid: req.params.uuid,
        ip: getClientIP(req),
        user_agent: req.headers['user-agent'] || '',
        referer: req.headers['referer'] || ''
      }]);

    renderWithLayout(req, res, 'player', { podcast, audioUrl, title: podcast.title, req });
  } catch (e) {
    console.error('播放页面错误:', e.message);
    renderWithLayout(req, res, '404', { title: '未找到' });
  }
});

// 上传页面
app.get('/upload', (req, res) => renderWithLayout(req, res, 'upload', { title: '上传声音' }));

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

  if (!phone) return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '请输入手机号' } });
  if (!/^1[3-9]\d{9}$/.test(phone)) return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '请输入正确的11位手机号' }, phone });
  if (!password) return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '请输入密码' }, phone });

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (error || !user) return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '该手机号未注册，请先注册' }, phone });

    let passwordValid = bcrypt.compareSync(password, user.password_hash);
    if (!passwordValid) return renderWithLayout(req, res, 'auth/phone-login', { title: '手机号登录', flash: { category: 'error', message: '密码错误' }, phone });

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.nickname = user.nickname || user.username;
    req.session.phone = user.phone || '';
    return res.redirect('/');
  } catch (e) {
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
  if (!identifier) return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '请输入手机号或用户名' } });

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .or(`username.eq.${identifier},phone.eq.${identifier}`)
      .single();

    if (error || !user) return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '账号不存在' } });

    let passwordValid = bcrypt.compareSync(req.body.password, user.password_hash);
    if (!passwordValid) return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '密码错误' } });

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.nickname = user.nickname || user.username;
    req.session.phone = user.phone || '';
    return res.redirect('/');
  } catch (e) {
    return renderWithLayout(req, res, 'auth/login', { title: '登录', flash: { category: 'error', message: '登录失败' } });
  }
});

// 注册
app.get('/register', (req, res) => renderWithLayout(req, res, 'auth/register', { title: '注册' }));

app.post('/register', async (req, res) => {
  const { username, phone, password, nickname } = req.body;
  const usernameTrim = (username || '').trim();
  const phoneTrim = (phone || '').trim();

  if (!usernameTrim && !phoneTrim) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '请填写手机号或用户名' } });
  if (phoneTrim && !/^1[3-9]\d{9}$/.test(phoneTrim)) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '请输入正确的11位手机号' } });
  if (usernameTrim && usernameTrim.length < 2) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '用户名至少2个字符' } });
  if (!password || password.length < 4) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '密码至少4位' } });

  try {
    // 检查是否已注册
    if (phoneTrim) {
      const { data: existingPhone } = await supabase.from('users').select('id').eq('phone', phoneTrim).maybeSingle();
      if (existingPhone) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '该手机号已被注册' } });
    }
    if (usernameTrim) {
      const { data: existingUser } = await supabase.from('users').select('id').eq('username', usernameTrim).maybeSingle();
      if (existingUser) return renderWithLayout(req, res, 'auth/register', { title: '注册', flash: { category: 'error', message: '该用户名已被注册' } });
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
    return res.redirect('/');
  } catch (e) {
    console.error('注册错误:', e.message);
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
// 后台管理
// ===================================================================

app.get('/admin/login', (req, res) => req.session.loggedIn ? res.redirect('/admin') : res.render('admin/login', { flash: null }));

app.post('/admin/login', async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('admins')
      .select('*')
      .eq('username', req.body.username)
      .eq('password', req.body.password)
      .single();

    if (user) {
      req.session.loggedIn = true;
      req.session.isAdmin = true;
      req.session.username = req.body.username;
      return res.redirect('/admin');
    }
    res.render('admin/login', { flash: { category: 'error', message: '用户名或密码错误' } });
  } catch (e) {
    res.render('admin/login', { flash: { category: 'error', message: '登录失败' } });
  }
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// 后台总览
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const stats = await getStats();

    const { data: recentPodcasts } = await supabase
      .from('episodes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    const { data: recentVisitors } = await supabase
      .from('visitors')
      .select('*')
      .order('visited_at', { ascending: false })
      .limit(10);

    // 补充节目标题
    const { data: allEpisodes } = await supabase.from('episodes').select('uuid, title');
    const episodeTitleMap = {};
    (allEpisodes || []).forEach(ep => episodeTitleMap[ep.uuid] = ep.title);

    const visitorsWithTitle = (recentVisitors || []).map(v => ({
      ...v,
      podcast_title: episodeTitleMap[v.episode_uuid] || ''
    }));

    renderWithLayout(req, res, 'admin/dashboard', { stats, recentPodcasts: recentPodcasts || [], recentVisitors: visitorsWithTitle, title: '后台总览' });
  } catch (e) {
    console.error('后台总览错误:', e.message);
    renderWithLayout(req, res, 'admin/dashboard', { stats: { totalPodcasts:0, totalPlayed:0, totalVisitors:0, todayVisitors:0, totalSize:0 }, recentPodcasts: [], recentVisitors: [], title: '后台总览' });
  }
});

// 播客管理
app.get('/admin/podcasts', requireAdmin, async (req, res) => {
  try {
    const { data: podcasts, error } = await supabase
      .from('episodes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    renderWithLayout(req, res, 'admin/podcasts', { podcasts: podcasts || [], title: '播客管理' });
  } catch (e) {
    renderWithLayout(req, res, 'admin/podcasts', { podcasts: [], title: '播客管理' });
  }
});

// 切换状态（显示/隐藏）
app.post('/admin/toggle/:id', requireAdmin, async (req, res) => {
  try {
    const { data: episode } = await supabase.from('episodes').select('status').eq('id', req.params.id).single();
    if (episode) {
      await supabase.from('episodes').update({ status: episode.status ? 0 : 1 }).eq('id', req.params.id);
    }
  } catch (e) { console.error('toggle error:', e.message); }
  res.redirect('/admin/podcasts');
});

// 删除节目
app.post('/admin/delete/:id', requireAdmin, async (req, res) => {
  try {
    const { data: episode } = await supabase.from('episodes').select('uuid, filename').eq('id', req.params.id).single();
    if (episode) {
      // 删除 Storage 中的音频文件
      await supabase.storage.from('audio').remove([`${episode.filename}`]);
      // 删除本地文件（如果存在）
      const localPath = path.join(UPLOAD_DIR, episode.filename);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      // 删除访客记录
      await supabase.from('visitors').delete().eq('episode_uuid', episode.uuid);
      // 删除节目记录
      await supabase.from('episodes').delete().eq('id', req.params.id);
    }
  } catch (e) { console.error('delete error:', e.message); }
  res.redirect('/admin/podcasts');
});

// 编辑节目
app.get('/admin/edit/:id', requireAdmin, async (req, res) => {
  try {
    const { data: podcast, error } = await supabase.from('episodes').select('*').eq('id', req.params.id).single();
    if (error || !podcast) return res.redirect('/admin/podcasts');
    renderWithLayout(req, res, 'admin/edit', { podcast, title: '编辑播客' });
  } catch (e) {
    res.redirect('/admin/podcasts');
  }
});

app.post('/admin/edit/:id', requireAdmin, async (req, res) => {
  try {
    await supabase.from('episodes').update({
      title: req.body.title,
      uploader_name: req.body.uploader_name,
      uploader_email: req.body.uploader_email,
      description: req.body.description || ''
    }).eq('id', req.params.id);
  } catch (e) { console.error('edit error:', e.message); }
  res.redirect('/admin/podcasts');
});

// 替换音频
app.post('/admin/replace-audio/:id', requireAdmin, (req, res) => {
  upload.single('audio')(req, res, async (err) => {
    if (err || !req.file) return res.redirect('/admin/edit/' + req.params.id);
    try {
      const { data: episode } = await supabase.from('episodes').select('filename, uuid').eq('id', req.params.id).single();
      if (episode) {
        // 删除旧文件
        await supabase.storage.from('audio').remove([`${episode.filename}`]);
        const oldLocal = path.join(UPLOAD_DIR, episode.filename);
        if (fs.existsSync(oldLocal)) fs.unlinkSync(oldLocal);

        // 上传新文件（使用正确的 Content-Type）
        const fileBuffer = fs.readFileSync(req.file.path);
        const replaceExt = req.file.originalname.split('.').pop().toLowerCase();
        const replaceContentType = AUDIO_CONTENT_TYPES[replaceExt] || 'audio/mpeg';
        await supabase.storage.from('audio').upload(`${req.file.filename}`, fileBuffer, { contentType: replaceContentType });
        fs.unlinkSync(req.file.path);

        // 更新数据库
        await supabase.from('episodes').update({
          filename: req.file.filename,
          original_name: req.file.originalname,
          file_size: req.file.size,
          created_at: localNow()
        }).eq('id', req.params.id);
      }
    } catch (e) { console.error('replace audio error:', e.message); }
    res.redirect('/admin/edit/' + req.params.id);
  });
});

// 访客记录
app.get('/admin/visitors', requireAdmin, async (req, res) => {
  try {
    const { data: visitors, error } = await supabase
      .from('visitors')
      .select('*')
      .order('visited_at', { ascending: false });

    const { data: episodes } = await supabase.from('episodes').select('uuid, title');
    const episodeMap = {};
    (episodes || []).forEach(ep => episodeMap[ep.uuid] = ep.title);

    const visitorsWithInfo = (visitors || []).map(v => ({
      ...v,
      podcast_title: episodeMap[v.episode_uuid] || '',
      uploader_name: episodeMap[v.episode_uuid] || ''
    }));

    const byPodcast = (episodes || []).map(ep => ({
      uuid: ep.uuid,
      title: ep.title,
      visits: (visitors || []).filter(v => v.episode_uuid === ep.uuid).length,
      last_visit: (visitors || []).filter(v => v.episode_uuid === ep.uuid).pop()?.visited_at
    })).sort((a, b) => b.visits - a.visits);

    renderWithLayout(req, res, 'admin/visitors', { visitors: visitorsWithInfo, byPodcast, title: '访客记录' });
  } catch (e) {
    console.error('visitors error:', e.message);
    renderWithLayout(req, res, 'admin/visitors', { visitors: [], byPodcast: [], title: '访客记录' });
  }
});

// 修改管理员密码
app.get('/admin/password', requireAdmin, (req, res) => renderWithLayout(req, res, 'admin/password', { title: '修改密码' }));

app.post('/admin/password', requireAdmin, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('admins')
      .select('*')
      .eq('username', req.session.username)
      .eq('password', req.body.old_password)
      .single();

    if (user) {
      await supabase.from('admins').update({ password: req.body.new_password }).eq('username', req.session.username);
      res.redirect('/admin');
    } else {
      renderWithLayout(req, res, 'admin/password', { flash: { category: 'error', message: '原密码错误' } });
    }
  } catch (e) {
    renderWithLayout(req, res, 'admin/password', { flash: { category: 'error', message: '修改失败' } });
  }
});

// ===================================================================
// 启动
// ===================================================================

console.log('='.repeat(55));
console.log('  🎙️ 小伟播客已启动！');
console.log(`  🌐 前台地址: http://localhost:${PORT}`);
console.log(`  📤 上传页面: http://localhost:${PORT}/upload`);
console.log(`  🔐 后台地址: http://localhost:${PORT}/admin/login`);
console.log('  👤 默认账号: admin');
console.log('  🔑 默认密码: admin123');
console.log('  ⚠️  首次登录后请尽快修改密码！');
console.log('='.repeat(55));
app.listen(PORT, '0.0.0.0');
// force redeploy Sat Jun  6 03:20:23     2026
