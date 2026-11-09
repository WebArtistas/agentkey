import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const piCli = fileURLToPath(
  new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')),
);
const adapter = fileURLToPath(new URL('../../dist/agent/cli.js', import.meta.url));

test('native Pi discovers globally configured AgentKey from unrelated projects while the vault is closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ak-pi-mcp-'));
  try {
    const profile = join(root, 'profile');
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(
      join(profile, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          agentkey: {
            command: process.execPath,
            args: [adapter, 'mcp', '--data-dir', join(root, 'closed-vault')],
            enabled: true,
            exposure: 'deferred',
          },
        },
      }),
      { mode: 0o600 },
    );
    const env = { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: profile };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    for (const name of ['first-project', 'second-project']) {
      const cwd = join(root, name);
      mkdirSync(cwd, { mode: 0o700 });
      const { stdout } = await execute(process.execPath, [piCli, 'mcp', 'list', '--json'], {
        cwd,
        env,
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      });
      const result = JSON.parse(stdout);
      assert.deepEqual(result.errors, []);
      assert.equal(result.servers.length, 1);
      const server = result.servers[0];
      assert.equal(server.name, 'agentkey');
      assert.equal(server.scope, 'global');
      assert.equal(server.state, 'connected');
      assert.equal(server.exposure, 'deferred');
      assert.deepEqual(server.tools, [
        'agentkey_status',
        'agentkey_list_items',
        'agentkey_list_operations',
        'agentkey_propose_operation',
        'agentkey_propose_command',
        'agentkey_run_command',
        'agentkey_request_access',
        'agentkey_wait_for_approval',
        'agentkey_run_operation',
        'agentkey_list_databases',
        'agentkey_read_database',
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
