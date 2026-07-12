// 小伟播客运营系统 · 守护进程
// 每30秒检查端口 4000，挂了自动重启 ops-server.js
const http = require('http');
const { spawn } = require('child_process');

const PORT = 4000;
const CHECK_INTERVAL = 30000;
const SERVER_JS = __dirname + '\\ops-server.js';
const NODE_EXE = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';

let serverProcess = null;
let checkTimer = null;

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:' + PORT, (res) => resolve(res.statusCode < 500));
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  if (serverProcess) { try { serverProcess.kill(); } catch (e) {} serverProcess = null; }
  console.log('[ops-watchdog] 启动运营系统...');
  serverProcess = spawn(NODE_EXE, [SERVER_JS], { cwd: __dirname, stdio: 'inherit', detached: false });
  serverProcess.on('exit', (code) => { console.log('[ops-watchdog] 运营系统进程退出, code=' + code); serverProcess = null; });
}

async function tick() {
  const alive = await checkServer();
  if (!alive) { console.log('[ops-watchdog] 未响应，正在重启...'); startServer(); }
  else console.log('[ops-watchdog] 运营系统正常');
}

console.log('[ops-watchdog] 守护进程已启动，每30秒检查一次 (端口 ' + PORT + ')');
tick();
checkTimer = setInterval(tick, CHECK_INTERVAL);

process.on('SIGINT', () => { clearInterval(checkTimer); if (serverProcess) serverProcess.kill(); process.exit(); });
process.on('SIGTERM', () => { clearInterval(checkTimer); if (serverProcess) serverProcess.kill(); process.exit(); });
