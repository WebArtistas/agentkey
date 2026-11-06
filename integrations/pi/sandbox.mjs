import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const sandboxImage = 'agentkey-pi:0.1.0';
const descriptorSchema = z.strictObject({
  version: z.literal(1),
  endpoint: z.string().max(100),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export function validateBrokerDirectory(input) {
  const directory = resolve(input);
  if (/[\r\n,]/.test(directory) || realpathSync(directory) !== directory)
    throw new Error('Invalid broker directory.');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw new Error('Broker directory must be private and owned by you.');
  const readPrivate = (name) => {
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > 4096
    )
      throw new Error('Invalid broker descriptor.');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const marker = z
    .strictObject({ version: z.literal(1), scope: z.literal('database-only') })
    .parse(readPrivate('sandbox.json'));
  const descriptor = descriptorSchema.parse(readPrivate('agent-connection.json'));
  if (
    marker.scope !== 'database-only' ||
    dirname(descriptor.endpoint) !== directory ||
    !/^[a-f0-9]{16}\.sock$/.test(basename(descriptor.endpoint))
  )
    throw new Error('Not an isolated database broker.');
  const socket = lstatSync(descriptor.endpoint);
  if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0)
    throw new Error('Invalid broker socket.');
  const expected = ['sandbox.json', 'agent-connection.json', basename(descriptor.endpoint)].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected))
    throw new Error(
      'Refusing to mount a directory containing anything except the database broker.',
    );
  return directory;
}
export function validateRelayDirectory(input) {
  const directory = resolve(input);
  const stat = lstatSync(directory);
  if (
    /[\r\n,]/.test(directory) ||
    realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Invalid private inference directory.');
  const path = join(directory, 'relay.json');
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.uid !== process.getuid() ||
    (file.mode & 0o077) !== 0 ||
    file.size > 4096
  )
    throw new Error('Invalid inference descriptor.');
  const descriptor = descriptorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (descriptor.endpoint !== join(directory, 'inference.sock'))
    throw new Error('Invalid inference endpoint.');
  const socket = lstatSync(descriptor.endpoint);
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid() ||
    (socket.mode & 0o077) !== 0 ||
    JSON.stringify(readdirSync(directory).sort()) !==
      JSON.stringify(['inference.sock', 'relay.json'])
  )
    throw new Error('Refusing unexpected inference-directory contents.');
  return directory;
}
export function dockerArguments(name, directories = []) {
  if (process.platform !== 'linux' || !process.getuid?.())
    throw new Error('Isolated mode requires non-root Linux and local Docker Engine.');
  for (const path of directories)
    if (!path.startsWith('/') || /[\r\n,]/.test(path)) throw new Error('Invalid mount path.');
  return [
    'run',
    '--rm',
    '--init',
    '--interactive',
    '--pull',
    'never',
    '--name',
    name,
    '--log-driver',
    'none',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--pids-limit',
    '64',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--workdir',
    '/app',
    '--env',
    'HOME=/tmp/agentkey-pi',
    ...directories.flatMap((path) => [
      '--mount',
      `type=bind,source=${path},target=${path},readonly`,
    ]),
    '--entrypoint',
    'node',
    sandboxImage,
  ];
}
export function checkLocalDocker() {
  if (process.platform !== 'linux' || !process.getuid?.())
    throw new Error('Isolated mode requires non-root Linux.');
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))
    throw new Error('Remote Docker endpoints are not supported.');
  const context = JSON.parse(
    execFileSync('docker', ['context', 'inspect'], { encoding: 'utf8', timeout: 10_000 }),
  );
  if (!context[0]?.Endpoints?.docker?.Host?.startsWith('unix://'))
    throw new Error('Use a local Unix-socket Docker Engine context.');
  const endpoint = process.env.DOCKER_HOST || context[0].Endpoints.docker.Host;
  const env = { ...process.env };
  delete env.DOCKER_CONTEXT;
  const info = JSON.parse(
    execFileSync('docker', ['--host', endpoint, 'info', '--format', '{{json .}}'], {
      encoding: 'utf8',
      timeout: 10_000,
      env,
    }),
  );
  if (
    info.OSType !== 'linux' ||
    /Docker Desktop/i.test(info.OperatingSystem) ||
    info.SecurityOptions?.some((option) => option === 'name=rootless' || option === 'name=userns')
  )
    throw new Error(
      'This release supports native Linux Docker Engine without UID remapping. Do not weaken another Docker configuration to bypass this limit.',
    );
  return endpoint;
}
export async function dockerProcess(args, input, { timeoutMs = 190_000 } = {}) {
  const name = args[args.indexOf('--name') + 1];
  if (!/^agentkey-(?:pi|probe|test)-[a-f0-9-]{36}$/.test(name))
    throw new Error('Invalid owned-container name.');
  const endpoint = checkLocalDocker();
  const env = { ...process.env };
  delete env.DOCKER_CONTEXT;
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['--host', endpoint, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const remove = () => {
      const cleanup = spawn('docker', ['--host', endpoint, 'rm', '--force', name], {
        stdio: 'ignore',
        timeout: 10_000,
        env,
      });
      cleanup.on('error', () => {});
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      if (error) {
        child.kill('SIGTERM');
        remove();
        reject(error);
      } else resolvePromise(value);
    };
    const interrupt = () => finish(new Error('Isolated run interrupted.'));
    const timer = setTimeout(
      () => finish(new Error('Isolated run exceeded its time limit.')),
      timeoutMs,
    );
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', () => finish(new Error('Docker could not launch the isolated runner.')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > 512 * 1024) finish(new Error('Isolated output limit exceeded.'));
    });
    child.stderr.on('data', (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 64 * 1024) finish(new Error('Isolated error-output limit exceeded.'));
    });
    child.once('close', (code) => {
      if (code !== 0)
        finish(
          new Error(
            'Isolated process failed. Check approvals and Docker/AppArmor compatibility. No raw process output was returned.',
          ),
        );
      else finish(null, stdout.toString('utf8'));
    });
    child.stdin.end(input);
  });
}
export async function preflight() {
  checkLocalDocker();
  const args = [
    ...dockerArguments(`agentkey-probe-${randomUUID()}`),
    '/app/integrations/pi/probe.mjs',
  ];
  const output = await dockerProcess(args, '', { timeoutMs: 20_000 });
  if (output.trim() !== 'agentkey-isolation-ready')
    throw new Error('Isolation preflight did not pass.');
}
export async function launchSandbox({ brokerDirectory, relayDirectory, prompt }) {
  const directory = validateBrokerDirectory(brokerDirectory);
  const inference = validateRelayDirectory(relayDirectory);
  const name = `agentkey-pi-${randomUUID()}`;
  const args = [
    ...dockerArguments(name, [directory, inference]),
    '/app/integrations/pi/runner.mjs',
  ];
  const output = await dockerProcess(
    args,
    JSON.stringify({ brokerDirectory: directory, relayDirectory: inference, prompt }),
  );
  return z
    .strictObject({
      answer: z.string().max(100_000),
      tools: z.array(z.string()).max(32),
      availableTools: z.array(z.string()).length(4),
    })
    .parse(JSON.parse(output));
}
