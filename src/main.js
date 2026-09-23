const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const multer = require('multer');
const { print } = require('pdf-to-printer');
const { PDFDocument } = require('pdf-lib');
const { printDocument, isSupported } = require('./document-pipeline');
// Tính năng bổ sung trên khay hệ thống (giữ nguyên code của 2 dự án gốc)
const fingerprint = require('./fingerprint');
const scanMobile = require('./scan-mobile/main');
const execFileAsync = promisify(execFile);

const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 5756;
const UPLOAD_MIME_EXTENSION = {
  'application/pdf':'.pdf',
  'text/html':'.html',
  'application/msword':'.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx',
  'application/vnd.ms-excel':'.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
  'image/png':'.png',
  'image/jpeg':'.jpg'
};

let mainWindow;
let tray;
let isQuitting = false;
let backgroundNoticeShown = false;
let printerCache={items:[],expiresAt:0};
const duplexCapabilityCache=new Map();
let printQueue=Promise.resolve();
const printJobs=new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();
const APP_URL = `http://${LOCAL_HOST}:${LOCAL_PORT}`;

// Nhiều máy trạm dùng driver đồ họa cũ: tiến trình GPU của Chromium bị reset
// (sau sleep/khóa màn hình, đổi màn hình...) làm cửa sổ kiosk trắng trơn.
// Render bằng phần mềm ổn định hơn cho form in. Đặt A4A5_ENABLE_GPU=1 để bật lại GPU.
if (process.env.A4A5_ENABLE_GPU !== '1') app.disableHardwareAcceleration();

// Trạng thái auto update chạy ngầm
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateCheckInProgress = false;
let updateCheckManual = false;
let pendingUpdateVersion = null;
let installScheduled = false;

// Trạng thái tự phục hồi form khi renderer bị trắng/crash
let activeUiJobId = null;
let recoverHistory = [];
let unresponsiveTimer = null;

const PAGE_SIZES_PT={A4:{width:595.28,height:841.89},A5:{width:419.53,height:595.28},Letter:{width:612,height:792}};
const PREVIEW_MARGIN_PT=14.17;

async function reflowPdf(sourceBytes,{landscape,pageSize,scaleFactor}) {
  const srcDoc=await PDFDocument.load(sourceBytes); const outDoc=await PDFDocument.create();
  const base=PAGE_SIZES_PT[pageSize]||PAGE_SIZES_PT.A4;
  let targetW=base.width,targetH=base.height;if(landscape)[targetW,targetH]=[targetH,targetW];
  const userScale=Math.min(2,Math.max(.5,(Number(scaleFactor)||95)/100));
  const pages=await outDoc.copyPages(srcDoc,srcDoc.getPageIndices());
  for(const page of pages){outDoc.addPage(page);const size=page.getSize();const scale=Math.min((targetW-PREVIEW_MARGIN_PT*2)/size.width,(targetH-PREVIEW_MARGIN_PT*2)/size.height)*userScale;page.scale(scale,scale);const x=(targetW-size.width*scale)/2,y=(targetH-size.height*scale)/2;page.setMediaBox(-x,-y,targetW,targetH);page.setCropBox(-x,-y,targetW,targetH);}
  return outDoc.save();
}

function selectedPageIndices(total,selection={}) {
  const all=Array.from({length:total},(_,i)=>i),mode=selection.mode||'all';
  if(mode==='odd')return all.filter(i=>i%2===0).reverse();if(mode==='even')return all.filter(i=>i%2===1);if(mode!=='custom')return all;
  const chosen=new Set();for(const token of String(selection.customRange||'').split(',').map(x=>x.trim()).filter(Boolean)){const match=token.match(/^(\d+)\s*-\s*(\d+)$/);if(match){let a=Number(match[1]),b=Number(match[2]);if(a>b)[a,b]=[b,a];for(let p=a;p<=b;p++)if(p>=1&&p<=total)chosen.add(p-1);}else if(/^\d+$/.test(token)){const p=Number(token);if(p>=1&&p<=total)chosen.add(p-1);}}
  return [...chosen].sort((a,b)=>a-b);
}

async function applyPageSelection(bytes,selection){const source=await PDFDocument.load(bytes);const indices=selectedPageIndices(source.getPageCount(),selection);if(!indices.length)throw new Error('Không có trang hợp lệ trong lựa chọn hiện tại');if(indices.length===source.getPageCount()&&(selection.mode||'all')==='all')return bytes;const out=await PDFDocument.create();const pages=await out.copyPages(source,indices);pages.forEach(p=>out.addPage(p));return out.save();}

async function buildPreviewPdf(sourcePath,settings={}) {
  const extension=path.extname(sourcePath).toLowerCase();const pageSize=PAGE_SIZES_PT[settings.pageSize]?settings.pageSize:'A4';const landscape=Boolean(settings.landscape);const scaleFactor=Math.min(200,Math.max(50,Number(settings.scaleFactor)||95));let bytes;
  if(extension==='.pdf') bytes=await reflowPdf(await fs.readFile(sourcePath),{landscape,pageSize,scaleFactor});
  else {
    let html=await fs.readFile(sourcePath,'utf8');const dimensions={A4:['210mm','297mm'],A5:['148mm','210mm'],Letter:['8.5in','11in']}[pageSize];const width=landscape?dimensions[1]:dimensions[0],height=landscape?dimensions[0]:dimensions[1];const css=`<style>@page{size:${width} ${height};margin:5mm}@media print{html,body{margin:0!important;padding:0!important}body{zoom:${scaleFactor}%}}</style>`;html=html.includes('</head>')?html.replace('</head>',css+'</head>'):css+html;const tempHtml=path.join(app.getPath('temp'),`his-preview-${crypto.randomUUID()}.html`);await fs.writeFile(tempHtml,html,'utf8');const worker=new BrowserWindow({show:false,webPreferences:{javascript:true,contextIsolation:true,nodeIntegration:false}});try{await worker.loadFile(tempHtml);bytes=await worker.webContents.printToPDF({printBackground:true,landscape,pageSize,preferCSSPageSize:true});}finally{if(!worker.isDestroyed())worker.destroy();try{await fs.unlink(tempHtml);}catch{}}}
  return Buffer.from(await applyPageSelection(bytes,settings.pageSelection||{mode:'all'}));
}

async function getPrintersCached(force=false) {
  const now=Date.now();
  if (!force && printerCache.items.length && printerCache.expiresAt > now) return printerCache.items;
  if (!mainWindow || mainWindow.isDestroyed()) return printerCache.items;
  const items=await mainWindow.webContents.getPrintersAsync();
  printerCache={items,expiresAt:now+30000};
  return items;
}

async function getPrinterDuplexCapability(printerName) {
  const name=String(printerName||'').trim();
  if (!name) return {found:false,supported:null,message:'Chưa chọn máy in'};
  if (duplexCapabilityCache.has(name)) return duplexCapabilityCache.get(name);
  if (process.platform !== 'win32') return {found:false,supported:null,message:'Chỉ kiểm tra duplex trên Windows'};
  const script=`$name=$args[0]; $printer=Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $name } | Select-Object -First 1; if ($null -eq $printer) { @{found=$false;supported=$null} | ConvertTo-Json -Compress; exit }; $caps=@($printer.Capabilities); $known=$null -ne $printer.Capabilities; @{found=$true;supported=$(if($known){$caps -contains 3}else{$null})} | ConvertTo-Json -Compress`;
  try {
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script,name],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});
    const parsed=JSON.parse(String(stdout||'{}').trim()||'{}');
    const result={found:Boolean(parsed.found),supported:typeof parsed.supported==='boolean'?parsed.supported:null};
    duplexCapabilityCache.set(name,result);
    return result;
  } catch (error) {
    return {found:false,supported:null,message:`Không kiểm tra được duplex: ${error.message}`};
  }
}

async function warmPrintEngine() {
  const moduleEntry=require.resolve('pdf-to-printer');
  const executable=path.join(path.dirname(moduleEntry),'SumatraPDF-3.4.6-32.exe')
    .replace('app.asar','app.asar.unpacked');
  // Read once in the background. This primes the Windows file/antivirus cache
  // before the first real print starts; the bytes are not retained.
  await fs.readFile(executable);
}

function createWindow({ show = true } = {}) {
  const appIcon = path.join(__dirname, 'assets', 'logo-vnpt.png');
  const win = new BrowserWindow({
    width: 980, height: 720, minWidth: 820, minHeight: 620,
    title: 'HIS Print Preview Pro',
    icon: appIcon,
    show,
    frame: false,
    kiosk: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    backgroundColor: '#f8fcff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Cửa sổ bị ẩn nhiều giờ vẫn phải vẽ lại ngay khi HIS gọi in
      backgroundThrottling: false
    }
  });
  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.setKiosk(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(APP_URL).catch(() => {});
  win.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
    if (!backgroundNoticeShown && tray && process.platform === 'win32') {
      backgroundNoticeShown = true;
      tray.displayBalloon({
        title:'A4 A5 Printer vẫn đang chạy',
        content:'Dịch vụ in tại 127.0.0.1:5756 đang chạy nền. Nhấp biểu tượng ở khay hệ thống để mở lại.',
        iconType:'info',
        noSound:true
      });
    }
  });
  win.on('hide', () => scheduleInstallIfIdle(1500));
  attachRendererRecovery(win);

  let firstLoad = true;
  // Dùng `on` thay vì `once`: sau khi form được nạp lại (tự phục hồi) vẫn phải
  // gửi lại phiên bản và tài liệu HIS đang chờ, nếu không form sẽ trống.
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('app-version', app.getVersion());
    resendActiveJob(win);
    if (!firstLoad) return;
    firstLoad = false;
    // Warm the printer cache while the UI is becoming ready so the first API
    // print does not have to wait for Windows to enumerate all drivers.
    getPrintersCached(true).catch(() => {});
    warmPrintEngine().catch(() => {});
  });
  return win;
}

function resendActiveJob(win) {
  if (!activeUiJobId) return;
  const job = printJobs.get(activeUiJobId);
  if (!job || !['awaiting_preview','awaiting_confirmation'].includes(job.status)) { activeUiJobId = null; return; }
  // Bản xem trước cũ gắn với phiên renderer trước; buộc tạo lại.
  if (job.status === 'awaiting_confirmation') { job.status = 'awaiting_preview'; job.previewReady = false; }
  win.webContents.send('incoming-document', publicPrintJob(job));
}

// ---------------------------------------------------------------------------
// Tự phục hồi khi form bị trắng (renderer crash, GPU reset, nạp trang lỗi...)
// ---------------------------------------------------------------------------
function attachRendererRecovery(win) {
  const wc = win.webContents;
  wc.on('render-process-gone', (_event, details) => {
    if (isQuitting) return;
    console.warn(`Renderer của form in bị dừng: ${details.reason} (${details.exitCode})`);
    setTimeout(() => recoverMainWindow(`render-process-gone:${details.reason}`), 500);
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // Bỏ qua lỗi của iframe xem trước PDF và lỗi -3 (điều hướng bị hủy)
    if (!isMainFrame || errorCode === -3 || isQuitting) return;
    console.warn(`Không nạp được form (${errorCode} ${errorDescription}) ${validatedURL}`);
    setTimeout(() => recoverMainWindow(`did-fail-load:${errorCode}`), 1500);
  });
  win.on('unresponsive', () => {
    if (unresponsiveTimer) return;
    // Cho renderer 10 giây để tự hồi; quá thời gian thì nạp lại form
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (win.isDestroyed()) return;
      try { wc.forcefullyCrashRenderer(); } catch {}
      recoverMainWindow('unresponsive');
    }, 10000);
  });
  win.on('responsive', () => {
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
  });
}

function recoverMainWindow(reason) {
  if (isQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow({ show:false }); return; }
  const now = Date.now();
  recoverHistory = recoverHistory.filter(time => now - time < 60000);
  recoverHistory.push(now);
  console.warn(`Đang phục hồi form in (${reason}), lần ${recoverHistory.length} trong 1 phút`);
  if (recoverHistory.length > 3) {
    // Nạp lại nhiều lần vẫn lỗi: hủy hẳn cửa sổ và tạo cửa sổ mới
    recoverHistory = [];
    const old = mainWindow;
    const wasVisible = old.isVisible();
    old.removeAllListeners('close');
    old.removeAllListeners('hide');
    mainWindow = null;
    old.destroy();
    createWindow({ show:wasVisible });
    return;
  }
  mainWindow.loadURL(APP_URL).catch(() => {});
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// Kiểm tra form có thực sự hiển thị các nút thao tác hay không
async function ensureRendererHealthy() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isCrashed()) return recoverMainWindow('crashed');
  if (wc.isLoading()) return;
  try {
    const healthy = await withTimeout(wc.executeJavaScript(
      "Boolean(document.body && document.getElementById('print') && document.getElementById('previewButton') && document.getElementById('exitForm') && window.printerAPI)", true), 4000);
    if (!healthy) recoverMainWindow('ui-missing');
    else wc.invalidate();
  } catch {
    recoverMainWindow('health-timeout');
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isKiosk()) mainWindow.setKiosk(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.show();
  mainWindow.focus();
  // Buộc vẽ lại sau thời gian dài ẩn và kiểm tra form còn nguyên vẹn
  mainWindow.webContents.invalidate();
  ensureRendererHealthy().catch(() => {});
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
}

function createTray() {
  if (tray || process.platform !== 'win32') return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo-vnpt.png')).resize({width:20,height:20});
  tray = new Tray(icon);
  tray.setToolTip(`A4 A5 Printer v${app.getVersion()} · API 127.0.0.1:${LOCAL_PORT}`);
  refreshTrayMenu();
  tray.on('click',showMainWindow);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label:'Mở A4 A5 Printer', click:showMainWindow },
    { type:'separator' },
    { label:'📱 Scan mobile (chụp ảnh từ điện thoại)', click:() => { hideMainWindow(); scanMobile.openScanMobile().catch(error => console.error('Scan mobile:', error)); } },
    { label:'👆 Quét vân tay', submenu:fingerprint.buildFingerprintMenu({ beforeOpenWindow:hideMainWindow }) },
    { type:'separator' },
    { label:'Kiểm tra cập nhật', click:() => startBackgroundUpdateCheck(true) },
    { type:'separator' },
    { label:'Thoát hoàn toàn', click:() => { isQuitting=true; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setClosable(true); app.quit(); } }
  ]));
}

function configureWindowsAutoStart() {
  // Chỉ đăng ký ở bản Windows đã đóng gói. Khi chạy source bằng `npm start`,
  // Electron.exe không bị thêm nhầm vào danh sách Startup của người dùng.
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: ['--autostart']
    });
  } catch (error) {
    console.warn(`Không cấu hình được tự khởi động cùng Windows: ${error.message}`);
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance',showMainWindow);
  app.whenReady().then(async () => {
    configureWindowsAutoStart();
    await startLocalServer();
    createTray();
    createWindow();
    // Dịch vụ vân tay (API 127.0.0.1:18622) chạy nền cùng PrintAgent
    fingerprint.startFingerprintService({ onChange:refreshTrayMenu }).catch(error => console.error('Fingerprint:', error));
    // Auto update chạy ngầm: không phụ thuộc form, kiểm tra khi khởi động và định kỳ
    setTimeout(() => startBackgroundUpdateCheck(false), 5000);
    setInterval(() => startBackgroundUpdateCheck(false), UPDATE_INTERVAL_MS).unref();
    // Sau sleep/khóa máy, kiểm tra lại form để không bị trắng khi mở ra
    powerMonitor.on('resume', () => setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) ensureRendererHealthy().catch(() => {});
    }, 2000));
    powerMonitor.on('unlock-screen', () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) ensureRendererHealthy().catch(() => {});
    });
  });
}
app.on('child-process-gone', (_event, details) => {
  if (isQuitting || details.type !== 'GPU') return;
  console.warn(`Tiến trình GPU bị dừng: ${details.reason}`);
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.invalidate();
    if (mainWindow.isVisible()) ensureRendererHealthy().catch(() => {});
  }, 1500);
});
app.on('before-quit', () => { isQuitting=true; });
app.on('will-quit', () => { fingerprint.stopFingerprintService().catch(() => {}); });
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (!tray) app.quit();
});

ipcMain.handle('choose-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn tài liệu cần in', properties: ['openFile'], filters: [
      { name: 'Tài liệu hỗ trợ', extensions: ['pdf','html','htm','doc','docx','xls','xlsx','png','jpg','jpeg'] },
      { name: 'Tất cả file', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('printers', async () => getPrintersCached(true));
ipcMain.handle('printer-duplex-capability', (_event, printerName) => getPrinterDuplexCapability(printerName));
function sendUpdateStatus(type, message, percent) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { type, message, percent });
}

// ---------------------------------------------------------------------------
// Auto update chạy ngầm
// - Khi người dùng bấm "Kiểm tra cập nhật": đóng (ẩn) form in, kiểm tra/tải ngầm,
//   báo tiến trình bằng thông báo khay hệ thống.
// - Không bật hộp thoại modal lên cửa sổ kiosk (hộp thoại bị che phía sau cửa sổ
//   luôn-trên-cùng, khóa toàn bộ form -> không bấm được nút nào).
// - Tải xong: tự cài im lặng khi form đang ẩn và không có lệnh in đang chạy;
//   nếu người dùng đang thao tác thì chờ tới khi đóng form rồi mới cài.
// ---------------------------------------------------------------------------
function notifyTray(title, content) {
  if (tray && !tray.isDestroyed() && process.platform === 'win32') {
    try { tray.displayBalloon({ title, content, iconType:'info', noSound:true }); } catch {}
  }
}

function startBackgroundUpdateCheck(manual = false) {
  if (manual) hideMainWindow();
  configureAutoUpdate(manual).catch(() => {});
  return { ok:true, background:true };
}

async function configureAutoUpdate(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      sendUpdateStatus('info', 'Auto update chỉ hoạt động trên bản đã đóng gói .exe.');
      notifyTray('A4 A5 Printer', 'Auto update chỉ hoạt động trên bản đã đóng gói .exe.');
    }
    return;
  }
  if (manual) updateCheckManual = true;
  if (pendingUpdateVersion) {
    if (manual) notifyTray('A4 A5 Printer', `Phiên bản ${pendingUpdateVersion} đã tải xong, sẽ tự cài khi không có lệnh in.`);
    scheduleInstallIfIdle(1000);
    return;
  }
  if (updateCheckInProgress) {
    if (manual) notifyTray('A4 A5 Printer', 'Đang kiểm tra/tải bản cập nhật trong nền...');
    return;
  }
  updateCheckInProgress = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  sendUpdateStatus('checking', 'Đang kiểm tra bản cập nhật...');
  if (manual) notifyTray('A4 A5 Printer', 'Đang kiểm tra bản cập nhật trong nền. Form in đã được đóng.');
  try { await autoUpdater.checkForUpdates(); }
  catch (error) {
    updateCheckInProgress = false;
    sendUpdateStatus('error', `Không kiểm tra được cập nhật: ${error.message}`);
    if (updateCheckManual) notifyTray('Không kiểm tra được cập nhật', error.message);
    updateCheckManual = false;
  }
}

function hasBusyPrintJob() {
  for (const job of printJobs.values()) if (['queued','processing'].includes(job.status)) return true;
  return false;
}

function scheduleInstallIfIdle(delay = 3000) {
  if (!pendingUpdateVersion || installScheduled || isQuitting) return;
  installScheduled = true;
  setTimeout(() => {
    installScheduled = false;
    if (!pendingUpdateVersion || isQuitting) return;
    const formVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    // Không tự cài khi đang in, đang chờ quét vân tay hoặc đang mở Scan mobile
    if (formVisible || hasBusyPrintJob() || fingerprint.isFingerprintBusy() || scanMobile.isScanMobileVisible()) {
      // Người dùng đang thao tác/in: thử lại sau, sự kiện 'hide' cũng sẽ kích hoạt lại
      setTimeout(() => scheduleInstallIfIdle(0), 60000).unref();
      return;
    }
    installDownloadedUpdate();
  }, delay).unref();
}

function installDownloadedUpdate() {
  sendUpdateStatus('installing', `Đang cài phiên bản ${pendingUpdateVersion}...`);
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setClosable(true);
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
  // isSilent=true: cài ngầm không hiện trình cài NSIS; isForceRunAfter=true: tự mở lại agent
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

autoUpdater.on('update-available', info => {
  sendUpdateStatus('downloading', `Đang tải phiên bản ${info.version}...`, 0);
  if (updateCheckManual) notifyTray('Có bản cập nhật mới', `Đang tải phiên bản ${info.version} trong nền...`);
});
autoUpdater.on('update-not-available', () => {
  updateCheckInProgress = false;
  sendUpdateStatus('ok', 'Bạn đang dùng phiên bản mới nhất.');
  if (updateCheckManual) notifyTray('A4 A5 Printer', `Bạn đang dùng phiên bản mới nhất (v${app.getVersion()}).`);
  updateCheckManual = false;
});
autoUpdater.on('download-progress', p => sendUpdateStatus('downloading', `Đang tải cập nhật ${Math.round(p.percent)}%`, Math.round(p.percent)));
autoUpdater.on('update-downloaded', info => {
  updateCheckInProgress = false;
  updateCheckManual = false;
  pendingUpdateVersion = info.version;
  sendUpdateStatus('ready', `Phiên bản ${info.version} đã sẵn sàng, sẽ tự cài khi không có lệnh in.`);
  notifyTray('Đã tải xong bản cập nhật', `Phiên bản ${info.version} sẽ tự cài đặt ngầm khi form in đóng và không có lệnh in.`);
  scheduleInstallIfIdle(3000);
});
autoUpdater.on('error', error => {
  updateCheckInProgress = false;
  sendUpdateStatus('error', `Lỗi cập nhật: ${error.message}`);
  if (updateCheckManual) notifyTray('Lỗi cập nhật', error.message);
  updateCheckManual = false;
});
ipcMain.handle('check-update', () => startBackgroundUpdateCheck(true));

function sendPrintProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('print-progress', message);
}

async function executePrint(options,onProgress=sendPrintProgress) {
  const startedAt=Date.now();
  if (!isSupported(options.filePath)) return {ok:false,error:'Định dạng tài liệu chưa được hỗ trợ',durationMs:Date.now()-startedAt};
  const result=await printDocument(options,onProgress);
  return {...result,durationMs:Date.now()-startedAt};
}

async function executeDirectPdfPrint(options,onProgress=sendPrintProgress) {
  const startedAt=Date.now();
  const extension=path.extname(options.filePath).toLowerCase();
  let printablePath=options.filePath;
  let generatedPdf=null;
  if (extension === '.html' || extension === '.htm') {
    onProgress('Đang tạo PDF từ HTML theo bố cục gốc...');
    const worker=new BrowserWindow({show:false,webPreferences:{javascript:true,contextIsolation:true,nodeIntegration:false}});
    try {
      await worker.loadFile(options.filePath);
      const bytes=await worker.webContents.printToPDF({printBackground:true,preferCSSPageSize:true,margins:{top:0,bottom:0,left:0,right:0}});
      generatedPdf=path.join(app.getPath('temp'),`his-html-print-${crypto.randomUUID()}.pdf`);
      await fs.writeFile(generatedPdf,bytes);
      printablePath=generatedPdf;
    } finally { if (!worker.isDestroyed()) worker.destroy(); }
  } else if (extension !== '.pdf') return {ok:false,error:'Chỉ hỗ trợ PDF, HTML hoặc HTM'};
  onProgress('Đang gửi tài liệu tới Windows Print Spooler...');
  const side=['duplex','duplexshort','duplexlong'].includes(options.duplexMode)?options.duplexMode:'simplex';
  try { await print(printablePath,{printer:options.deviceName,copies:Number(options.copies)||1,scale:'noscale',side,silent:true}); }
  finally { if (generatedPdf) { try { await fs.unlink(generatedPdf); } catch {} } }
  return {ok:true,direct:true,durationMs:Date.now()-startedAt};
}

function publicPrintJob(job) {
  return {
    jobId:job.jobId,
    status:job.status,
    message:job.message,
    progress:job.progress,
    deviceName:job.deviceName,
    targetSize:job.targetSize,
    copies:job.copies,
    pageSelection:job.pageSelection,
    originalName:job.originalName || null,
    initialSettings:job.initialSettings || null,
    createdAt:job.createdAt,
    startedAt:job.startedAt || null,
    finishedAt:job.finishedAt || null,
    submittedToSpooler:Boolean(job.submittedToSpooler),
    result:job.result || null,
    error:job.error || null
  };
}

function enqueuePrintJob(options,metadata,existingJob=null) {
  const jobId=existingJob ? existingJob.jobId : crypto.randomUUID();
  const job={
    jobId,
    status:'queued',
    message:'Đã tiếp nhận yêu cầu in',
    progress:'Đang chờ xử lý...',
    createdAt:new Date().toISOString(),
    submittedToSpooler:false,
    ...metadata,
    ...(existingJob || {})
  };
  printJobs.set(jobId,job);

  const run=async()=>{
    job.status='processing';
    job.message='Đang xử lý tài liệu và gửi tới máy in';
    job.startedAt=new Date().toISOString();
    try {
      const result=await executeDirectPdfPrint(options,message=>{
        job.progress=message;
        sendPrintProgress(message);
      });
      job.result=result;
      job.submittedToSpooler=Boolean(result.ok);
      job.status=result.ok ? 'success' : 'failed';
      job.message=result.ok ? 'Gửi lệnh in thành công' : 'Gửi lệnh in thất bại';
      if (!result.ok) job.error=result.error || 'Lỗi không xác định';
    } catch (error) {
      job.status='failed';
      job.message='Gửi lệnh in thất bại';
      job.error=error.message;
    } finally {
      job.finishedAt=new Date().toISOString();
      if (job.previewPath && job.previewPath !== job.filePath) { try { await fs.unlink(job.previewPath); } catch {} }
      job.previewPath=null;
      job.previewReady=false;
      if (job.status === 'success') { job.status='awaiting_preview'; job.message='Đã in xong; có thể xem trước và in tiếp'; }
      if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
      job.cleanupTimer=setTimeout(async()=>{if(!job.localFile){try{await fs.unlink(job.filePath);}catch{}}printJobs.delete(jobId);},60*60*1000);
      job.cleanupTimer.unref();
    }
  };
  const task=printQueue.then(run,run);
  printQueue=task;
  job.completion=task.then(()=>publicPrintJob(job));
  return job;
}

function createPreviewJob(filePath,metadata={}) {
  const jobId=crypto.randomUUID();
  const job={jobId,status:'awaiting_preview',message:'Đang chờ tạo bản xem trước',progress:'Hãy bấm Xem trước thực tế',createdAt:new Date().toISOString(),submittedToSpooler:false,filePath,previewReady:false,previewPath:null,...metadata};
  printJobs.set(jobId,job);
  activeUiJobId=jobId;
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('incoming-document',publicPrintJob(job));
  return job;
}

function sendPrintFailure(res,httpStatus,error,extra={}) {
  return res.status(httpStatus).json({
    ok:false,
    status:'failed',
    submittedToSpooler:false,
    message:'Gửi lệnh in thất bại',
    error:String(error || 'Lỗi không xác định'),
    ...extra
  });
}

ipcMain.handle('print-pdf', (_event, options) => executeDirectPdfPrint(options));
ipcMain.handle('create-preview', (_event, options) => {
  const extension=path.extname(options && options.filePath || '').toLowerCase();
  if (!['.pdf','.html','.htm'].includes(extension)) throw new Error('Vui lòng chọn file PDF, HTML hoặc HTM');
  return publicPrintJob(createPreviewJob(options.filePath,{deviceName:options.deviceName||'',copies:Number(options.copies)||1,originalName:path.basename(options.filePath),localFile:true}));
});
ipcMain.handle('generate-job-preview', async (_event, request) => {
  const jobId=typeof request==='string'?request:request.jobId;
  const settings=typeof request==='string'?{}:(request.settings||{});
  const job=printJobs.get(jobId);
  if (!job || !['awaiting_preview','awaiting_confirmation','success'].includes(job.status)) throw new Error('Tài liệu không còn hiệu lực');
  if (job.cleanupTimer) { clearTimeout(job.cleanupTimer); job.cleanupTimer=null; }
  if (job.previewPath && job.previewPath !== job.filePath) { try { await fs.unlink(job.previewPath); } catch {} }
  const bytes=await buildPreviewPdf(job.filePath,settings);
  job.previewPath=path.join(app.getPath('temp'),`his-preview-${crypto.randomUUID()}.pdf`);
  await fs.writeFile(job.previewPath,bytes);
  job.previewSignature=String(request.signature||'');
  job.previewSettings=settings;
  job.previewReady=true; job.status='awaiting_confirmation'; job.message='Đã tạo bản xem trước; đang chờ xác nhận in';
  return {...publicPrintJob(job),previewUrl:`/api/preview/${job.jobId}?v=${Date.now()}`};
});
ipcMain.handle('confirm-preview', async (_event, options) => {
  const job=printJobs.get(options.jobId);
  if (!job || job.status !== 'awaiting_confirmation' || !job.previewReady || !job.previewPath) throw new Error('Phải tạo và kiểm tra bản xem trước trước khi in');
  if (String(options.signature||'') !== String(job.previewSignature||'')) throw new Error('Cấu hình đã thay đổi; vui lòng xem trước lại');
  const requestedDuplex=['duplex','duplexshort','duplexlong'].includes(options.duplexMode)?options.duplexMode:'simplex';
  let duplexMode='simplex';
  if (requestedDuplex!=='simplex') {
    if ((job.previewSettings&&job.previewSettings.pageSelection&&job.previewSettings.pageSelection.mode)!=='all') throw new Error('In hai mặt chỉ áp dụng khi chọn Tất cả trang');
    duplexMode=requestedDuplex;
  }
  const queuedJob=enqueuePrintJob({filePath:job.previewPath,deviceName:options.deviceName||job.deviceName,copies:Number(options.copies)||job.copies||1,duplexMode},{deviceName:options.deviceName||job.deviceName,copies:Number(options.copies)||job.copies||1,duplexMode,originalName:job.originalName,localFile:job.localFile,sourceFilePath:job.filePath},job);
  const completed=await queuedJob.completion;
  if (completed.status==='failed') throw new Error(completed.error||'Lệnh in không hoàn tất');
  if (completed.status!=='awaiting_preview') throw new Error('Tác vụ in chưa sẵn sàng để xem trước lần tiếp theo');
  return completed;
});
ipcMain.handle('exit-form', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); return {ok:true}; });
ipcMain.handle('export-preview-pdf', async (_event, jobId) => {
  const job=printJobs.get(jobId);
  if (!job || !job.previewReady || !job.previewPath) throw new Error('Hãy tạo bản xem trước trước khi xuất PDF');
  const baseName=path.parse(job.originalName || 'tai-lieu').name.replace(/[<>:"/\\|?*\x00-\x1F]/g,'_');
  const result=await dialog.showSaveDialog(mainWindow,{title:'Xuất bản PDF đã xem trước',defaultPath:path.join(app.getPath('documents'),`${baseName}-preview.pdf`),filters:[{name:'PDF',extensions:['pdf']}]});
  if (result.canceled || !result.filePath) return {ok:false,canceled:true};
  await fs.copyFile(job.previewPath,result.filePath);
  return {ok:true,filePath:result.filePath};
});
ipcMain.handle('cancel-preview', async (_event, jobId) => {
  const job=printJobs.get(jobId);
  if (!job || !['awaiting_preview','awaiting_confirmation'].includes(job.status)) return {ok:false};
  job.status='cancelled'; job.message='Đã hủy lệnh in'; job.finishedAt=new Date().toISOString();
  if (activeUiJobId===jobId) activeUiJobId=null;
  if (job.previewPath && job.previewPath !== job.filePath) { try { await fs.unlink(job.previewPath); } catch {} }
  if (!job.localFile) { try { await fs.unlink(job.filePath); } catch {} }
  return {ok:true};
});

async function startLocalServer() {
  const web = express();
  const uploadDir = path.join(app.getPath('temp'), 'a4-a5-printer-uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req,_file,callback) => callback(null,uploadDir),
    filename: (_req,file,callback) => {
      const originalExtension = path.extname(file.originalname).toLowerCase();
      const extension = isSupported(`upload${originalExtension}`) ? originalExtension : UPLOAD_MIME_EXTENSION[file.mimetype];
      callback(null,`${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => callback(null,
      isSupported(file.originalname) || Boolean(UPLOAD_MIME_EXTENSION[file.mimetype])
    )
  });

  web.use((req, res, next) => {
    const origin = req.headers.origin;
    const localOrigins = [`http://${LOCAL_HOST}:${LOCAL_PORT}`, `http://localhost:${LOCAL_PORT}`];
    const configuredOrigins = String(process.env.A4A5_ALLOWED_ORIGINS || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    const isVnptHisOrigin = /^https:\/\/([a-z0-9-]+\.)*vnpthis\.vn(?::\d+)?$/i.test(origin || '');
    const originAllowed = !origin || localOrigins.includes(origin) || configuredOrigins.includes(origin) || isVnptHisOrigin;
    if (!originAllowed) return res.status(403).json({ ok:false, error:'Nguồn gọi API không được phép' });

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers'] || 'Content-Type, Accept');
      res.setHeader('Access-Control-Max-Age','600');
      // Chrome may preflight HTTPS -> loopback requests as Local Network Access.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network','true');
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  web.get('/api/health', (_req, res) => res.json({ ok:true, service:'A4 A5 Print Agent', version:app.getVersion(), port:LOCAL_PORT }));
  web.get('/api/printers', async (_req, res) => {
    try { res.json({ ok:true, printers:await getPrintersCached(true) }); }
    catch (error) { res.status(500).json({ ok:false, error:error.message }); }
  });
  web.post('/api/update', async (_req, res) => {
    startBackgroundUpdateCheck(true);
    res.json({ ok:true, message:'Đã bắt đầu kiểm tra cập nhật ngầm trên Print Agent.' });
  });
  web.get('/api/print', (_req, res) => res.json({
    ok:true,
    endpoint:`http://${LOCAL_HOST}:${LOCAL_PORT}/api/print`,
    method:'POST',
    contentType:'multipart/form-data',
    fields:{
      document:'File PDF, HTML hoặc HTM (bắt buộc)',
      targetSize:'Giữ để tương thích; không còn auto-scale',
      copies:'Số nguyên 1-99, mặc định 1',
      pages:'all | odd | even, mặc định all',
      reverse:'true | false, đảo ngược thứ tự trang',
      rotateBackSide:'true | false, xoay nội dung mặt sau 180 độ',
      deviceName:'Tùy chọn; bỏ trống để dùng máy in mặc định',
      color:'true | false, mặc định true'
    },
    response:'Trả HTTP 202 ở trạng thái awaiting_confirmation; phải xem trước và xác nhận trước khi in.',
    message:'Endpoint hoạt động. Hãy gửi POST kèm FormData để mở bản xem trước.'
  }));
  web.get('/api/print/:jobId', (req, res) => {
    const job=printJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ok:false,error:'Không tìm thấy job in hoặc job đã hết thời gian lưu'});
    res.json({ok:true,...publicPrintJob(job)});
  });
  web.get('/api/preview/:jobId', (req,res) => {
    const job=printJobs.get(req.params.jobId);
    if (!job || !job.previewReady || !job.previewPath) return res.sendStatus(404);
    res.type('application/pdf').sendFile(path.resolve(job.previewPath));
  });
  web.post('/api/print', upload.single('document'), async (req, res) => {
    if (!req.file) return sendPrintFailure(res,400,'Thiếu tài liệu hoặc định dạng chưa được hỗ trợ');
    let handedOff=false;
    try {
      let printers = await getPrintersCached();
      const requestedPrinter = String(req.body.deviceName || '').trim();
      let printer = requestedPrinter
        ? printers.find(item => item.name === requestedPrinter)
        : printers.find(item => item.isDefault) || printers[0];
      if (requestedPrinter && !printer) {
        printers=await getPrintersCached(true);
        printer=printers.find(item => item.name === requestedPrinter);
      }
      if (!printer) throw new Error(requestedPrinter ? 'Không tìm thấy driver máy in đã chọn' : 'Không có máy in khả dụng');

      const targetSize = String(req.body.targetSize || '').toUpperCase();
      if (targetSize && !['A4','A5'].includes(targetSize)) {
        return sendPrintFailure(res,400,'targetSize chỉ nhận A4 hoặc A5');
      }
      if (!['.pdf','.html','.htm'].includes(path.extname(req.file.path).toLowerCase())) return sendPrintFailure(res,400,'Chế độ xem trước hỗ trợ PDF, HTML hoặc HTM');
      const copiesValue = Number(req.body.copies ?? 1);
      if (!Number.isInteger(copiesValue) || copiesValue < 1 || copiesValue > 99) {
        return sendPrintFailure(res,400,'copies phải là số nguyên từ 1 đến 99');
      }
      const pages = String(req.body.pages || 'all').toLowerCase();
      if (!['all','odd','even'].includes(pages)) {
        return sendPrintFailure(res,400,'pages chỉ nhận all, odd hoặc even');
      }
      const reverseRaw = String(req.body.reverse ?? (pages === 'odd' ? 'true' : 'false')).toLowerCase();
      if (!['true','false','1','0'].includes(reverseRaw)) {
        return sendPrintFailure(res,400,'reverse chỉ nhận true hoặc false');
      }
      const reverse = reverseRaw === 'true' || reverseRaw === '1';
      const rotateRaw = String(req.body.rotateBackSide ?? (pages === 'even' ? 'true' : 'false')).toLowerCase();
      if (!['true','false','1','0'].includes(rotateRaw)) {
        return sendPrintFailure(res,400,'rotateBackSide chỉ nhận true hoặc false');
      }
      const rotateBackSide = rotateRaw === 'true' || rotateRaw === '1';

      const job=createPreviewJob(req.file.path,{
        deviceName:printer.name,
        copies:copiesValue,
        pageSelection:pages,
        originalName:req.file.originalname,
        initialSettings:{pageSize:targetSize||'A4',landscape:String(req.body.landscape||'false')==='true',scaleFactor:Number(req.body.scaleFactor)||95,pageSelection:{mode:pages,customRange:String(req.body.customRange||'')}}
      });
      handedOff=true;
      res.status(202).json({
        ok:true,
        accepted:true,
        status:'awaiting_preview',
        submittedToSpooler:false,
        message:'Đã tiếp nhận tài liệu; đang chờ người dùng tạo bản xem trước',
        jobId:job.jobId,
        statusUrl:`http://${LOCAL_HOST}:${LOCAL_PORT}/api/print/${job.jobId}`,
        deviceName:printer.name,
        copies:copiesValue,
        pageSelection:pages
      });
    } catch (error) {
      sendPrintFailure(res,500,error.message);
    } finally {
      if (!handedOff) {
        try { await fs.unlink(req.file.path); } catch {}
      }
    }
  });
  web.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  web.get('/style.css', (_req, res) => res.sendFile(path.join(__dirname, 'style.css')));
  web.get('/renderer.js', (_req, res) => res.sendFile(path.join(__dirname, 'renderer.js')));
  web.use((error, req, res, next) => {
    if (req.path === '/api/print') {
      const message = error && error.code === 'LIMIT_FILE_SIZE'
        ? 'Tài liệu vượt quá dung lượng tối đa 50 MB'
        : error.message;
      return sendPrintFailure(res,400,message);
    }
    next(error);
  });
  await new Promise((resolve, reject) => {
    const server = web.listen(LOCAL_PORT, LOCAL_HOST, resolve);
    server.once('error', reject);
  });
}
