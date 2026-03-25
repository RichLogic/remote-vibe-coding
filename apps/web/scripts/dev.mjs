import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const inputArgs = process.argv.slice(2);
const viteArgs = [];

let apiPort = process.env.RVC_API_PORT?.trim() || process.env.npm_config_api_port?.trim() || '';

for (let index = 0; index < inputArgs.length; index += 1) {
  const arg = inputArgs[index];

  if (arg === '--api-port') {
    apiPort = inputArgs[index + 1]?.trim() || '';
    index += 1;
    continue;
  }

  if (arg.startsWith('--api-port=')) {
    apiPort = arg.slice('--api-port='.length).trim();
    continue;
  }

  viteArgs.push(arg);
}

if (apiPort && !/^\d+$/.test(apiPort)) {
  console.error(`Invalid --api-port value: ${apiPort}`);
  process.exit(1);
}

const viteBinPath = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));
const child = spawn(process.execPath, [viteBinPath, ...viteArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(apiPort ? { RVC_API_PORT: apiPort } : {}),
  },
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
