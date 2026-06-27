const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = process.env.NODE_ENV === 'development';

// Setup store
let Store;
let store;

async function initStore() {
  const { default: ElectronStore } = await import('electron-store');
  Store = ElectronStore;
  store = new Store();
  
  // Register IPC handlers for store
  ipcMain.handle('store-get', (event, key) => {
    return store.get(key);
  });

  ipcMain.handle('store-set', (event, key, value) => {
    store.set(key, value);
  });
}

// VPN/Proxy fixes
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost');

// Sometimes hardware acceleration causes display issues through certain VPN/Proxy setups
app.disableHardwareAcceleration();

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, // Changed for security when using contextBridge
      contextIsolation: true, // Changed for security when using contextBridge
    },
    title: 'CRM Task Tracker',
  });

  // VPN Compatibility: Ignore certificate errors often caused by VPN proxies
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
  });

  if (isDev) {
    const loadDevURL = () => {
      mainWindow.loadURL('http://localhost:5173').catch(() => {
        console.log('Vite server not ready, retrying in 1s...');
        setTimeout(loadDevURL, 1000);
      });
    };
    loadDevURL();
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  await initStore();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
