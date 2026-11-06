const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
// Some coding hosts use Electron's Node mode. Never inherit it into the desktop.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require('electron'),
  [path.resolve(__dirname, '..'), ...process.argv.slice(2)],
  { env, stdio: 'inherit' },
);
child.on('error', () => {
  process.stderr.write('Unable to launch Electron.\n');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
