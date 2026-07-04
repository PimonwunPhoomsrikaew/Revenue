// Electron wrapper: boots the existing Express server in this process and
// opens a desktop window pointing at it. All app logic (MySQL, login,
// Excel export) is unchanged — config still comes from .env via config.js.
const { app, BrowserWindow, Menu, shell } = require('electron');
const config = require('./config');
const { start } = require('./server');

const APP_URL = `http://localhost:${config.port}`;
let server;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'JHCIS Dashboard',
    webPreferences: {
      // The renderer only loads our own localhost pages, no Node access needed.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(APP_URL);

  // Open any external links (e.g. mailto / http to other hosts) in the
  // system browser instead of inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  // A minimal menu (keeps the standard reload/zoom/devtools + quit shortcuts).
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );

  server = start();
  if (server.listening) createWindow();
  else server.once('listening', createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
