import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';

try {
  if (process.getuid() === 0) throw new Error();
  const status = readFileSync('/proc/self/status', 'utf8');
  if (
    !/^CapEff:\s+0+$/m.test(status) ||
    !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status)
  )
    throw new Error();
  if (
    Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry && !entry.internal)
  )
    throw new Error();
  let writable = false;
  try {
    writeFileSync('/app/should-not-be-writable', 'test');
    writable = true;
  } catch {}
  if (writable) throw new Error();
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const timeout = setTimeout(() => reject(new Error()), 3000);
    child.on('error', () => {
      clearTimeout(timeout);
      reject(new Error());
    });
    child.once('message', () => {
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        reject(new Error());
      }
    });
    child.once('exit', (_code, signal) => {
      clearTimeout(timeout);
      signal === 'SIGTERM' ? resolve() : reject(new Error());
    });
  });
  process.stdout.write('agentkey-isolation-ready\n');
  process.exit(0);
} catch {
  process.stderr.write(
    'Isolation preflight failed. Check Docker seccomp, capabilities, networking and intra-container signal permissions; do not disable host security to bypass this check.\n',
  );
  process.exit(1);
}
