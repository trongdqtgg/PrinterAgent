# A4 ↔ A5 Printer

Phiên bản hiện tại: **2.13.0**.

Ứng dụng Node.js/Electron dành cho Windows, cung cấp trình điều khiển web tại `http://127.0.0.1:5756` và in tài liệu qua driver đã cài trên máy.

## Chức năng

- Người dùng chỉ cần chọn **In A4** hoặc **In A5**.
- Nhận PDF, HTML/HTM, DOC/DOCX, XLS/XLSX, PNG và JPG/JPEG.
- Tự chuyển về PDF, nhận dạng chiều trang, fit toàn bộ nội dung và căn giữa.
- Tạo lại trang đúng kích thước vật lý trước khi gửi driver; không crop hoặc kéo méo.
- Gửi bản đã chuẩn hóa ở tỷ lệ 100% (`noscale`) để driver không thu nhỏ lần hai.
- Chọn driver máy in, chiều dọc/ngang, số bản và in màu/đen trắng.
- In bằng bộ PDF native trên Windows với mã giấy A4/A5 chuẩn của `DEVMODE`.
- Hỗ trợ PDF nhiều trang.
- Tự kiểm tra, tải và cài phiên bản mới khi chạy bản `.exe`.
- Bản đã cài đặt tự khởi động cùng Windows để API in tại `127.0.0.1:5756` luôn sẵn sàng.
- Khi đóng cửa sổ, ứng dụng tiếp tục chạy trong khay hệ thống để Web Print API không bị ngắt; menu khay cho phép mở lại, kiểm tra cập nhật hoặc thoát hoàn toàn.
- Bản `.exe` tự kiểm tra cập nhật một lần khi khởi động; người dùng có thể chủ động kiểm tra từ giao diện hoặc menu khay hệ thống.
- Web Print Controller trên localhost port `5756`.
- REST API kiểm tra dịch vụ, đọc danh sách máy in và gửi PDF để in.
- Không yêu cầu người dùng khai báo khổ hoặc chiều của tài liệu nguồn.
- Phiếu ngang giữ nguyên MediaBox ngang; không ép thêm orientation ở driver để tránh xoay/thu nhỏ hai lần.
- HTML không có ngắt trang thực tế được tự đo toàn bộ nội dung và xuất trên đúng một trang trước khi fit về A4/A5.
- HTML có nhiều `.page`, `data-print-page` hoặc ngắt trang chủ động vẫn giữ nguyên phân trang.
- HTML nhiều trang được khóa từng `.page` vào một tờ và scale riêng từng trang, không để nội dung tràn làm nhảy trang.
- HTML không phân trang được kiểm tra lại sau khi render; nếu Chromium còn sinh nhiều trang, ứng dụng tự tăng khổ trung gian và hợp nhất dự phòng để bảo đảm chỉ gửi một trang tới driver.
- Giữ PDF in tạm trong 60 giây sau khi gọi driver và chờ spooler 3 giây, tương thích tốt hơn với Canon CAPT/LBP2900 đọc file trễ.
- HTML không phân trang được scale vào một tờ và gửi trực tiếp bằng Electron native print, không đi qua SumatraPDF; HTML có phân trang vẫn dùng pipeline PDF từng trang.
- HTML phân trang được đo sau khi áp dụng `@media print`, scale độc lập theo bố cục in thật và không bị thu nhỏ thêm lần hai khi chuẩn hóa PDF.
- HTML phân trang đo khung nội dung nhìn thấy thay vì `scrollWidth/scrollHeight`, căn giữa với lề an toàn 6 mm để các trang có tỷ lệ cân đối hơn.
- HTML phân trang dùng bộ xử lý tổng quát: tải và render độc lập từng `.page`, đo cả phần tử tuyệt đối vượt khung cha, rồi fit toàn bộ khung bao vào một tờ; không phụ thuộc tên class, chức danh hay số thứ tự trang.
- HTML/XML không phân trang giữ một tờ và chừa vùng in an toàn 7 mm hai bên, 5 mm trên/dưới trước khi scale và căn giữa.
- HTML phân trang dùng lề an toàn chung 7 mm cho bốn cạnh; mọi trang bắt đầu tại cùng lề trên và phép scale bảo đảm nội dung không đi vào lề dưới.
- Khi in A5 đối với HTML/XML không phân trang, ứng dụng đo khung bao đầy đủ sau khi áp dụng CSS in và fit vào vùng an toàn 7 mm hai bên, 5 mm trên/dưới; A4 không thay đổi.
- A5 không phân trang bỏ `min-height` rỗng của `.page` khỏi phép đo và chỉ tính khung nội dung thực tế.
- Với nội dung A5 nằm ngang, ứng dụng tự xoay nội dung 90° bên trong tờ A5 dọc và gửi `landscape=false`; driver không còn tự xoay hoặc tạo vùng bù phía trên.
- Mỗi lần in A5 HTML không phân trang, ứng dụng lưu `A5-preview-latest.pdf` và thông số đo tại thư mục `Documents/A4-A5-Printer-Debug` để phân biệt lỗi bố cục với offset của driver.
- A4 HTML phân trang dùng lề an toàn 10 mm hai bên và 7 mm trên/dưới; từng trang được scale độc lập và căn giữa.
- Bộ đo A4 phân trang chờ layout ổn định, giữ nguyên outer box của mọi kiểu `box-sizing`, đo cả chữ tràn khỏi ô và cộng vùng đệm 1 mm để tương thích nhiều cấu trúc HTML khác nhau.
- API in tiếp nhận file và trả `jobId` ngay; việc chuyển đổi, scale và gửi driver chạy nền theo hàng đợi để request web không phải chờ.
- HTML phân trang bỏ bước chuẩn hóa PDF lặp khi file đã đúng khổ và giảm thời gian chờ cố định.
- HTML phân trang được xử lý streaming: scale xong trang nào thì gửi ngay trang đó tới Spooler, không chờ render hết tài liệu; response job có `timings.firstPageSubmittedMs` để theo dõi thời gian trang đầu được gửi.
- Mẫu có nhiều `.page` hoặc `data-print-page` được nhận diện ngay từ mã nguồn, bỏ một lượt mở/render HTML thừa trước khi bắt đầu in.
- Toàn bộ trang nguồn được giữ trong cùng một phiên Chromium; chuyển sang trang kế tiếp không tải lại HTML, font và ảnh.
- Render trang kế tiếp chạy gối đầu trong lúc trang hiện tại được gửi tới driver, giới hạn trước một trang để giữ đúng thứ tự Spooler và không tăng bộ nhớ quá mức.
- Khi in nhiều bản, PDF từng trang được tái sử dụng cho các bản tiếp theo, không render lại HTML.

## Chạy mã nguồn

Yêu cầu Node.js 20 trở lên và Windows 10/11.

```powershell
npm install
npm start
```

Khi chạy `npm start`, ứng dụng tự kiểm tra file chạy Electron. Nếu Electron bị
thiếu hoặc cài dở, chương trình sẽ tự tải và sửa trước khi mở ứng dụng. Có thể
chủ động sửa bằng lệnh:

```powershell
npm run repair-electron
```

Sau khi ứng dụng chạy, mở trình duyệt tại:

```text
http://127.0.0.1:5756
```

## Local Print API

- `GET /api/health`: kiểm tra Print Agent và phiên bản.
- `GET /api/printers`: lấy danh sách driver máy in.
- `POST /api/print`: multipart form, gồm `document`, `targetSize`, `copies`, `pages`, `reverse`, `rotateBackSide`; `deviceName` và `color` là tùy chọn.
- `GET /api/print`: xem trạng thái endpoint và hướng dẫn các trường FormData.
- `GET /api/print/:jobId`: xem trạng thái `queued`, `processing`, `success` hoặc `failed` của yêu cầu in nền.
- `POST /api/update`: yêu cầu kiểm tra cập nhật.

Ví dụ gọi API in tất cả trang bằng máy in mặc định:

```bash
curl -X POST http://127.0.0.1:5756/api/print \
  -F "document=@document.pdf" \
  -F "targetSize=A5" \
  -F "copies=1" \
  -F "pages=all"
```

Giá trị `pages`: `all` (tất cả), `odd` (trang lẻ), `even` (trang chẵn). `reverse=true` đảo ngược thứ tự trang; `rotateBackSide=true` xoay nội dung mặt sau 180°. Mặc định API: trang lẻ tự bật Reverse; trang chẵn tắt Reverse và tự bật xoay 180°. Nếu không truyền `deviceName`, API tự chọn máy in mặc định của Windows.

In hai mặt thủ công trên máy in một mặt:

```bash
# Lượt 1: trang lẻ theo thứ tự Reverse
curl -X POST http://127.0.0.1:5756/api/print \
  -F "document=@document.pdf" -F "targetSize=A4" -F "copies=1" \
  -F "pages=odd" -F "reverse=true" -F "rotateBackSide=false"

# Lượt 2: giữ nguyên vị trí xấp giấy, in trang chẵn thứ tự thường và xoay 180°
curl -X POST http://127.0.0.1:5756/api/print \
  -F "document=@document.pdf" -F "targetSize=A4" -F "copies=1" \
  -F "pages=even" -F "reverse=false" -F "rotateBackSide=true"
```

Sau khi tiếp nhận, API trả ngay HTTP 202:

```json
{"ok":true,"accepted":true,"status":"queued","submittedToSpooler":false,"message":"Đã tiếp nhận yêu cầu in và đang xử lý nền","jobId":"JOB_ID","statusUrl":"http://127.0.0.1:5756/api/print/JOB_ID"}
```

Kiểm tra kết quả:

```bash
curl http://127.0.0.1:5756/api/print/JOB_ID
```

Khi hoàn thành, `status` là `success`; trường `result.pageOrder` cho biết thứ tự trang đã gửi tới máy in:

```json
{"ok":true,"jobId":"JOB_ID","status":"success","submittedToSpooler":true,"message":"Gửi lệnh in thành công","result":{"ok":true,"pages":1,"durationMs":2450}}
```

Request không hợp lệ vẫn trả HTTP 400 hoặc 500 ngay. Lỗi trong xử lý nền được trả tại endpoint trạng thái:

```json
{"ok":true,"jobId":"JOB_ID","status":"failed","submittedToSpooler":false,"message":"Gửi lệnh in thất bại","error":"Nội dung lỗi"}
```

Máy chủ chỉ lắng nghe tại `127.0.0.1`, không mở port ra mạng LAN. Tài liệu tải lên và các file chuyển đổi trung gian được xóa ngay sau khi lệnh in hoàn tất hoặc thất bại.

API cho phép CORS từ các website HTTPS thuộc `vnpthis.vn` và hỗ trợ preflight khi website gọi tới loopback. Có thể bổ sung origin khác bằng biến môi trường `A4A5_ALLOWED_ORIGINS`, phân tách nhiều origin bằng dấu phẩy.

Kết quả job có `durationMs` là thời gian xử lý và gửi tới Spooler. File upload được giữ cho tới khi job nền hoàn tất; PDF gửi driver vẫn được giữ 60 giây để tương thích driver Canon CAPT.

Bản 2.7.1 bổ sung `timings` để tách thời gian chuyển đổi, chuẩn hóa và gửi Spooler; đồng thời tạo sẵn cache driver khi ứng dụng khởi động và không tạo thư mục chuyển đổi cho HTML một trang.

## Word và Excel

Ứng dụng ưu tiên Microsoft Word/Excel đã cài trên máy để xuất PDF. Nếu không có Microsoft Office, hãy cài LibreOffice và ứng dụng sẽ tự động dùng `soffice` để chuyển đổi. PDF, HTML và ảnh không yêu cầu Office/LibreOffice.

## Đóng gói file cài đặt Windows

Thực hiện trên Windows 10/11, trong PowerShell tại thư mục dự án:

```powershell
npm install
npm run dist
```

File cài đặt sẽ nằm tại:

```text
dist\A4-A5-Printer-2.13.0-x64.exe
```

Mở file này, chọn thư mục cài đặt và hoàn tất. Sau khi cài, ứng dụng tự đăng ký
khởi động khi người dùng đăng nhập Windows. Không cần chép shortcut thủ công vào
thư mục Startup. Có thể kiểm tra hoặc tắt/bật tại **Task Manager > Startup apps**.

Nếu gặp lỗi `Electron failed to install correctly`, chạy:

```powershell
npm run repair-electron
npm run dist
```

Muốn tạo bản chạy trực tiếp không cần cài đặt:

```powershell
npm run portable
```

Lưu ý: bản portable vẫn có thể tự đăng ký chạy cùng Windows sau khi mở, nhưng
không nên di chuyển hoặc xóa file portable sau đó. Để ổn định, nên dùng bản cài
đặt NSIS tạo bởi `npm run dist`.

## Auto update

Đặt file `update-url.txt` cạnh file thực thi hoặc trong thư mục dữ liệu ứng dụng. Nội dung là địa chỉ HTTPS chứa các file do `electron-builder` tạo, ví dụ:

```text
https://ten-mien-cua-ban.vn/a4-a5-printer/updates/
```

Mỗi lần phát hành, tăng `version` trong `package.json`, chạy `npm run dist`, sau đó tải `latest.yml`, file cài đặt `.exe` và file `.blockmap` lên địa chỉ trên. Ứng dụng tự kiểm tra khi mở và có nút **Kiểm tra cập nhật**.

## Có thể đưa lên web không?

Web thuần chỉ dùng được hộp thoại `window.print()` và không được phép tự chọn driver/khổ giấy. Mô hình triển khai phù hợp là giao diện web kết hợp A4 A5 Printer chạy nền tại máy người dùng. Phần giao diện/quản trị có thể đặt online; dịch vụ Windows cục bộ vẫn chịu trách nhiệm đọc printer driver và gửi lệnh in.

## Lưu ý driver

Máy in phải được cài driver và nhìn thấy trong **Settings > Bluetooth & devices > Printers & scanners**. Một số driver khóa khổ giấy tại Printer Properties; hãy bật A4/A5 trong **Printing Preferences**. Chương trình đặt kích thước trang đích, còn khả năng nạp giấy/khay giấy phụ thuộc driver và máy in.
