import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DesktopApi } from '../shared/contracts';

export async function connectDesktopMcp(page: Page, directory: string): Promise<Client> {
  const result = await page.evaluate(() =>
    (window as Window & { agentkey: DesktopApi }).agentkey.connection(),
  );
  if (!result.ok) throw new Error('Desktop connection details are unavailable.');
  // No display, desktop session or provider credentials may be needed by a stdio adapter.
  const env: Record<string, string> = {
    HOME: directory,
    USERPROFILE: directory,
    ...result.value.env,
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: result.value.command,
    args: result.value.args,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'desktop-mcp-test', version: '1.0.0' });
  let diagnostics = '';
  const connecting = client.connect(transport, { timeout: 10_000 });
  transport.stderr?.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192);
  });
  try {
    await connecting;
    return client;
  } catch (error) {
    await client.close();
    // Callers use disposable synthetic vaults and the minimal environment above.
    throw new Error(`Desktop MCP startup failed: ${diagnostics}`, { cause: error });
  }
}

export async function callMcp(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const block = result.content[0];
  if (result.content.length !== 1 || block?.type !== 'text') {
    throw new Error('Expected exactly one AgentKey JSON text result.');
  }
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error('AgentKey tool returned invalid JSON.');
  }
}
