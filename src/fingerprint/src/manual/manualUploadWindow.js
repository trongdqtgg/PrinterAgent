'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, dialog, nativeImage, clipboard } = require('electron');
const log = require('electron-log');

let win = null;
let ipcRegistered = false;
let currentOnSaved = null;

function registerIpcOnce(deviceManager) {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('manual-image:read-clipboard', () => {
    try {
      const img = clipboard.readImage();
      if (!img || img.isEmpty()) {
        return {
          ok: false,
          message: 'Clipboard không có ảnh. Hãy copy (Ctrl+C) ảnh vân tay trước khi bấm Dán.'
        };
      }
      return { ok: true, base64: img.toPNG().toString('base64') };
    } catch (e) {
      return { ok: false, message: 'Lỗi đọc clipboard: ' + e.message };
    }
  });

  ipcMain.handle('manual-image:pick-file', async () => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Chọn file ảnh vân tay',
        filters: [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, message: 'Đã huỷ', canceled: true };
      }
      const img = nativeImage.createFromPath(result.filePaths[0]);
      if (img.isEmpty()) {
        return { ok: false, message: 'Không đọc được file ảnh (định dạng không hỗ trợ?)' };
      }
      // Chuan hoa ve PNG (dung dinh dang ma API /send-scan van tra ve tu truoc
      // toi nay), du file goc la jpg/bmp.
      return { ok: true, base64: img.toPNG().toString('base64') };
    } catch (e) {
      return { ok: false, message: 'Lỗi đọc file: ' + e.message };
    }
  });

  ipcMain.handle('manual-image:save', (event, payload) => {
    try {
      deviceManager.setManualImage(payload || {});
      if (currentOnSaved) currentOnSaved();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
}

/**
 * Mo cua so nhap anh van tay thu cong. Tu dong BAT che do uploadMode (ngat
 * ket noi may quet that) neu chua bat, de tranh vua dung may that vua dung
 * anh thu cong cung luc.
 */
function openManualUploadWindow({ deviceManager, onSaved }) {
  registerIpcOnce(deviceManager);
  currentOnSaved = onSaved || null;

  if (!deviceManager.uploadMode) {
    deviceManager.setUploadMode(true);
    if (onSaved) onSaved();
  }

  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 480,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Dán ảnh vân tay thủ công',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile(path.join(__dirname, 'manualUploadWindow.html'));

  win.on('closed', () => {
    win = null;
  });

  return win;
}

module.exports = { openManualUploadWindow };
