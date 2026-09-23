'use strict';

const express = require('express');
const cors = require('cors'); // 1. Require cors
const log = require('electron-log');

const PORT = 18622;

/**
 * Tao va khoi dong HTTP server tren localhost:18622 voi 2 API dung dinh dang
 * giong ung dung Android da lam viec truoc do:
 *
 *   GET /api/finger/check-connection
 *   GET /api/finger/send-scan
 *
 *   Response chung:
 *   { "CODE": 0, "MESSAGE": "...", "RESULT": ... }
 *   CODE = 0  => thanh cong
 *   CODE != 0 => that bai, MESSAGE mo ta loi, RESULT = null
 *
 * onCheckSuccess / onScanSuccess: callback de phat am thanh thong bao
 * (goi tu electron-main.js).
 */
function createApiServer({ deviceManager, onCheckConnectionResult, onScanResult }) {
  const app = express();
  app.use(cors()); // 2. Bật CORS toàn bộ cho API
  app.use(express.json());

  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    next();
  });
  
  // Cho phép tất cả Headers (Bao gồm Authorization, Content-Type)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

  app.get('/api/finger/check-connection', async (req, res) => {
    const result = await deviceManager.checkConnection();
    if (result.ok) {
      res.json({ CODE: 0, MESSAGE: result.message, RESULT: true });
      if (onCheckConnectionResult) onCheckConnectionResult(true);
    } else {
      res.json({ CODE: 1, MESSAGE: result.message || 'Khong ket noi duoc may quet van tay', RESULT: false });
      if (onCheckConnectionResult) onCheckConnectionResult(false);
    }
  });

  app.get('/api/finger/send-scan', async (req, res) => {
    const result = await deviceManager.scan();
    if (result.ok) {
      // Neu day la anh duoc nhap THU CONG (khong phai quet song tu may), danh dau
      // ro trong response bang cac truong phu (khong pha vo contract CODE/MESSAGE/
      // RESULT cu, client cu se bo qua cac truong la neu khong doc toi).
      const extra = result.manual
        ? {
            SOURCE: 'MANUAL_UPLOAD',
            MANUAL_INFO: result.manualInfo // { reason, capturedAt }
          }
        : { SOURCE: 'DEVICE_SCAN' };
      const message = result.manual
        ? 'Lấy vân tay thành công (NHẬP THỦ CÔNG - không phải quét trực tiếp từ máy)'
        : 'Lấy vân tay thành công';
      res.json({ CODE: 0, MESSAGE: message, RESULT: result.base64, ...extra });
      if (onScanResult) onScanResult(true);
    } else {
      res.json({ CODE: 2, MESSAGE: result.message || 'Lấy vân tay thất bại', RESULT: null });
      if (onScanResult) onScanResult(false);
    }
  });

  app.get('/api/finger/status', (req, res) => {
    res.json({
      CODE: 0,
      MESSAGE: 'ok',
      RESULT: {
        connected: deviceManager.connected,
        mock: deviceManager.mock,
        uploadMode: deviceManager.uploadMode,
        hasPendingManualImage: !!deviceManager.pendingManualImage
      }
    });
  });

  app.get('/', (req, res) => {
    res.type('text/plain').send('ZK Fingerprint Desktop Service dang chay. Xem /api/finger/check-connection va /api/finger/send-scan');
  });

  let server = null;

  function start() {
    return new Promise((resolve, reject) => {
      server = app
        .listen(PORT, '127.0.0.1', () => {
          log.info(`[apiServer] Dang lang nghe tai http://localhost:${PORT}`);
          resolve(server);
        })
        .on('error', (err) => {
          log.error('[apiServer] Loi khoi dong server:', err.message);
          reject(err);
        });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  }

  return { start, stop, PORT };
}

module.exports = { createApiServer, PORT };
