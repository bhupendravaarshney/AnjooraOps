import { spawn } from 'child_process';
import { createRequire } from 'module';
import './load-env.mjs';
import './validate-env.mjs';

const require = createRequire(import.meta.url);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

await run(process.execPath, ['scripts/migrate.mjs']);
await run(process.execPath, ['scripts/bootstrap.mjs']);
const port = process.env.PORT || '3000';
const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, 'start', '-p', port], { stdio: 'inherit' });
child.on('error', (error) => {
  console.error('Failed to start Next.js:', error);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
