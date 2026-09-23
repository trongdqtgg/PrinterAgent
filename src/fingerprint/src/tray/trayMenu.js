'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, shell, app } = require('electron');

let tray = null;

function createTray({
  port,
  onQuit,
  getStatusText,
  getUploadMode,
  onSelectDeviceMode,
  onSelectManualMode
}) {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('ZK Fingerprint Kiosk - đang chạy ngầm');

  function buildMenu() {
    const uploadModeOn = getUploadMode ? getUploadMode() : false;
    return Menu.buildFromTemplate([
      { label: 'ZK Fingerprint Kiosk', enabled: false },
      { label: getStatusText ? getStatusText() : 'Đang chạy', enabled: false },
      { type: 'separator' },
      {
        label: `Mở API trong trình duyệt (cổng ${port})`,
        click: () => shell.openExternal(`http://localhost:${port}/`)
      },
      { type: 'separator' },
      { label: 'Nguồn lấy vân tay', enabled: false },
      {
        label: 'Máy quét vân tay (thiết bị thật)',
        type: 'radio',
        checked: !uploadModeOn,
        click: () => {
          if (onSelectDeviceMode) onSelectDeviceMode();
        }
      },
      {
        label: 'Dán ảnh vân tay thủ công...',
        type: 'radio',
        checked: uploadModeOn,
        click: () => {
          // Luôn mở cửa sổ nhập ảnh khi chọn mục này, kể cả đang ở sẵn chế độ
          // thủ công rồi - để nhân viên nhập ảnh mới cho hồ sơ tiếp theo.
          if (onSelectManualMode) onSelectManualMode();
        }
      },
      { type: 'separator' },
      {
        label: 'Khởi động lại dịch vụ',
        click: () => app.relaunch() || app.exit(0)
      },
      { type: 'separator' },
      {
        label: 'Thoát',
        click: () => {
          if (onQuit) onQuit();
        }
      }
    ]);
  }

  tray.setContextMenu(buildMenu());
  tray.on('click', () => tray.popUpContextMenu());

  return {
    refresh: () => tray.setContextMenu(buildMenu()),
    destroy: () => tray && tray.destroy()
  };
}

module.exports = { createTray };
