#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentCommand } from '../shared/contracts';
import { agentCommandSchema, parseInput, publicError, SafeError } from '../core/schema';
import { callBroker } from './client';
import { serveMcp } from './mcp';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { 'data-dir': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      'AgentKey: node dist/agent/cli.js <mcp|status|list-items|list-operations|list-databases|request-access|run|read-database> [operation] --data-dir <desktop data directory>\nread-database accepts one bounded JSON query on stdin, never a connection URL or raw SQL.\nNo raw-secret or approval commands are exposed.\n',
    );
    return;
  }
  if (!values['data-dir'])
    throw new SafeError('Provide --data-dir using the path shown in AgentKey’s Connect panel.');
  const directory = resolve(values['data-dir']);
  const [action, operation] = positionals;
  if (action === 'mcp' && positionals.length === 1) {
    await serveMcp(directory);
    return;
  }
  if (positionals.length > 2) throw new SafeError('Unexpected arguments. Use --help.');
  let input: unknown = { action, ...(operation === undefined ? {} : { operation }) };
  if (action === 'read-database') {
    if (operation !== undefined)
      throw new SafeError('Pass the structured database query on stdin.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) throw new SafeError('Invalid query input.');
      size += chunk.length;
      if (size > 12_000) throw new SafeError('Query input exceeds the size limit.');
      chunks.push(chunk);
    }
    input = { action, query: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  const command: AgentCommand = parseInput(agentCommandSchema, input);
  const result = await callBroker(directory, command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
void main().catch((error: unknown) => {
  // Keep stdout exclusively for MCP frames or explicit CLI JSON results.
  process.stderr.write(`${publicError(error)}\n`);
  process.exitCode = 1;
});
