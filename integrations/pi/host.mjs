import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { startRelay } from './relay.mjs';
import { launchSandbox, preflight, validateBrokerDirectory } from './sandbox.mjs';

let relay;
let temporary;
try {
  const { values } = parseArgs({
    options: {
      'broker-dir': { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: pnpm sandbox:pi --broker-dir PATH --provider PROVIDER --model MODEL --prompt "Your database task"\nUses existing Pi provider authentication on the host. No provider or database credentials enter the container. Requires native Linux Docker Engine and a running, unlocked AgentKey desktop app.\n',
    );
  } else {
    if (
      !values['broker-dir'] ||
      !values.provider ||
      !values.model ||
      !values.prompt ||
      Buffer.byteLength(values.prompt) > 8192
    )
      throw new Error(
        'Provide --broker-dir, --provider, --model and a prompt of at most 8192 bytes. Never include credentials in the prompt.',
      );
    const brokerDirectory = validateBrokerDirectory(values['broker-dir']);
    // Fail before provider authentication or paid inference on an incompatible host.
    await preflight();
    temporary = mkdtempSync(join(tmpdir(), 'ak-host-'));
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      modelsStorePath: join(temporary, 'model-cache'),
      allowModelNetwork: false,
    });
    const model = runtime.getModel(values.provider, values.model);
    if (!model)
      throw new Error(
        'That provider/model is not in the installed Pi catalog. No fallback model was selected.',
      );
    relay = await startRelay((context, signal) =>
      runtime.completeSimple(model, context, {
        signal,
        maxTokens: 4096,
        maxRetries: 0,
        timeoutMs: 60_000,
        transport: 'sse',
      }),
    );
    const result = await launchSandbox({
      brokerDirectory,
      relayDirectory: relay.directory,
      prompt: values.prompt,
    });
    process.stdout.write(`${result.answer}\n`);
    process.stderr.write(
      `Completed with ${result.tools.length} tool calls and ${relay.calls} model requests.\n`,
    );
  }
} catch {
  process.stderr.write(
    'AgentKey isolated Pi could not run. Check the CLI arguments, built sandbox image, fresh broker directory, desktop approvals, existing host Pi login and Docker/AppArmor compatibility. No credentials or raw provider errors were returned. See README.md for the supported setup.\n',
  );
  process.exitCode = 1;
} finally {
  await relay?.close();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
