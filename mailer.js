// mailer.js - 基于 QQ 邮箱 SMTP 的邮件发送模块
// 所有敏感配置从环境变量读取，切勿硬编码到代码中。
// 需要的环境变量：
//   QQ_EMAIL      - 发信的 QQ 邮箱（如 123456@qq.com）
//   QQ_AUTH_CODE  - QQ 邮箱「授权码」（在邮箱设置→账户→开启SMTP服务后获取，不是QQ密码）
const nodemailer = require('nodemailer');

let transporterCache = null;

function getTransporter() {
  if (transporterCache) return transporterCache;

  const user = process.env.QQ_EMAIL;
  const pass = process.env.QQ_AUTH_CODE;

  if (!user || !pass) {
    console.warn('[Mailer] 未配置 QQ_EMAIL / QQ_AUTH_CODE，邮件发送不可用（注册验证邮件将无法发出）');
    return null;
  }

  transporterCache = nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true, // SSL
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });

  return transporterCache;
}

// 发送「邮箱激活」邮件
// toEmail  : 收件人邮箱
// verifyUrl: 完整的激活链接（由调用方根据当前域名拼接）
async function sendVerificationEmail(toEmail, verifyUrl) {
  const t = getTransporter();
  if (!t) throw new Error('邮件服务未配置（缺少 QQ_EMAIL / QQ_AUTH_CODE）');

  const mailOptions = {
    from: `小伟播客 <${process.env.QQ_EMAIL}>`,
    to: toEmail,
    subject: '【小伟播客】请激活你的邮箱',
    text: `你好！\n\n欢迎注册小伟播客。请点击下面的链接完成邮箱激活：\n${verifyUrl}\n\n如果这不是你本人的操作，请忽略此邮件。\n链接 24 小时内有效。`,
    html: `
      <div style="max-width:480px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
        <h2 style="margin-bottom:8px;">欢迎注册小伟播客 🎙️</h2>
        <p style="color:#4b5563;line-height:1.6;">请点击下面的按钮完成邮箱激活，激活后即可登录并投稿。</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${verifyUrl}" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;display:inline-block;">激活我的邮箱</a>
        </p>
        <p style="color:#9ca3af;font-size:13px;line-height:1.6;">如果按钮无法点击，请复制以下链接到浏览器打开：<br><a href="${verifyUrl}" style="color:#6366f1;word-break:break-all;">${verifyUrl}</a></p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">链接 24 小时内有效。若非本人注册，请忽略此邮件。</p>
      </div>`
  };

  return t.sendMail(mailOptions);
}

module.exports = { getTransporter, sendVerificationEmail };
