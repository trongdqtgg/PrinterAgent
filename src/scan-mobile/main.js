// Tich hop Scan Mobile vao PrintAgent: giu nguyen server upload, xu ly anh,
// xuat PDF va Cloudflare Tunnel. Chi thay doi phan khoi dong/cua so de chay
// nhu mot tinh nang mo tu menu khay cua PrintAgent (xem cuoi file).
const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { spawn } = require('child_process');
const cloudflare = require('cloudflared');
const PDFDocument = require('pdfkit');

let mainWindow;
const PORT = 3000;
let tunnelUrl = '';
let uploadDir = '';
let cloudflaredProcess = null;
let serverStarted = false;
let isQuitting = false;

// --- 1. Cấu hình Express Server ---
const expressApp = express();

expressApp.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
expressApp.use(bodyParser.json({ limit: '50mb' }));

expressApp.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Gửi ảnh về máy tính</title>
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                body { background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 15px; }
                .card { background: white; width: 100%; max-width: 450px; padding: 30px 20px; border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; }
                h2 { font-size: 24px; color: #1a73e8; margin-bottom: 25px; font-weight: 700; }
                
                .upload-label { display: block; background: #e8f0fe; border: 2px dashed #1a73e8; border-radius: 12px; padding: 30px 20px; cursor: pointer; margin-bottom: 20px; transition: 0.2s; }
                .upload-label:active { background: #d2e3fc; }
                .upload-icon { font-size: 48px; margin-bottom: 10px; }
                .upload-text { font-size: 18px; color: #1a73e8; font-weight: 600; }
                .upload-subtext { font-size: 13px; color: #666; margin-top: 5px; }

                input[type="file"] { display: none; }

                button.submit-btn { background: #1a73e8; color: white; border: none; width: 100%; padding: 16px; border-radius: 12px; font-size: 18px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(26, 115, 232, 0.3); transition: 0.2s; }
                button.submit-btn:active { background: #1557b0; }
                button.submit-btn:disabled { background: #ccc; cursor: not-allowed; box-shadow: none; }

                #preview-container { margin-bottom: 20px; display: none; }
                #preview-img { width: 100%; max-height: 250px; object-fit: contain; border-radius: 8px; border: 1px solid #ddd; background: #000; }
                
                .loading { display: none; font-size: 16px; color: #555; margin-top: 15px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>📸 Gửi ảnh về Desktop</h2>
                <form id="upload-form" action="/upload" method="POST">
                    <label class="upload-label" id="label-box">
                        <div class="upload-icon">📁</div>
                        <div class="upload-text" id="label-text">Chạm để chọn hoặc chụp ảnh</div>
                        <div class="upload-subtext">Hỗ trợ tự động nén nhẹ để gửi nhanh</div>
                        <input type="file" id="image-input" accept="image/*" capture="environment" required>
                    </label>

                    <div id="preview-container">
                        <img id="preview-img" src="" alt="Xem trước">
                        <p style="font-size: 13px; color: #28a745; margin-top: 8px; font-weight: 600;" id="file-size-info"></p>
                    </div>

                    <input type="hidden" name="compressedImage" id="compressed-image">
                    
                    <button type="submit" class="submit-btn" id="submit-btn" disabled>🚀 Tải lên ngay</button>
                    <div class="loading" id="loading-text">⏳ Đang xử lý và gửi ảnh...</div>
                </form>
            </div>

            <script>
                const imageInput = document.getElementById('image-input');
                const previewContainer = document.getElementById('preview-container');
                const previewImg = document.getElementById('preview-img');
                const submitBtn = document.getElementById('submit-btn');
                const labelText = document.getElementById('label-text');
                const uploadForm = document.getElementById('upload-form');
                const loadingText = document.getElementById('loading-text');
                const compressedInput = document.getElementById('compressed-image');
                const fileSizeInfo = document.getElementById('file-size-info');

                imageInput.addEventListener('change', function(e) {
                    const file = e.target.files[0];
                    if (!file) return;

                    labelText.innerText = "Đã chọn ảnh (Chạm để đổi ảnh khác)";
                    
                    const reader = new FileReader();
                    reader.onload = function(event) {
                        const img = new Image();
                        img.onload = function() {
                            const maxWidth = 1280;
                            const maxHeight = 1280;
                            let width = img.width;
                            let height = img.height;

                            if (width > height) {
                                if (width > maxWidth) {
                                    height *= maxWidth / width;
                                    width = maxWidth;
                                }
                            } else {
                                if (height > maxHeight) {
                                    width *= maxHeight / height;
                                    height = maxHeight;
                                }
                            }

                            const canvas = document.createElement('canvas');
                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);

                            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                            
                            previewImg.src = dataUrl;
                            previewContainer.style.display = 'block';
                            compressedInput.value = dataUrl;
                            submitBtn.disabled = false;

                            const head = 'data:image/jpeg;base64,';
                            const fileSizeCalc = Math.round((dataUrl.length - head.length) * 3 / 4 / 1024);
                            fileSizeInfo.innerText = \`Dung lượng sau nén: ~ \${fileSizeCalc} KB\`;
                        }
                        img.src = event.target.result;
                    }
                    reader.readAsDataURL(file);
                });

                uploadForm.addEventListener('submit', function() {
                    submitBtn.style.display = 'none';
                    loadingText.style.display = 'block';
                });
            </script>
        </body>
        </html>
    `);
});

expressApp.post('/upload', (req, res) => {
    const compressedData = req.body.compressedImage;
    if (!compressedData) return res.status(400).send('Không có dữ liệu ảnh!');

    try {
        const matches = compressedData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).send('Dữ liệu ảnh không hợp lệ!');
        }

        const imageBuffer = Buffer.from(matches[2], 'base64');
        const uniqueFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}.jpg`;
        const filePath = path.join(uploadDir, uniqueFileName);

        fs.writeFileSync(filePath, imageBuffer);

        if (mainWindow) {
            mainWindow.webContents.send('image-received', filePath);
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="vi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Tải lên thành công</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; margin: 0; text-align: center; }
                    .card { background: white; width: 100%; max-width: 400px; padding: 40px 20px; border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
                    h3 { color: #28a745; font-size: 24px; margin-bottom: 15px; }
                    p { color: #555; font-size: 16px; margin-bottom: 30px; }
                    .back-btn { display: inline-block; background: #1a73e8; color: white; text-decoration: none; padding: 14px 30px; border-radius: 12px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 10px rgba(26, 115, 232, 0.3); transition: 0.2s; }
                    .back-btn:active { background: #1557b0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h3>🎉 Gửi ảnh thành công!</h3>
                    <p>Ảnh của bạn đã được chuyển về máy tính lập tức.</p>
                    <a href="/" class="back-btn">📸 Gửi thêm ảnh khác</a>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Lỗi lưu file: ' + err.message);
    }
});

// --- Hàm khởi tạo Cloudflare Tunnel ---
function startCloudflareTunnel() {
    try {
        if (cloudflaredProcess) {
            cloudflaredProcess.kill();
        }

        cloudflaredProcess = spawn(getCloudflaredBin(), ['tunnel', '--url', `http://localhost:${PORT}`], { windowsHide: true });

        cloudflaredProcess.stderr.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
            if (match) {
                tunnelUrl = match[0];
                console.log(`Cloudflare Tunnel active at: ${tunnelUrl}`);
                if (mainWindow) {
                    mainWindow.webContents.send('tunnel-url', tunnelUrl);
                }
            }
        });

        cloudflaredProcess.on('error', (err) => {
            console.error('Lỗi khi chạy cloudflared:', err);
        });
    } catch (err) {
        console.error('Không thể khởi tạo Cloudflare Tunnel:', err);
    }
}

// Ban dong goi: file exe cua cloudflared nam trong app.asar.unpacked (khong
// chay truc tiep duoc tu trong app.asar). Neu chua co, tai ve thu muc userData.
function getCloudflaredBin() {
    const packagedBin = cloudflare.bin.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(packagedBin)) return packagedBin;
    return path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

async function ensureCloudflaredInstalled() {
    const bin = getCloudflaredBin();
    if (fs.existsSync(bin)) return;
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    console.log('Dang tai cloudflared ve', bin);
    await cloudflare.install(bin);
}

// --- 2. Xử lý ảnh và xuất PDF ---

ipcMain.handle('delete-image', async (event, filePath) => {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

ipcMain.handle('save-rotated-image', async (event, filePath, dataURL) => {
    try {
        const base64Data = dataURL.replace(/^data:image\/jpeg;base64,/, "");
        fs.writeFileSync(filePath, base64Data, 'base64');
        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

ipcMain.handle('export-to-pdf', async (event, imagePaths) => {
    try {
        if (!imagePaths || imagePaths.length === 0) {
            return { success: false, message: 'Không có ảnh nào trong danh sách để xuất PDF!' };
        }

        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Lưu file PDF',
            defaultPath: path.join(app.getPath('downloads'), `Danh_Sach_Anh_${Date.now()}.pdf`),
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
        });

        if (!filePath) return { success: false, message: 'Đã hủy lưu file.' };

        const doc = new PDFDocument({ size: 'A4', margin: 30 });
        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        const systemFontPath = 'C:\\Windows\\Fonts\\timesbd.ttf';
        const localFontPath = path.join(__dirname, 'timesbd.ttf');
        
        let activeFont = 'Helvetica-Bold';
        if (fs.existsSync(systemFontPath)) {
            doc.registerFont('TimesBold', systemFontPath);
            activeFont = 'TimesBold';
        } else if (fs.existsSync(localFontPath)) {
            doc.registerFont('TimesBold', localFontPath);
            activeFont = 'TimesBold';
        }

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const margin = 30;
        const topOffset = 35;

        for (let i = 0; i < imagePaths.length; i++) {
            const imgPath = imagePaths[i];
            if (fs.existsSync(imgPath)) {
                if (i > 0) doc.addPage();

                doc.image(imgPath, margin, margin + topOffset, {
                    fit: [pageWidth - (margin * 2), pageHeight - (margin * 2) - topOffset],
                    align: 'center',
                    valign: 'center'
                });

                const boxWidth = 140;
                const boxHeight = 22;
                const boxX = pageWidth - margin - boxWidth;
                const boxY = margin - 2;

                doc.save()
                   .strokeColor('red')
                   .lineWidth(1.5)
                   .rect(boxX, boxY, boxWidth, boxHeight)
                   .stroke()
                   .restore();

                doc.font(activeFont)
                   .fillColor('red')
                   .fontSize(11)
                   .text('SAO Y BẢN CHÍNH', boxX, boxY + 5, {
                       align: 'center',
                       width: boxWidth
                   });
            }
        }

        doc.end();

        return new Promise((resolve) => {
            writeStream.on('finish', () => {
                clipboard.writeText(filePath);
                resolve({ success: true, filePath });
            });
            writeStream.on('error', (err) => resolve({ success: false, message: err.message }));
        });

    } catch (err) {
        return { success: false, message: err.message };
    }
});

ipcMain.handle('regenerate-qr', async () => {
    tunnelUrl = '';
    startCloudflareTunnel();
    return { success: true };
});

ipcMain.handle('reset-all', async () => {
    try {
        if (fs.existsSync(uploadDir)) {
            const files = fs.readdirSync(uploadDir);
            for (const file of files) {
                fs.unlinkSync(path.join(uploadDir, file));
            }
        }
        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// --- 3. Khởi tạo cửa sổ Electron ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 750,
        title: 'Scan Mobile - Chụp ảnh từ điện thoại',
        icon: path.join(__dirname, '..', 'assets', 'logo-vnpt.png'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.on('did-finish-load', () => {
        if (tunnelUrl) {
            mainWindow.webContents.send('tunnel-url', tunnelUrl);
        }
    });

    // Dong cua so = an xuong khay, giu nguyen danh sach anh va link QR.
    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        mainWindow.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
}

// Khoi dong server + tunnel o lan mo dau tien (khong chay khi chua can dung)
async function startScanMobileService() {
    if (serverStarted) return;
    serverStarted = true;

    uploadDir = path.join(app.getPath('userData'), 'uploads');
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const server = expressApp.listen(PORT, () => {
        console.log(`Local server running on port ${PORT}`);
    });
    // Khong de loi cong 3000 bi chiem lam sap ca PrintAgent
    server.on('error', (err) => {
        console.error(`Scan Mobile khong mo duoc cong ${PORT}:`, err.message);
        dialog.showErrorBox('Scan Mobile', `Không mở được cổng ${PORT}: ${err.message}\nHãy tắt ứng dụng Scan Mobile cũ hoặc chương trình đang dùng cổng này.`);
        serverStarted = false;
    });

    try {
        await ensureCloudflaredInstalled();
    } catch (err) {
        console.error('Khong tai duoc cloudflared:', err);
    }
    startCloudflareTunnel();
}

/** Mo cua so Scan Mobile tu menu khay cua PrintAgent. */
async function openScanMobile() {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    await startScanMobileService();
}

function isScanMobileVisible() {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
    if (cloudflaredProcess) {
        try { cloudflaredProcess.kill(); } catch {}
        cloudflaredProcess = null;
    }
});

module.exports = { openScanMobile, isScanMobileVisible };
