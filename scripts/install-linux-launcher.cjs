const { accessSync, constants, mkdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');

if (process.platform !== 'linux') throw new Error('This launcher is for Linux desktops only.');
const root = resolve(__dirname, '..');
const executable = join(root, 'release/linux-unpacked/agentkey');
const icon = join(root, 'public/agentkey.png');
accessSync(executable, constants.X_OK);
accessSync(icon, constants.R_OK);
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
if (!isAbsolute(dataHome)) throw new Error('XDG_DATA_HOME must be an absolute path.');

// Desktop strings and Exec arguments have separate escaping rules. No shell runs.
const value = (text) =>
  text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
const argument = (text) => {
  if (/[\r\n\t]/.test(text)) throw new Error('Launcher paths cannot contain control characters.');
  return value(`"${text.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&')}"`);
};
const directory = join(dataHome, 'applications');
const destination = join(directory, 'agentkey.desktop');
mkdirSync(directory, { recursive: true });
writeFileSync(
  destination,
  `[Desktop Entry]\nType=Application\nName=AgentKey\nComment=Local credential vault for approved agent operations\nExec=/usr/bin/env -u ELECTRON_RUN_AS_NODE ${argument(executable)}\nIcon=${value(icon)}\nTerminal=false\nCategories=Utility;Security;\nStartupWMClass=AgentKey\nKeywords=credentials;secrets;vault;\n`,
  { flag: 'wx', mode: 0o644 },
);
console.log(`Installed ${destination}`);
console.log('Open your applications menu and search for AgentKey. You can pin it to the dock.');
