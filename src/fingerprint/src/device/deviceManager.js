'use strict';

const log = require('electron-log');
const { ZkfpDevice } = require('./zkfpNative');
const { rawGrayscaleToPngBase64 } = require('./rawToPng');

/**
 * DeviceManager: lop trung gian duy nhat ma server.js goi toi.
 * - MOCK_FINGERPRINT=1 (bien moi truong) => gia lap thiet bi, dung khi dev/test tren may
 *   khong co ZK9500/ZK4500 cam vao, hoac chua cai SDK. Tra ve anh PNG 1x1 mau xam gia lap.
 * - Mac dinh: dung that qua ZKFinger SDK (libzkfp.dll).
 */
class DeviceManager {
  constructor() {
    this.mock = process.env.MOCK_FINGERPRINT === '1';
    this.device = this.mock ? null : new ZkfpDevice();
    this.connected = false;
    this.lastError = null;

    // ---- Che do nhap anh van tay thu cong (khi BN da ve, HS thao tac sai) ----
    // Khi bat, KHONG dung may quet that nua (ngat ket noi neu dang ket noi);
    // send-scan se tra ve anh do nhan vien tu dan/tai len thay vi quet song.
    // Khi tat, lan check-connection/scan ke tiep se tu ket noi lai may that.
    this.uploadMode = false;
    // { base64, reason, capturedAt } - anh dang cho duoc "tra ve" qua lan
    // goi send-scan tiep theo. Dung 1 LAN roi xoa (one-shot) de tranh vo tinh
    // dung nham lai cho ho so benh nhan khac.
    this.pendingManualImage = null;
  }

  /**
   * Bat/tat che do dan anh thu cong.
   * @param {boolean} enabled
   */
  setUploadMode(enabled) {
    this.uploadMode = !!enabled;
    if (this.uploadMode) {
      // Ngat ket noi may quet that (neu co) - dung dung 2 nguon cung luc
      // de tranh nham lan.
      if (!this.mock && this.device) {
        try {
          this.device.disconnect();
        } catch (e) {
          log.warn('[DeviceManager] Loi ngat ket noi khi bat che do dan anh:', e.message);
        }
      }
      this.connected = false;
      log.info('[DeviceManager] Da BAT che do dan anh van tay thu cong - ngung dung may quet that.');
    } else {
      this.pendingManualImage = null;
      log.info('[DeviceManager] Da TAT che do dan anh van tay thu cong - quay lai dung may quet that.');
    }
  }

  /**
   * Luu anh van tay duoc dan/tai len thu cong, cho lan send-scan tiep theo tra ve.
   * Bat buoc reason de co the tra soat sau nay (vi sao dung anh thu cong).
   *
   * Luu y: khong con thu thap ma nhan vien xac nhan (theo yeu cau rut gon UI) -
   * log audit o day chi con ly do + thoi diem, khong xac dinh duoc CU THE AI
   * la nguoi thao tac. Neu sau nay can biet chinh xac nhan vien nao da luu anh,
   * can doi chieu voi log dang nhap Windows tren may chay service nay, hoac bo
   * sung lai truong dinh danh nhan vien vao day.
   */
  setManualImage({ base64, reason }) {
    if (!this.uploadMode) {
      throw new Error('Chua bat che do dan anh thu cong');
    }
    if (!base64) throw new Error('Thieu du lieu anh');
    if (!reason || !reason.trim()) throw new Error('Thieu ly do lay anh van tay thu cong');

    this.pendingManualImage = {
      base64,
      reason: reason.trim(),
      capturedAt: new Date().toISOString()
    };
    // Ghi log rieng, de sau nay co the grep audit: ly do, thoi diem da dung
    // anh dan tay thay vi quet that.
    log.info(
      `[MANUAL-FINGER] Da nhan anh van tay THU CONG - ly do="${this.pendingManualImage.reason}" ` +
      `luc=${this.pendingManualImage.capturedAt}`
    );
  }

  async checkConnection() {
    if (this.uploadMode) {
      this.connected = true;
      return {
        ok: true,
        message: 'Che do dan anh van tay thu cong dang BAT (khong dung may quet that)',
        manual: true
      };
    }
    if (this.mock) {
      this.connected = true;
      return { ok: true, message: 'Ket noi may quet thanh cong (MOCK MODE)' };
    }
    try {
      if (!this.device.isConnected()) {
        this.device.connect();
      }
      this.connected = true;
      this.lastError = null;
      return { ok: true, message: 'Ket noi may quet van tay thanh cong' };
    } catch (e) {
      this.connected = false;
      this.lastError = e.message;
      log.error('[DeviceManager] check-connection loi:', e.message);
      return { ok: false, message: e.message };
    }
  }

  async scan() {
    if (this.uploadMode) {
      // Cho (poll) toi 60s cho nhan vien dan/luu anh - GIONG HET hanh vi cho
      // dat ngon tay len may quet that (khong tra loi ngay lap tuc), de phia
      // client (HIS) thay 2 che do co cach cu xu nhu nhau.
      return await this._waitForManualImage(60000);
    }

    if (this.mock) {
      // anh PNG 4x4 xam gia lap, chi de test luong end-to-end khi khong co phan cung
      const fakeBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAB1xeIbAAAAEUlEQVR4nGP8//8/AwMDEwMGAABLBAP7fVLGCwAAAABJRU5ErkJggg==';
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, base64: fakeBase64 };
    }
    try {
      if (!this.device.isConnected()) {
        this.device.connect();
      }
      const { raw, width, height } = await this.device.captureRaw(60000);
      const base64 = rawGrayscaleToPngBase64({ raw, width, height });
      return { ok: true, base64 };
    } catch (e) {
      log.error('[DeviceManager] send-scan loi:', e.message);
      return { ok: false, message: e.message };
    }
  }

  /**
   * Cho toi timeoutMs de pendingManualImage xuat hien (nhan vien dan/luu anh
   * qua cua so thu cong trong luc nay). Poll bang setTimeout (khong chan
   * event loop) - tuong tu cach zkfpNative.captureRaw() cho ngon tay.
   */
  async _waitForManualImage(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.pendingManualImage) {
        const { base64, reason, capturedAt } = this.pendingManualImage;
        // One-shot: xoa ngay sau khi da "tra ve" 1 lan, tranh dung nham cho ho so ke tiep.
        this.pendingManualImage = null;
        return {
          ok: true,
          base64,
          manual: true,
          manualInfo: { reason, capturedAt }
        };
      }
      // Neu trong luc cho, nguoi dung tat che do thu cong (chuyen ve may that)
      // thi dung cho tiep, tra loi that bai ngay de khong giu client cho vo ich.
      if (!this.uploadMode) {
        return { ok: false, message: 'Da chuyen sang che do may quet that trong luc cho anh thu cong' };
      }
      await sleep(200);
    }
    return {
      ok: false,
      message:
        'Het thoi gian cho nhap anh van tay thu cong (khong co ai dan/luu anh trong 60s). ' +
        'Mo menu khay he thong -> "Lay anh van tay thu cong..." de dan anh.'
    };
  }

  shutdown() {
    if (!this.mock && this.device) this.device.shutdown();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { DeviceManager };
