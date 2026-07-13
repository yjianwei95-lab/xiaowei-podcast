// 一键拉起 前台(server.js :3000) + 运营后台(ops-server.js :4000)
// 任一进程崩溃自动重启；Ctrl+C 同时退出两个。
const { spawn } = require('child_process');
const path = require('path');

const procs = [
  { name: 'server', file: 'server.js' },
  { name: 'ops', file: 'ops-server.js' },
];

const children = {};

function start(p) {
  const child = spawn(process.execPath, [path.join(__dirname, p.file)], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  });
  children[p.name] = child;
  console.log(`[start-all] 启动 ${p.name} (${p.file}) pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    if (signal === 'SIGTERM') return; // 主动关闭，不再重启
    console.log(`[start-all] ${p.name} 退出 code=${code} signal=${signal}，3秒后重启…`);
    setTimeout(() => start(p), 3000);
  });
}

procs.forEach(start);

function shutdown() {
  Object.values(children).forEach((c) => { try { c.kill('SIGTERM'); } catch (e) {} });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
