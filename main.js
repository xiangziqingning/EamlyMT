// 我的创作工作站 - 桌面版主进程
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const obsIpc = require('./obs-ipc');
const netIpc = require('./net-ipc');
const perfIpc = require('./perf-ipc');
const apiIpc = require('./api-ipc');
const diskIpc = require('./disk-ipc');
const upd = require('./update-ipc');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#070b16',
    title: '我的创作工作站',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenuBarVisibility(false);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  obsIpc.register();
  netIpc.register();
  perfIpc.register();
  apiIpc.register();
  diskIpc.register();
  upd.register();
  const win = createWindow();
  upd.setWindow(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      upd.setWindow(w);
    }
  });

  // 启动后先检查一次，之后每 4 小时后台检查（网络异常静默重试，不影响其它功能）
  upd.startAutoCheck();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
