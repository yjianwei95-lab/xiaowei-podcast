// 小伟播客本地服务器守护进程
// 每30秒检查一次端口3000，挂了自动重启
const http = require('http');
const { spawn } = require('child_process');

const PORT = 3000;
const CHECK_INTERVAL = 30000;
const SERVER_JS = __dirname + '\\server.js';
const NODE_EXE = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';

let serverProcess = null;
let checkTimer = null;

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:' + PORT, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  if (serverProcess) {
    try { serverProcess.kill(); } catch(e) {}
    serverProcess = null;
  }
  console.log('[watchdog] 启动服务器...');
  serverProcess = spawn(NODE_EXE, [SERVER_JS], {
    cwd: __dirname,
    stdio: 'inherit',
    detached: false
  });
  serverProcess.on('exit', (code) => {
    console.log('[watchdog] 服务器进程退出, code=' + code);
    serverProcess = null;
  });
}

async function tick() {
  const alive = await checkServer();
  if (!alive) {
    console.log('[watchdog] 服务器未响应，正在重启...');
    startServer();
  } else {
    console.log('[watchdog] 服务器正常');
  }
}

console.log('[watchdog] 守护进程已启动，每30秒检查一次');
tick();
checkTimer = setInterval(tick, CHECK_INTERVAL);

// 优雅退出
process.on('SIGINT', () => {
  clearInterval(checkTimer);
  if (serverProcess) serverProcess.kill();
  process.exit();
});
process.on('SIGTERM', () => {
  clearInterval(checkTimer);
  if (serverProcess) serverProcess.kill();
  process.exit();
});
