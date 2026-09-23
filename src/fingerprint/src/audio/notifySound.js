'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

/**
 * Phat am thanh thong bao bang mot BrowserWindow an (offscreen), vi Node.js
 * thuan (main process cua Electron) khong co API audio truc tiep.
 * Cach nay on dinh, khong can them thu vien native audio nao khac.
 */
let audioWindow = null;

function getAudioWindow() {
  if (audioWindow && !audioWindow.isDestroyed()) return audioWindow;
  audioWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  audioWindow.loadFile(path.join(__dirname, 'player.html'));
  return audioWindow;
}

function playSound(fileName) {
  try {
    const win = getAudioWindow();
    const filePath = path
      .join(__dirname, '..', '..', 'assets', 'sounds', fileName)
      .replace(/\\/g, '/');
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('play', filePath);
    });
    if (!win.webContents.isLoading()) {
      win.webContents.send('play', filePath);
    }
  } catch (e) {
    // Khong de loi am thanh lam crash service quet van tay
    console.error('[notifySound] Loi phat am thanh:', e.message);
  }
}

/** Am thong bao: may quet san sang, moi nguoi dung dat ngon tay */
function playPromptScan() {
  playSound('prompt-scan.wav');
}

/** Am thong bao: da nhan du lieu van tay thanh cong */
function playScanReceived() {
  playSound('scan-received.wav');
}

module.exports = { playPromptScan, playScanReceived };
