#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentCommand } from '../shared/contracts';
import { agentCommandSchema, parseInput, publicError, SafeError } from '../core/schema';
import { callBroker } from './client';
import { serveMcp } from './mcp';
import { commandRunSchema } from '../core/command-schema';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { 'data-dir': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      'AgentKey: node dist/agent/cli.js <mcp|status|list-items|list-operations|list-databases|request-access|wait-for-approval|run|read-database|propose-command|run-command> [operation] --data-dir <desktop data directory>\nread-database accepts one bounded JSON query on stdin, never a connection URL or raw SQL. propose-command accepts the exact command JSON on stdin; run-command accepts {operation, revision} on stdin. Never put secret values in input.\nNo raw-secret or approval commands are exposed.\n',
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
  if (action === 'read-database' || action === 'propose-command' || action === 'run-command') {
    if (operation !== undefined) throw new SafeError('Pass the structured request on stdin.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) throw new SafeError('Invalid query input.');
      size += chunk.length;
      if (size > (action === 'read-database' ? 12_000 : 262_000))
        throw new SafeError('Input exceeds the size limit.');
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (action === 'run-command') {
      const request = parseInput(commandRunSchema, body);
      input = { action, ...request };
    } else input = { action, [action === 'read-database' ? 'query' : 'command']: body };
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
