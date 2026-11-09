import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  Tray,
  type IpcMainInvokeEvent,
  type Rectangle,
} from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { startBroker } from '../core/broker';
import { durationSchema, nameSchema, parseInput, publicError, SafeError } from '../core/schema';
import { SQLiteSetup } from '../core/sqlite-setup';
import { Vault } from '../core/vault';
import { panelBounds } from './panel';
import { ApprovalNotifications } from './notifications';

app.setName('AgentKey');
if (process.argv.includes('--mcp')) {
  process.stderr.write(
    'The desktop --mcp entry point has been retired. Copy the updated configuration from Connect an agent; the packaged adapter uses the bundled Node runtime.\n',
  );
  app.exit(1);
}
app.enableSandbox();
const dataIndex = process.argv.indexOf('--data-dir');
const customDirectory = dataIndex < 0 ? undefined : process.argv[dataIndex + 1];
if (dataIndex >= 0 && (!customDirectory || customDirectory.startsWith('--'))) {
  process.stderr.write('A data directory is required after --data-dir.\n');
  app.exit(1);
}
if (customDirectory) app.setPath('userData', resolve(customDirectory));

const APP_URL = 'agentkey://app/index.html';
const PANEL_URL = `${APP_URL}?view=compact`;
protocol.registerSchemesAsPrivileged([
  { scheme: 'agentkey', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let window: BrowserWindow | undefined;
let panel: BrowserWindow | undefined;
let panelLoading: Promise<void> | undefined;
let panelHiddenAt = 0;
let tray: Tray | undefined;
let vault: Vault | undefined;
let sqliteSetup: SQLiteSetup | undefined;
let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
let quitting = false;
let approvalNotifications: ApprovalNotifications | undefined;

function show(): void {
  panel?.hide();
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
  window?.flashFrame(false);
}
function lock(): void {
  approvalNotifications?.clear();
  sqliteSetup?.clear();
  vault?.lock();
  // Both trusted views must discard drafts on lock, sleep and OS screen-lock.
  for (const view of [window, panel]) {
    if (view && !view.isDestroyed()) view.webContents.reload();
  }
}
function secureWindow(view: BrowserWindow): void {
  const conceal = () => {
    if (!view.isDestroyed() && !view.webContents.isDestroyed())
      view.webContents.send('window:conceal');
  };
  view.on('hide', conceal);
  view.on('blur', conceal);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  view.webContents.on('will-attach-webview', (event) => event.preventDefault());
  view.webContents.on('render-process-gone', () => {
    approvalNotifications?.clear();
    sqliteSetup?.clear();
    vault?.lock();
    for (const other of [window, panel]) {
      if (other && other !== view && !other.isDestroyed()) other.webContents.reload();
    }
  });
}
function preferences() {
  return {
    preload: join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}
async function showPanel(bounds?: Rectangle): Promise<void> {
  if (quitting) return;
  if (!panel) {
    const view = new BrowserWindow({
      width: 420,
      height: 640,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'AgentKey quick access',
      backgroundColor: '#f5f5f0',
      icon: icon(),
      webPreferences: preferences(),
    });
    panel = view;
    secureWindow(view);
    view.on('blur', () => {
      if (quitting || view.isDestroyed()) return;
      panelHiddenAt = Date.now();
      view.hide();
    });
    view.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        view.hide();
      }
    });
    view.on('closed', () => {
      panel = undefined;
      panelLoading = undefined;
    });
    panelLoading = view.loadURL(PANEL_URL).catch(() => {
      view.destroy();
      throw new Error('Quick access could not be loaded.');
    });
  }
  await panelLoading;
  if (!panel || panel.isDestroyed() || quitting) return;
  const cursor = screen.getCursorScreenPoint();
  const reportedBounds = bounds ?? (process.platform !== 'linux' ? tray?.getBounds() : undefined);
  const anchor =
    reportedBounds && reportedBounds.width > 0 && reportedBounds.height > 0
      ? reportedBounds
      : { ...cursor, width: 0, height: 0 };
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  panel.setBounds(panelBounds(anchor, display.workArea));
  panel.show();
  panel.focus();
}
function icon() {
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const radius = Math.hypot(x - 11, y - 12);
      const key =
        (radius >= 4 && radius <= 7) ||
        (x >= 15 && x <= 28 && y >= 11 && y <= 14) ||
        (x >= 23 && x <= 26 && y >= 14 && y <= 19);
      const i = (y * 32 + x) * 4;
      pixels[i] = key ? 255 : 44;
      pixels[i + 1] = key ? 255 : 81;
      pixels[i + 2] = key ? 255 : 23;
      pixels[i + 3] = 255;
    }
  return nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
}
function trusted(event: IpcMainInvokeEvent): boolean {
  return (
    [
      [window, APP_URL],
      [panel, PANEL_URL],
    ] as const
  ).some(
    ([view, url]) =>
      view &&
      !view.isDestroyed() &&
      event.sender === view.webContents &&
      event.senderFrame === view.webContents.mainFrame &&
      event.senderFrame.url === url,
  );
}
function handle(channel: string, action: (input: unknown) => unknown): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted window.' };
    try {
      return { ok: true, value: await action(input) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    } finally {
      if (!vault?.storage.unlocked) {
        sqliteSetup?.clear();
        approvalNotifications?.clear();
      } else if (
        [
          'vault:approve',
          'vault:approve-proposal',
          'vault:dismiss-proposal',
          'vault:approve-command',
          'vault:dismiss-command',
          'vault:revoke',
        ].includes(channel)
      ) {
        const snapshot = vault.snapshot();
        if (
          !snapshot.pending.length &&
          !snapshot.proposals.length &&
          !snapshot.commands.some((request) => request.state === 'pending')
        )
          approvalNotifications?.clear();
      }
    }
  });
}
async function desktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', show);
  await app.whenReady();
  const dataDirectory = app.getPath('userData');
  const owner = new Vault(dataDirectory);
  vault = owner;
  const setup = new SQLiteSetup(owner);
  sqliteSetup = setup;
  const root = resolve(__dirname, '../agentkey/browser');
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'";
  protocol.handle('agentkey', async (request) => {
    try {
      const url = new URL(request.url);
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const contentType = mime[extname(path)];
      if (
        request.method !== 'GET' ||
        url.host !== 'app' ||
        !path.startsWith(`${root}${sep}`) ||
        !contentType
      )
        return new Response(null, { status: 404 });
      const content = await readFile(path);
      return new Response(new Uint8Array(content), {
        headers: {
          'Content-Type': contentType,
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  // The renderer can fetch packaged assets only, never the internet or local files.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith('agentkey://app/') }),
  );
  handle('vault:snapshot', () => owner.snapshot());
  handle('vault:initialize', (input) => owner.initialize(parseInput(z.string().max(1024), input)));
  handle('vault:unlock', (input) => owner.unlock(parseInput(z.string().max(1024), input)));
  handle('vault:lock', () => {
    owner.lock();
    setImmediate(lock);
  });
  handle('vault:save-item', (input) => owner.saveItem(input));
  handle('vault:delete-item', (input) => owner.deleteItem(input));
  handle('vault:save-operation', (input) => owner.saveOperation(input));
  handle('vault:approve-proposal', (input) => owner.approveProposal(input));
  handle('vault:dismiss-proposal', (input) => owner.dismissProposal(input));
  handle('vault:approve-command', (input) => owner.approveCommand(input));
  handle('vault:dismiss-command', (input) => owner.dismissCommand(input));
  handle('vault:review-operation', (input) => owner.reviewOperation(input));
  handle('vault:save-database', (input) => owner.saveDatabase(input));
  handle('vault:prepare-sqlite', async (input) => {
    const source = parseInput(z.enum(['demo', 'file']), input);
    const revision = owner.sessionRevision;
    if (source === 'demo') return setup.prepare();
    const parent = panel?.isFocused() ? panel : window;
    if (!parent) throw new SafeError('Open the desktop window first.');
    const selected = await dialog.showOpenDialog(parent, {
      title: 'Choose a closed, exported SQLite database (maximum 16 MiB)',
      properties: ['openFile'],
      filters: [{ name: 'SQLite database', extensions: ['sqlite', 'sqlite3', 'db'] }],
    });
    if (selected.canceled) return null;
    if (revision !== owner.sessionRevision)
      throw new SafeError('Vault state changed. Choose the file again.');
    const path = selected.filePaths[0];
    if (!path) throw new SafeError('Choose a SQLite file first.');
    return setup.prepare(path);
  });
  handle('vault:save-sqlite', (input) => setup.save(input));
  handle('vault:cancel-sqlite', (input) => setup.cancel(input));
  handle('vault:delete-operation', (input) => owner.deleteOperation(input));
  handle('vault:approve', (input) => {
    const parsed = parseInput(
      z.strictObject({
        operation: nameSchema,
        duration: durationSchema,
        revision: z.string().uuid(),
        dataSharingAccepted: z.boolean().optional(),
      }),
      input,
    );
    owner.approve(parsed.operation, parsed.duration, parsed.revision, parsed.dataSharingAccepted);
  });
  handle('vault:revoke', (input) => owner.revoke(input));
  handle('window:show', async (input) => {
    const view = parseInput(z.enum(['full', 'compact']), input);
    if (view === 'full') show();
    else await showPanel();
  });
  handle('window:hide-panel', () => panel?.hide());
  handle('vault:connection', () => ({
    dataDirectory,
    command: app.isPackaged ? process.execPath : 'node',
    args: [join(app.getAppPath(), 'dist/agent/cli.js'), 'mcp', '--data-dir', dataDirectory],
    ...(app.isPackaged ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  }));
  window = new BrowserWindow({
    width: 1150,
    height: 820,
    minWidth: 680,
    minHeight: 540,
    title: 'AgentKey',
    icon: icon(),
    backgroundColor: '#f5f5f0',
    autoHideMenuBar: true,
    webPreferences: preferences(),
  });
  secureWindow(window);
  window.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window?.hide();
    } else if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  window.on('closed', () => {
    window = undefined;
  });
  try {
    tray = new Tray(icon());
    tray.setToolTip('AgentKey — local secret vault');
    const menu = Menu.buildFromTemplate([
      {
        label: 'Quick access',
        click: () => {
          void showPanel().catch(show);
        },
      },
      { label: 'Open full window', click: show },
      { label: 'Lock vault', click: lock },
      { type: 'separator' },
      { label: 'Quit AgentKey', click: () => app.quit() },
    ]);
    // Linux activation varies by shell; retain a native-menu fallback there.
    if (process.platform === 'linux') tray.setContextMenu(menu);
    else tray.on('right-click', () => tray?.popUpContextMenu(menu));
    tray.on('click', (_event, bounds) => {
      if (panel?.isVisible()) panel.hide();
      // Clicking the icon can blur the panel before its activation event arrives.
      else if (Date.now() - panelHiddenAt > 250) void showPanel(bounds).catch(show);
    });
  } catch {
    tray = undefined;
  }
  approvalNotifications = new ApprovalNotifications({
    supported: () => Notification.isSupported(),
    create: (options) => new Notification({ ...options, icon: icon() }),
    flash: () => {
      if (window && !window.isDestroyed()) window.flashFrame(true);
    },
    openApprovals: () => {
      if (quitting || !window || window.isDestroyed()) return;
      show();
      window.webContents.send('window:approvals');
    },
  });
  broker = await startBroker(owner, () => approvalNotifications?.notify());
  powerMonitor.on('suspend', lock);
  powerMonitor.on('lock-screen', lock);
  app.on('activate', show);
  await window.loadURL(APP_URL);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  approvalNotifications?.clear();
  sqliteSetup?.clear();
  vault?.lock();
  void Promise.allSettled([broker?.close()]).finally(() => {
    tray?.destroy();
    app.exit(0);
  });
});
void desktop().catch(() => {
  process.stderr.write(
    'AgentKey could not start. Check the data directory and desktop environment.\n',
  );
  vault?.lock();
  app.exit(1);
});
