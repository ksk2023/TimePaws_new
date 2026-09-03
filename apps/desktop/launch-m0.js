// M0 launch helper: spawn electron.exe directly (bypass cli.js spawn indirection)
// Usage: node launch-m0.js [--no-gpu]
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const base = __dirname;
const electronExe = require(path.join(base, 'node_modules', 'electron'));
const logPath = path.join(base, 'electron-m0.log');

const useNoGpu = process.argv.includes('--no-gpu');
const args = [base];
if (useNoGpu) args.unshift('--disable-gpu');

const child = spawn(electronExe, args, {
  cwd: base,
  env: (() => {
    // WorkBuddy 宿主注入的变量会让 electron.exe 退化为纯 Node 模式，必须剔除
    const env = { ...process.env, NODE_OPTIONS: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    delete env.CHROME_CRASHPAD_PIPE_NAME;
    return env;
  })(),
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const log = fs.createWriteStream(logPath);
child.stdout.pipe(log);
child.stderr.pipe(log);
child.on('exit', (code) => {
  fs.appendFileSync(logPath, `\n[exited code=${code}]\n`);
});
child.unref();
console.log('electron spawned pid=', child.pid, electronExe, useNoGpu ? '(--disable-gpu)' : '');
