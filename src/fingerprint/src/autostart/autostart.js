'use strict';

const AutoLaunch = require('auto-launch');
const { app } = require('electron');
const log = require('electron-log');

const autoLauncher = new AutoLaunch({
  name: 'ZK Fingerprint Kiosk',
  path: app.getPath('exe'),
  isHidden: true // khoi dong an, khong mo cua so nao
});

async function ensureAutoStartEnabled() {
  try {
    const isEnabled = await autoLauncher.isEnabled();
    if (!isEnabled) {
      await autoLauncher.enable();
      log.info('[autostart] Da bat khoi dong cung Windows');
    }
  } catch (e) {
    log.error('[autostart] Loi cau hinh khoi dong cung:', e.message);
  }
}

async function disableAutoStart() {
  try {
    await autoLauncher.disable();
  } catch (e) {
    log.error('[autostart] Loi tat khoi dong cung:', e.message);
  }
}

module.exports = { ensureAutoStartEnabled, disableAutoStart, autoLauncher };
