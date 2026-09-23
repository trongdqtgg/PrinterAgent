# ZK Fingerprint Kiosk – Desktop (Windows)

Ứng dụng nền (chạy ngầm dưới khay hệ thống – system tray) cho Windows, kết nối máy quét vân
tay **ZKTeco ZK9500** và **ZK4500**, mở HTTP API tại `http://localhost:18622` với cùng định
dạng response như bản Android đã dùng.

## 1. API cung cấp

| Endpoint | Method | Mô tả |
|---|---|---|
| `/api/finger/check-connection` | GET | Kiểm tra & mở kết nối tới máy quét |
| `/api/finger/send-scan` | GET | Yêu cầu quét, chờ người dùng đặt ngón tay, trả ảnh vân tay |
| `/api/finger/status` | GET | (thêm) trạng thái nhanh, không gọi tới thiết bị |

Response `send-scan` (thành công, quét trực tiếp từ máy):
```json
{ "CODE": 0, "MESSAGE": "Lấy vân tay thành công", "RESULT": "<base64 PNG>", "SOURCE": "DEVICE_SCAN" }
```
Thất bại: `CODE` khác 0, `RESULT: null`, `MESSAGE` mô tả lỗi.

`check-connection` dùng cùng khung `{CODE, MESSAGE, RESULT}` với `RESULT` là `true/false`.

Thời gian chờ đặt ngón tay tối đa cho mỗi lần `send-scan`: **60 giây** (cấu hình trong
`src/device/deviceManager.js` / `src/device/zkfpNative.js`, tham số `captureRaw(60000)`).
Trong lúc chờ, service KHÔNG bị đơ — tray và các API khác vẫn phản hồi bình thường.

### 1.1 Chế độ nhập ảnh vân tay thủ công (khi HS thao tác sai, BN đã về)

Dành cho trường hợp nhân viên quên/thao tác sai lúc bệnh nhân còn ở đó, và bệnh nhân đã rời
đi nên không thể quay lại quét thật. Chuyển đổi qua **menu khay hệ thống**, mục "Nguồn lấy
vân tay" — 2 lựa chọn loại trừ nhau (radio):

- **"Máy quét vân tay (thiết bị thật)"** — mặc định. `send-scan` dùng máy ZK9500/ZK4500 thật.
- **"Dán ảnh vân tay thủ công..."** — chọn mục này sẽ tự ngắt kết nối máy quét thật và mở cửa
  sổ nhỏ để dán ảnh từ Clipboard (nút "Dán ảnh từ Clipboard") hoặc chọn file ảnh, **bắt buộc
  nhập lý do lấy ảnh vân tay thủ công**. Muốn dùng lại máy thật, chọn lại "Máy quét vân tay
  (thiết bị thật)".

Ở chế độ thủ công, `send-scan` **chờ (poll) tối đa 60 giây** để nhân viên dán/lưu ảnh — giống
hệt hành vi chờ đặt ngón tay của máy thật, để phía client (HIS) không cần phân biệt 2 chế độ.
Nếu quá 60s chưa có ảnh nào được lưu, trả lỗi timeout như máy thật hết thời gian chờ. Ảnh chỉ
dùng được **1 lần** cho lần gọi `send-scan` đang chờ (one-shot), tự xoá sau đó để tránh dùng
nhầm cho hồ sơ khác — muốn xác nhận hồ sơ tiếp theo phải mở lại cửa sổ và dán ảnh mới.

Khi trả kết quả từ ảnh nhập thủ công, response có thêm các trường đánh dấu rõ nguồn gốc,
**không giả làm dữ liệu quét thật**:
```json
{
  "CODE": 0,
  "MESSAGE": "Lấy vân tay thành công (NHẬP THỦ CÔNG - không phải quét trực tiếp từ máy)",
  "RESULT": "<base64 PNG>",
  "SOURCE": "MANUAL_UPLOAD",
  "MANUAL_INFO": { "reason": "...", "capturedAt": "2026-..." }
}
```
Mọi lượt dùng ảnh thủ công đều được ghi log riêng (`[MANUAL-FINGER] ...` trong
`%APPDATA%/zk-fingerprint-desktop/logs/main.log`) kèm lý do, thời điểm — để tra soát sau này.

**Giới hạn quan trọng cần biết:**
- Ô nhập chỉ còn **lý do**, không còn thu thập mã/tên nhân viên xác nhận. Log audit vì vậy chỉ
  cho biết *vì sao* và *lúc nào* đã dùng ảnh thủ công, không xác định được *ai cụ thể* đã thao
  tác — nếu cần truy vết đến từng nhân viên, phải đối chiếu thêm với log đăng nhập Windows trên
  máy chạy service, hoặc bổ sung lại trường định danh nhân viên sau này nếu cần.
- Service chỉ đảm bảo *tính minh bạch ở phía log cục bộ* và ở các trường phụ (`SOURCE`,
  `MANUAL_INFO`) trong response. Nếu ứng dụng phía HIS/Android gọi API này **không đọc và lưu
  lại** hai trường đó, thì phía hồ sơ bệnh nhân vẫn sẽ chỉ thấy một tấm ảnh vân tay như bình
  thường, không biết đây là ảnh dán tay thủ công. Nên phối hợp với đội phát triển phía HIS để
  họ đọc/lưu `SOURCE` và `MANUAL_INFO`, và cân nhắc quy trình duyệt (ai được phép bật chế độ
  này, khi nào) trước khi dùng trong môi trường thật — đây là tính năng có thể tạo ra hồ sơ xác
  nhận danh tính không dựa trên vân tay thật, cần dùng thận trọng và có kiểm soát nội bộ đi kèm.

## 2. Vì sao cần SDK chính hãng ZKTeco

ZK9500 và ZK4500 là thiết bị USB, giao tiếp qua **ZKFinger SDK for Windows** (thư viện
`libzkfp.dll` + driver WinBio đi kèm) – đây là SDK độc quyền, có bản quyền, Anthropic/Claude
**không được phép tải hay đóng gói sẵn**. Bạn (hoặc nhà cung cấp máy quét) cần tự cài SDK này
từ ZKTeco, sau đó copy các file `.dll` vào thư mục `native/x64` (hoặc `native/x86`) của dự án –
xem hướng dẫn chi tiết trong `native/README.txt`.

Nếu chưa có SDK/thiết bị, có thể chạy **MOCK_FINGERPRINT=1** để giả lập luồng hoạt động, phục
vụ test tích hợp phía app gọi API trong lúc chờ phần cứng.

## 3. Cài đặt & chạy thử (máy dev)

```bash
npm install
# chạy thử không cần máy quét thật:
set MOCK_FINGERPRINT=1 && npm start
# chạy thật (đã copy dll vào native/x64):
npm start
```

Khi chạy, ứng dụng **không mở cửa sổ nào** – chỉ xuất hiện icon trong khay hệ thống (system
tray), góc dưới bên phải màn hình. Click icon để xem trạng thái, mở API trong trình duyệt,
khởi động lại hoặc thoát.

## 4. Đóng gói cài đặt (.exe) cho Windows — dùng Inno Setup

Bộ cài **không còn dùng NSIS mặc định của electron-builder** — thay bằng
[Inno Setup](https://jrsoftware.org/isinfo.php), script nằm ở `build/installer.iss`.

**Yêu cầu trên máy build (Windows):**
1. Cài Node.js + chạy `npm install` như bình thường.
2. Cài **Inno Setup 6.x** (tải tại https://jrsoftware.org/isinfo.php). Nếu cài vào đúng đường
   dẫn mặc định (`C:\Program Files (x86)\Inno Setup 6\ISCC.exe`), không cần cấu hình gì thêm.
   Nếu cài chỗ khác, đặt biến môi trường `ISCC_PATH` trỏ tới file `ISCC.exe` trước khi build.

**Build:**
```bash
npm run dist:win
```
Lệnh này chạy `build/build-installer.js`, thực hiện 3 bước:
1. `electron-builder --win dir` — đóng gói app (asar, copy `native/` qua `extraResources`...)
   ra thư mục **không nén** `dist/win-unpacked` (không tạo installer ở bước này).
2. Xoá bớt file ngôn ngữ (`locales/*.pak`) của Chromium không cần dùng, chỉ giữ
   `en-US.pak` + `vi.pak` (xem giải thích ở mục 4.1 bên dưới).
3. Gọi `ISCC.exe build/installer.iss` — dùng Inno Setup đóng gói thư mục đó thành 1 file
   `dist/ZK-Fingerprint-Kiosk-Setup-<version>.exe`.

Nếu chỉ muốn chạy riêng bước 1 (xem thử app đã đóng gói mà chưa cần tạo installer):
```bash
npm run pack:win
```

### 4.1 Vì sao trước đây file cài đặt nặng ~300MB, và đã giảm thế nào

**Nguyên nhân chính (đã sửa):** cấu hình cũ trong `package.json` có `"files": ["**/*", ...]`
— pattern này vô tình đóng gói **toàn bộ** `node_modules` vào app, kể cả các gói chỉ dùng lúc
build (`devDependencies`: chính `electron` ~276MB, `electron-builder` cùng bộ công cụ của nó
~280MB nữa — `app-builder-bin`, `typescript`, `electron-winstaller`...). Đây là lỗi cấu hình
khá phổ biến khi dùng electron-builder. Đã sửa: `files` giờ chỉ liệt kê đúng file app cần
(`electron-main.js`, `src/`, `assets/`, `package.json`), để electron-builder tự động chỉ đóng
gói đúng các gói trong `dependencies` (không đụng tới `devDependencies`) như cơ chế mặc định
của nó.

**Sửa thêm 1 lỗi liên quan (quan trọng, không chỉ là dung lượng):** thư viện `koffi` (dùng để
gọi `libzkfp.dll`) đóng gói sẵn file nhị phân cho ~17 hệ điều hành/kiến trúc khác nhau (macOS,
Linux, BSD, Windows...) trong cùng 1 gói, ~28MB, dù app này chỉ chạy trên Windows. Đã thêm
exclude trong `files` để chỉ giữ 3 bản Windows (win32_x64/ia32/arm64, ~4.6MB). Đồng thời thêm
`"asarUnpack": ["node_modules/koffi/**/*"]` — nếu thiếu dòng này, file nhị phân `.node` của
koffi nằm trong `app.asar` (file nén) thì **Node không load được** lúc chạy thật (khác với lúc
`npm start` từ mã nguồn, vì lúc đó không dùng asar) → máy quét sẽ báo lỗi "Khong the nap module
koffi" dù build thành công. Lỗi này chưa từng lộ ra vì trước giờ chưa build được tới bước cài
đặt thật; đã kiểm tra bằng cách đóng gói thử ở môi trường của tôi và xác nhận `app.asar` giờ
chỉ còn ~3MB (trước đó ước tính 600MB+), file `.node` của koffi đã nằm đúng trong
`resources/app.asar.unpacked/`.

**Sửa thêm 1 khoản nữa (không bắt buộc, đã áp dụng):** Electron mặc định đóng gói ~55 file
ngôn ngữ cho menu chuột phải/spellcheck mặc định của Chromium (~40MB), app này không có giao
diện web nào hiển thị cho người dùng nên bước 2 ở trên tự xoá bớt, chỉ giữ tiếng Anh + tiếng
Việt (giảm còn ~1.2MB). Muốn giữ thêm ngôn ngữ khác, sửa danh sách `keep` trong lệnh
`pruneLocales(...)` ở cuối `build/build-installer.js`.

**Giới hạn không thể giảm thêm:** phần lớn dung lượng còn lại (thư mục `dist/win-unpacked`
đo được ở môi trường của tôi là **~256MB chưa nén**, chủ yếu là 1 file `.exe` ~192MB) là chính
bản thân **Electron/Chromium** — mọi app Electron, dù đơn giản tới đâu, đều đóng gói kèm trọn
bộ Chromium + V8 + Node.js runtime, đây là chi phí cố định không giảm được nếu vẫn dùng
Electron. Sau khi nén qua Inno Setup (LZMA), file cài đặt cuối cùng dự kiến còn khoảng
**90–150MB** thay vì ~300MB như trước — bạn build thử `npm run dist:win` trên Windows để xem
số thật, và cho tôi biết nếu vẫn còn quá nặng, tôi sẽ tìm hướng khác (ví dụ kiểm tra xem có
đang vô tình đóng gói thêm gì khác không).

**Driver USB được cài tự động:** ngoài các DLL API (`libzkfp.dll`...), thư mục `native/`
còn có driver kernel-mode cho cổng USB (`zkusbdevices.inf` + `.cat` + `.sys`, dựa trên
libusb-win32) — đây là phần bắt buộc để Windows *nhận diện* đúng máy ZK9500/ZK4500, tách
biệt với việc app load được DLL. Script Inno Setup (mục `[Code]` trong `build/installer.iss`,
hàm `InstallUsbDriver`) tự gọi `pnputil /add-driver ... /install` cho cả `native/x64` và
`native/x86` ngay sau khi cài xong app, nên **không cần chạy thêm trình cài riêng của nhà
cung cấp nữa**. Vì bước này cần quyền Administrator, `installer.iss` khai báo
`PrivilegesRequired=admin` — khi cài, Windows sẽ hiện hộp thoại UAC xin quyền admin (một lần),
đây là điều bình thường. Cài driver thất bại (ví dụ driver đã được cài từ trước) không làm
hỏng quá trình cài app — chỉ ghi cảnh báo vào log cài đặt của Inno Setup.

Nếu vẫn báo không kết nối được sau khi cài, tự cài tay driver 1 lần (Device Manager →
Update driver → trỏ tới `native/x64/zkusbdevices.inf`, hoặc dùng `pnputil /add-driver`
với quyền admin) rồi thử lại — xem thêm mục 8 bên dưới.

## 5. Tự khởi động cùng Windows

**Đăng ký chính thức: ngay lúc cài đặt**, `build/installer.iss` (mục `[Registry]`) tự ghi 1
key vào `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` trỏ tới file `.exe` đã cài —
**không cần thao tác thủ công, không phụ thuộc user nào chạy app trước**. Vì ghi ở cấp máy
(HKLM, cần quyền admin — đã có sẵn do `PrivilegesRequired=admin`), key này có tác dụng cho
**mọi tài khoản Windows** đăng nhập vào máy đó, phù hợp với máy kiosk dùng chung. Gỡ cài đặt
app sẽ tự xoá key này (`Flags: uninsdeletevalue`).

**Lớp dự phòng:** ứng dụng cũng tự kiểm tra/đăng ký thêm 1 lần nữa lúc khởi động (qua thư viện
`auto-launch`, ghi vào `HKCU` của user hiện tại) — chỉ có tác dụng khi chạy thẳng từ mã nguồn
(`npm start`, không qua bộ cài `.exe`) để vẫn có tự khởi động lúc dev/test. Khi chạy bản đã cài
đặt chính thức, đây chỉ là thao tác dư thừa vô hại (không tạo thêm bản ghi nếu đã có).

Muốn tắt tự khởi động: xoá key trong `HKLM...\Run` (hoặc `HKCU...\Run`) bằng tay qua
`regedit`, hoặc dùng Task Manager → tab Startup Apps → chọn "ZK Fingerprint Kiosk" → Disable.

## 6. Âm thanh thông báo

- Khi `/api/finger/check-connection` trả về thành công → phát âm thanh mời đặt ngón tay
  (`assets/sounds/prompt-scan.wav`).
- Khi `/api/finger/send-scan` nhận vân tay thành công → phát âm thanh xác nhận đã nhận dữ liệu
  (`assets/sounds/scan-received.wav`).

Hai file `.wav` hiện tại chỉ là tiếng "bíp" placeholder (được sinh tự động) để bạn kiểm tra
luồng hoạt động ngay. **Nên thay bằng file âm thanh tiếng Việt** (VD: "Mời quét vân tay",
"Đã nhận vân tay thành công") – chỉ cần ghi đè 2 file cùng tên trong `assets/sounds/`
(hỗ trợ .wav/.mp3, đổi tên tương ứng trong `src/audio/notifySound.js` nếu đổi định dạng).

## 7. Cấu trúc thư mục

```
electron-main.js          entry point: khởi tạo server, tray, autostart, audio
src/server/apiServer.js   HTTP API (Express) - đúng contract /api/finger/*
src/device/zkfpNative.js  FFI binding tới libzkfp.dll (ZKFinger SDK)
src/device/deviceManager.js  lớp trung gian, có chế độ MOCK
src/device/rawToPng.js    chuyển ảnh vân tay thô -> PNG base64
src/audio/notifySound.js  phát âm thanh thông báo
src/tray/trayMenu.js      icon + menu khay hệ thống
src/autostart/autostart.js  đăng ký khởi động cùng Windows
src/manual/manualUploadWindow.js  cửa sổ dán/tải ảnh vân tay thủ công
native/                   nơi đặt libzkfp.dll (tự cài, không kèm sẵn)
assets/sounds/            file âm thanh thông báo
build/installer.iss       script Inno Setup đóng gói file cài đặt .exe
build/build-installer.js  script Node chạy electron-builder + Inno Setup
```

## 8. Xử lý sự cố thường gặp

- **Tray báo "khong ket noi duoc may quet"**: kiểm tra đã copy đủ dll của ZKFinger SDK vào
  `native/x64` (hoặc `native/x86` nếu build bản 32-bit) chưa; xem log chi tiết tại
  `%APPDATA%/zk-fingerprint-desktop/logs/main.log`. Lưu ý: copy đủ DLL chỉ giúp *app* gọi
  được API — nếu Windows **chưa từng cài driver USB** cho ZK9500/ZK4500 (kiểm tra trong
  Device Manager xem thiết bị có dấu `!` vàng hoặc hiện "Unknown device" không), app vẫn
  báo không kết nối được dù DLL đã có sẵn. Bản cài `.exe` build từ `npm run dist:win` đã tự
  cài driver này (xem mục 4); nếu chạy `npm start` trực tiếp từ source (không qua bộ cài),
  cần tự cài driver 1 lần bằng tay: Device Manager → chuột phải thiết bị → Update driver →
  Browse my computer → trỏ tới `native/x64/zkusbdevices.inf`, hoặc chạy (CMD quyền Admin):
  `pnputil /add-driver "native\x64\zkusbdevices.inf" /install`.
- **Cổng 18622 đang bị chiếm dụng**: đóng ứng dụng ZK khác (kể cả bản Android/emulator) đang
  dùng cùng cổng trên máy, hoặc kiểm tra tiến trình cũ chưa thoát hẳn.
- **Không thấy icon khay hệ thống**: Windows có thể ẩn icon mới trong mục "ẩn biểu tượng" –
  bấm mũi tên `^` cạnh đồng hồ để hiện, sau đó ghim lại.
