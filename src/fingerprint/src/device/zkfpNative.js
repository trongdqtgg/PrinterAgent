'use strict';

/**
 * Binding FFI toi ZKFinger SDK (Windows) - dung chung cho ZK9500 va ZK4500.
 *
 * ZK9500 va ZK4500 deu duoc ho tro boi cung mot bo SDK chinh hang cua ZKTeco:
 * "ZKFinger SDK for Windows" (con goi la ZKFPCap / libzkfp).
 * Ban PHAI cai dat SDK nay tu ZKTeco (hoac nha cung cap thiet bi) tren may Windows
 * de co file "libzkfp.dll" (kem cac dll phu thuoc: ZKFPEngX.dll, ZKFPWDMSDK.dll...).
 *
 * Vi ly do ban quyen, du an nay KHONG bundle san cac file .dll do.
 * => Copy toan bo thu muc cai dat SDK (thuong la:
 *    C:\Program Files (x86)\ZKTeco\ZKFingerSDK\Platforms\x64  hoac  x86)
 *    vao thu muc  native/  cua project nay truoc khi chay `npm start` / build.
 *
 * Cac ham export chuan cua libzkfp.dll (theo tai lieu ZKFinger SDK):
 *   int  ZKFPM_Init();
 *   int  ZKFPM_Terminate();
 *   int  ZKFPM_GetDeviceCount();
 *   void* ZKFPM_OpenDevice(int index);
 *   int  ZKFPM_CloseDevice(void* handle);
 *   int  ZKFPM_GetParameters(void* handle, int code, unsigned char* paramValue, uint32_t* size);
 *   int  ZKFPM_AcquireFingerprint(void* handle, unsigned char* imgBuf, uint32_t imgBufLen,
 *                                  unsigned char* fpTemplate, uint32_t* fpTemplateLen);
 */

const path = require('path');
const fs = require('fs');
const log = require('electron-log');

const PARAM_CODE_WIDTH = 1;
const PARAM_CODE_HEIGHT = 2;

let koffi = null;
let lib = null;
let fn = {};
let loadError = null;

function candidateDllPaths() {
  const arch = process.arch === 'x64' ? 'x64' : 'x86';
  const base = process.resourcesPath
    ? path.join(process.resourcesPath, 'native')
    : path.join(__dirname, '..', '..', 'native');
  return [
    path.join(base, arch, 'libzkfp.dll'),
    path.join(base, 'libzkfp.dll'),
    'libzkfp.dll' // fallback: neu SDK da cai dat va co trong PATH he thong
  ];
}

function loadLibrary() {
  if (lib || loadError) return;
  try {
    koffi = require('koffi');
  } catch (e) {
    loadError = 'Khong the nap module koffi: ' + e.message;
    log.error(loadError);
    return;
  }

  const candidates = candidateDllPaths();
  let dllPath = candidates.find((p) => {
    try {
      return p === 'libzkfp.dll' ? true : fs.existsSync(p);
    } catch {
      return false;
    }
  });

  try {
    lib = koffi.load(dllPath);
    fn.Init = lib.func('int ZKFPM_Init()');
    fn.Terminate = lib.func('int ZKFPM_Terminate()');
    fn.GetDeviceCount = lib.func('int ZKFPM_GetDeviceCount()');
    fn.OpenDevice = lib.func('void* ZKFPM_OpenDevice(int)');
    fn.CloseDevice = lib.func('int ZKFPM_CloseDevice(void*)');
    fn.GetParameters = lib.func(
      'int ZKFPM_GetParameters(void*, int, uint8_t*, _Inout_ uint32_t*)'
    );
    fn.AcquireFingerprint = lib.func(
      'int ZKFPM_AcquireFingerprint(void*, uint8_t*, uint32_t, uint8_t*, _Inout_ uint32_t*)'
    );
    log.info('[ZKFP] Da nap thanh cong SDK tu:', dllPath);
  } catch (e) {
    loadError =
      'Khong nap duoc libzkfp.dll (' + dllPath + '). ' +
      'Hay chac chan da cai ZKFinger SDK va copy dll vao thu muc native/. Chi tiet: ' + e.message;
    log.error(loadError);
    lib = null;
  }
}

class ZkfpDevice {
  constructor() {
    this.initialized = false;
    this.handle = null;
    this.width = 0;
    this.height = 0;
  }

  getLoadError() {
    loadLibrary();
    return loadError;
  }

  isSdkAvailable() {
    loadLibrary();
    return !!lib;
  }

  /** Khoi tao SDK + mo thiet bi dau tien tim thay (ZK9500 hoac ZK4500). */
  connect() {
    loadLibrary();
    if (!lib) throw new Error(loadError || 'SDK chua san sang');

    if (!this.initialized) {
      const rc = fn.Init();
      if (rc !== 0) throw new Error('ZKFPM_Init that bai, ma loi: ' + rc);
      this.initialized = true;
    }

    const count = fn.GetDeviceCount();
    if (count <= 0) {
      throw new Error('Khong tim thay may quet van tay nao (ZK9500/ZK4500) qua USB');
    }

    this.handle = fn.OpenDevice(0);
    if (!this.handle) throw new Error('Khong mo duoc thiet bi quet van tay (index 0)');

    this.width = this._readParamInt(PARAM_CODE_WIDTH, 400);
    this.height = this._readParamInt(PARAM_CODE_HEIGHT, 400);

    return { deviceCount: count, width: this.width, height: this.height };
  }

  _readParamInt(code, fallback) {
    try {
      const buf = Buffer.alloc(4);
      const sizeBuf = [4];
      const rc = fn.GetParameters(this.handle, code, buf, sizeBuf);
      if (rc === 0) return buf.readUInt32LE(0) || fallback;
      return fallback;
    } catch {
      return fallback;
    }
  }

  isConnected() {
    return !!this.handle;
  }

  /**
   * Chup 1 anh van tay tho (raw grayscale), tra ve Buffer + kich thuoc.
   *
   * Ham nay la async va cho (await) giua cac lan thu thay vi sleep dong bo:
   * moi lan goi ZKFPM_AcquireFingerprint tra ve rat nhanh (chi vai ms) khi
   * chua co ngon tay dat len cam bien, nhung buoc cho 80ms giua cac lan thu
   * TRUOC DAY dung Atomics.wait (dong bo) -> chan toan bo main process cua
   * Electron (tray, cac API khac...) trong suot thoi gian cho, co the len
   * toi timeoutMs (mac dinh 60s). Doi sang `await new Promise(setTimeout)`
   * giup nha (yield) vong lap su kien giua moi lan thu, tranh dong bang app.
   */
  async captureRaw(timeoutMs = 60000) {
    if (!this.handle) throw new Error('Thiet bi chua duoc ket noi');
    const imgSize = this.width * this.height;
    const imgBuf = Buffer.alloc(imgSize);
    const tplBuf = Buffer.alloc(2048);
    const tplSizeBox = [2048];

    const start = Date.now();
    let rc = -1;
    while (Date.now() - start < timeoutMs) {
      tplSizeBox[0] = 2048;
      rc = fn.AcquireFingerprint(this.handle, imgBuf, imgSize, tplBuf, tplSizeBox);
      if (rc === 0) break;
      // rc != 0: chua co ngon tay dat len cam bien -> cho 80ms (khong chan
      // event loop) roi thu lai
      await sleep(80);
    }
    if (rc !== 0) {
      throw new Error('Het thoi gian cho quet van tay (khong phat hien ngon tay)');
    }
    return { raw: imgBuf, width: this.width, height: this.height };
  }

  disconnect() {
    try {
      if (this.handle) fn.CloseDevice(this.handle);
    } catch (e) {
      log.warn('[ZKFP] Loi khi dong thiet bi:', e.message);
    }
    this.handle = null;
  }

  shutdown() {
    this.disconnect();
    try {
      if (this.initialized) fn.Terminate();
    } catch (e) {
      log.warn('[ZKFP] Loi khi terminate SDK:', e.message);
    }
    this.initialized = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ZkfpDevice };
