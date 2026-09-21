const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const multer = require('multer');
const { print } = require('pdf-to-printer');
const { PDFDocument } = require('pdf-lib');
const { printDocument, isSupported } = require('./document-pipeline');

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
let printQueue=Promise.resolve();
const printJobs=new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const PAGE_SIZES_PT={A4:{width:595.28,height:841.89},A5:{width:419.53,height:595.28},Letter:{width:612,height:792}};
const PREVIEW_MARGIN_PT=14.17;

async function reflowPdf(sourceBytes,{landscape,pageSize,scaleFactor}) {
  const srcDoc=await PDFDocument.load(sourceBytes); const outDoc=await PDFDocument.create();
  const base=PAGE_SIZES_PT[pageSize]||PAGE_SIZES_PT.A4;
  let targetW=base.width,targetH=base.height;if(landscape)[targetW,targetH]=[targetH,targetW];
  const userScale=Math.min(2,Math.max(.5,(Number(scaleFactor)||100)/100));
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
  const extension=path.extname(sourcePath).toLowerCase();const pageSize=PAGE_SIZES_PT[settings.pageSize]?settings.pageSize:'A4';const landscape=Boolean(settings.landscape);const scaleFactor=Math.min(200,Math.max(50,Number(settings.scaleFactor)||100));let bytes;
  if(extension==='.pdf') bytes=await reflowPdf(await fs.readFile(sourcePath),{landscape,pageSize,scaleFactor});
  else {
    let html=await fs.readFile(sourcePath,'utf8');const dimensions={A4:['210mm','297mm'],A5:['148mm','210mm'],Letter:['8.5in','11in']}[pageSize];const width=landscape?dimensions[1]:dimensions[0],height=landscape?dimensions[0]:dimensions[1];const css=`<style>@page{size:${width} ${height};margin:5mm}@media print{html,body{margin:0!important;padding:0!important}body{zoom:${scaleFactor}%}}</style>`;html=html.includes('</head>')?html.replace('</head>',css+'</head>'):css+html;const tempHtml=path.join(app.getPath('temp'),`his-preview-${crypto.randomUUID()}.html`);await fs.writeFile(tempHtml,html,'utf8');const worker=new BrowserWindow({show:false,webPreferences:{javascript:true,contextIsolation:true,nodeIntegration:false}});try{await worker.loadFile(tempHtml);bytes=await worker.webContents.printToPDF({printBackground:true,landscape,pageSize,preferCSSPageSize:true});}finally{if(!worker.isDestroyed())worker.destroy();try{await fs.unlink(tempHtml);}catch{}}}
  return Buffer.from(await applyPageSelection(bytes,settings.pageSelection||{mode:'all'}));
}

async function getPrintersCached(force=false) {
  const now=Date.now();
  if (!force && printerCache.items.length && printerCache.expiresAt > now) return printerCache.items;
  const items=await mainWindow.webContents.getPrintersAsync();
  printerCache={items,expiresAt:now+30000};
  return items;
}

async function warmPrintEngine() {
  const moduleEntry=require.resolve('pdf-to-printer');
  const executable=path.join(path.dirname(moduleEntry),'SumatraPDF-3.4.6-32.exe')
    .replace('app.asar','app.asar.unpacked');
  // Read once in the background. This primes the Windows file/antivirus cache
  // before the first real print starts; the bytes are not retained.
  await fs.readFile(executable);
}

function createWindow() {
  const appIcon = path.join(__dirname, 'assets', 'logo-vnpt.png');
  mainWindow = new BrowserWindow({
    width: 980, height: 720, minWidth: 820, minHeight: 620,
    title: 'HIS Print Preview Pro',
    icon: appIcon,
    frame: false,
    kiosk: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setKiosk(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadURL(`http://${LOCAL_HOST}:${LOCAL_PORT}`);
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
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
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
    // Warm the printer cache while the UI is becoming ready so the first API
    // print does not have to wait for Windows to enumerate all drivers.
    getPrintersCached(true).catch(() => {});
    warmPrintEngine().catch(() => {});
    setTimeout(configureAutoUpdate, 3000);
  });
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
}

function createTray() {
  if (tray || process.platform !== 'win32') return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo-vnpt.png')).resize({width:20,height:20});
  tray = new Tray(icon);
  tray.setToolTip(`A4 A5 Printer v${app.getVersion()} · API 127.0.0.1:${LOCAL_PORT}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label:'Mở A4 A5 Printer', click:showMainWindow },
    { label:'Kiểm tra cập nhật', click:() => { showMainWindow(); configureAutoUpdate(true); } },
    { type:'separator' },
    { label:'Thoát hoàn toàn', click:() => { isQuitting=true; app.quit(); } }
  ]));
  tray.on('click',showMainWindow);
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
  });
}
app.on('before-quit', () => { isQuitting=true; });
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
function sendUpdateStatus(type, message, percent) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { type, message, percent });
}

async function configureAutoUpdate(manual = false) {
  if (!app.isPackaged) {
    if (manual) sendUpdateStatus('info', 'Auto update chỉ hoạt động trên bản đã đóng gói .exe.');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  sendUpdateStatus('checking', 'Đang kiểm tra bản cập nhật...');
  try { await autoUpdater.checkForUpdates(); }
  catch (error) { sendUpdateStatus('error', `Không kiểm tra được cập nhật: ${error.message}`); }
}

autoUpdater.on('update-available', info => sendUpdateStatus('downloading', `Đang tải phiên bản ${info.version}...`, 0));
autoUpdater.on('update-not-available', () => sendUpdateStatus('ok', 'Bạn đang dùng phiên bản mới nhất.'));
autoUpdater.on('download-progress', p => sendUpdateStatus('downloading', `Đang tải cập nhật ${Math.round(p.percent)}%`, Math.round(p.percent)));
autoUpdater.on('update-downloaded', async info => {
  sendUpdateStatus('ready', `Phiên bản ${info.version} đã sẵn sàng.`);
  const result = await dialog.showMessageBox(mainWindow, { type:'info', buttons:['Khởi động lại và cập nhật','Để sau'], defaultId:0, cancelId:1, title:'Có bản cập nhật', message:`Đã tải xong phiên bản ${info.version}.`, detail:'Ứng dụng sẽ khởi động lại để hoàn tất cập nhật.' });
  if (result.response === 0) autoUpdater.quitAndInstall(false, true);
});
autoUpdater.on('error', error => sendUpdateStatus('error', `Lỗi cập nhật: ${error.message}`));
ipcMain.handle('check-update', () => configureAutoUpdate(true));

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
  try { await print(printablePath,{printer:options.deviceName,copies:Number(options.copies)||1,scale:'noscale',silent:true}); }
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
  enqueuePrintJob({filePath:job.previewPath,deviceName:options.deviceName||job.deviceName,copies:Number(options.copies)||job.copies||1},{deviceName:options.deviceName||job.deviceName,copies:Number(options.copies)||job.copies||1,originalName:job.originalName,localFile:job.localFile,sourceFilePath:job.filePath},job);
  return await job.completion;
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
    configureAutoUpdate(true);
    res.json({ ok:true, message:'Đã bắt đầu kiểm tra cập nhật trên Print Agent.' });
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
        initialSettings:{pageSize:targetSize||'A4',landscape:String(req.body.landscape||'false')==='true',scaleFactor:Number(req.body.scaleFactor)||100,pageSelection:{mode:pages,customRange:String(req.body.customRange||'')}}
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
