'use strict';

/**
 * Tich hop ZK Fingerprint Kiosk vao PrintAgent.
 *
 * File nay thay the electron-main.js cua du an goc, giu NGUYEN logic khoi dong
 * dich vu (API 127.0.0.1:18622, am thanh thong bao, che do dan anh thu cong).
 * Toan bo code trong ./src (device, server, audio, manual) duoc giu nguyen.
 *
 * Khac biet duy nhat so voi ban doc lap:
 *  - Khong tao Tray rieng: menu van tay nam trong menu khay cua PrintAgent.
 *  - Khong tu dang ky khoi dong cung Windows (PrintAgent da tu khoi dong).
 *  - Khong chiem single-instance / app lifecycle (PrintAgent quan ly).
 */

const log = require('electron-log');
const { shell } = require('electron');

const { createApiServer, PORT } = require('./src/server/apiServer');
const { DeviceManager } = require('./src/device/deviceManager');
const { playPromptScan, playScanReceived } = require('./src/audio/notifySound');
const { openManualUploadWindow } = require('./src/manual/manualUploadWindow');

let apiServer = null;
let started = false;
let serverRunning = false;
let activeScans = 0;
const deviceManager = new DeviceManager();
let lastStatusText = 'Đang khởi động...';
let onChange = () => {};

// Dem so lan quet dang cho (khong sua deviceManager.js) de PrintAgent
// khong tu cai ban cap nhat khi dang cho benh nhan dat ngon tay.
const originalScan = deviceManager.scan.bind(deviceManager);
deviceManager.scan = async (...args) => {
  activeScans++;
  try { return await originalScan(...args); }
  finally { activeScans--; }
};

function refresh() {
  try { onChange(); } catch (e) { log.warn('[fingerprint] refresh loi:', e.message); }
}

function createServer() {
  return createApiServer({
    deviceManager,
    onCheckConnectionResult: (success) => {
      lastStatusText = success ? 'Máy quét: đã kết nối' : 'Máy quét: không kết nối được';
      refresh();
      if (success) {
        playPromptScan();
      }
    },
    onScanResult: (success) => {
      if (success) {
        lastStatusText = 'Máy quét: đã nhận vân tay';
        playScanReceived();
      } else {
        lastStatusText = 'Máy quét: lấy vân tay thất bại';
      }
      refresh();
    }
  });
}

async function startServer() {
  apiServer = createServer();
  try {
    const server = await apiServer.start();
    // PrintAgent dung Express 5: khi cong bi chiem, callback listen() van duoc
    // goi (kem loi) nen start() co the resolve du server khong chay -> kiem tra lai.
    if (!server || !server.listening) throw new Error(`Cổng ${PORT} đang bị chiếm dụng`);
    serverRunning = true;
    lastStatusText = 'Máy quét: sẵn sàng';
  } catch (e) {
    serverRunning = false;
    log.error(`Khong the khoi dong HTTP server tren cong ${PORT}:`, e.message);
    lastStatusText = `Lỗi: cổng ${PORT} đang bị chiếm dụng (tắt ứng dụng ZK Fingerprint Kiosk cũ)`;
  }
  refresh();
}

/** Khoi dong dich vu van tay cung PrintAgent. Khong bao gio throw. */
async function startFingerprintService(options = {}) {
  if (started) return;
  started = true;
  if (typeof options.onChange === 'function') onChange = options.onChange;
  log.info('=== ZK Fingerprint (tich hop PrintAgent) khoi dong ===');
  await startServer();
}

async function restartFingerprintService() {
  lastStatusText = 'Đang khởi động lại dịch vụ vân tay...';
  refresh();
  await stopFingerprintService();
  await startServer();
}

async function stopFingerprintService() {
  log.info('Dang dung dich vu van tay...');
  try {
    if (apiServer) await apiServer.stop();
  } catch (e) {
    log.error(e.message);
  }
  serverRunning = false;
  try {
    deviceManager.shutdown();
  } catch (e) {
    log.error(e.message);
  }
}

function selectDeviceMode() {
  deviceManager.setUploadMode(false);
  lastStatusText = 'Nguồn vân tay: Máy quét thật';
  refresh();
}

function selectManualMode() {
  // setUploadMode(true) duoc goi ben trong openManualUploadWindow neu
  // chua bat, nen chi can mo cua so - callback onSaved cap nhat trang thai.
  openManualUploadWindow({
    deviceManager,
    onSaved: () => {
      lastStatusText = deviceManager.pendingManualImage
        ? 'Nguồn vân tay: Dán ảnh thủ công - đã có ảnh cho lần quét tiếp theo'
        : 'Nguồn vân tay: Dán ảnh thủ công (đang chờ ảnh)';
      refresh();
    }
  });
  lastStatusText = 'Nguồn vân tay: Dán ảnh thủ công (đang chờ ảnh)';
  refresh();
}

/**
 * Menu con "Quét vân tay" cho khay he thong cua PrintAgent - cung cac muc
 * nhu trayMenu.js cua ban doc lap.
 * @param {{beforeOpenWindow?: Function}} hooks
 */
function buildFingerprintMenu(hooks = {}) {
  const uploadModeOn = deviceManager.uploadMode;
  return [
    { label: lastStatusText, enabled: false },
    { label: `API: http://localhost:${PORT}${serverRunning ? '' : ' (chưa chạy)'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Kiểm tra kết nối máy quét',
      click: async () => {
        const result = await deviceManager.checkConnection();
        lastStatusText = result.ok ? 'Máy quét: đã kết nối' : `Máy quét: ${result.message || 'không kết nối được'}`;
        refresh();
        if (result.ok) playPromptScan();
      }
    },
    {
      label: `Mở API trong trình duyệt (cổng ${PORT})`,
      click: () => shell.openExternal(`http://localhost:${PORT}/`)
    },
    { type: 'separator' },
    { label: 'Nguồn lấy vân tay', enabled: false },
    {
      label: 'Máy quét vân tay (thiết bị thật)',
      type: 'radio',
      checked: !uploadModeOn,
      click: () => selectDeviceMode()
    },
    {
      label: 'Dán ảnh vân tay thủ công...',
      type: 'radio',
      checked: uploadModeOn,
      click: () => {
        // Luon mo cua so nhap anh khi chon muc nay, ke ca dang o san che do
        // thu cong roi - de nhan vien nhap anh moi cho ho so tiep theo.
        if (hooks.beforeOpenWindow) hooks.beforeOpenWindow();
        selectManualMode();
      }
    },
    { type: 'separator' },
    {
      label: 'Khởi động lại dịch vụ vân tay',
      click: () => restartFingerprintService().catch((e) => log.error(e.message))
    }
  ];
}

function isFingerprintBusy() {
  return activeScans > 0;
}

module.exports = {
  startFingerprintService,
  stopFingerprintService,
  restartFingerprintService,
  buildFingerprintMenu,
  isFingerprintBusy,
  FINGERPRINT_PORT: PORT
};
