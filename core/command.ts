import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CommandInput, CommandResult } from '../shared/contracts';
import { SafeError } from './schema';

const OUTPUT_LIMIT = 65_536;

function redact(text: string, secrets: string[]): string {
  const values = secrets.flatMap((secret) => {
    const parts = [secret];
    try {
      const url = new URL(secret);
      if (url.username) parts.push(decodeURIComponent(url.username));
      if (url.password) parts.push(decodeURIComponent(url.password));
    } catch {
      /* Most secrets are not URLs. */
    }
    return parts.flatMap((part) => [
      part,
      encodeURIComponent(part),
      Buffer.from(part).toString('base64'),
      JSON.stringify(part).slice(1, -1),
    ]);
  });
  const patterns = [...new Set(values)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return patterns.length ? text.replace(new RegExp(patterns.join('|'), 'g'), '[REDACTED]') : text;
}

export type ExecuteCommand = typeof executeCommand;
/** Trusted programs only. A process group is cleanup, not an OS sandbox. */
export async function executeCommand(
  command: CommandInput,
  bindings: Record<string, string>,
  secrets: string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  if (signal.aborted) throw new SafeError('Command cancelled before launch.');
  // Never inherit the desktop's credentials, Electron flags or interpreter startup variables.
  const env: NodeJS.ProcessEnv = { ...bindings };
  if (process.platform === 'win32' && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure = '';
    let finished = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (): void => {
      if (!child.pid) return;
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      } else {
        // Best-effort descendant cleanup on Windows; not containment of hostile programs.
        if (process.env.SystemRoot) {
          const killer = spawn(
            join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/t', '/f'],
            { windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot } },
          );
          killer.on('error', () => {});
          killer.unref();
        }
        child.kill();
      }
    };
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener('abort', cancel);
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        if (failure) throw new SafeError(failure);
        const out = redact(Buffer.concat(stdout).toString('utf8'), secrets);
        const err = redact(Buffer.concat(stderr).toString('utf8'), secrets);
        if (Buffer.byteLength(out) + Buffer.byteLength(err) > OUTPUT_LIMIT)
          throw new SafeError(
            'Command output exceeded the limit after redaction. Output discarded; effects may have occurred.',
          );
        resolve({
          operation: command.name,
          exitCode,
          successful: exitCode === 0,
          stdout: out,
          stderr: err,
        });
      } catch (error) {
        reject(error);
      } finally {
        for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
      }
    };
    const stop = (message: string): void => {
      if (finished || failure) return;
      failure = message;
      kill();
      // Detached descendants may hold pipes open. Never wait indefinitely or return partial output.
      cleanupTimer = setTimeout(() => finish(null), 1000);
    };
    const cancel = (): void =>
      stop('Command cancelled. Effects may already have occurred; do not retry automatically.');
    const timer = setTimeout(
      () =>
        stop('Command timed out. Effects may already have occurred; do not retry automatically.'),
      command.timeoutMs,
    );
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (failure || finished) {
        chunk.fill(0);
        return;
      }
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        chunk.fill(0);
        stop(
          'Command output exceeded 64 KiB. Output discarded; effects may already have occurred.',
        );
      } else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', () =>
      stop(
        'Command could not run. Check the executable and working directory before requesting another approval.',
      ),
    );
    child.on('close', (code) => {
      kill();
      finish(code);
    });
  });
}
