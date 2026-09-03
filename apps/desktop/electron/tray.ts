/**
 * 托盘：左键打开主窗口，右键菜单。
 * M4：暂停提醒（勾选态生效）、稍后提醒（全局贪睡 20 分钟）。
 * M5：暂停追踪、设置项继续接入。
 */
import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { setRemindersPaused, snoozeAll } from './reminders';

let tray: Tray | null = null;
let paused = false;

export function createTray(showMain: () => void): Tray {
  // 生成阶段放 resources/，打包后 electron-builder 会带_resourcesPath
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray.png')
    : path.join(__dirname, '../resources/tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  tray.setToolTip('Anchor 锚点');
  tray.on('click', () => showMain());

  const menu = Menu.buildFromTemplate([
    { label: '打开 Anchor', click: () => showMain() },
    { type: 'separator' },
    {
      label: '暂停提醒',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        paused = item.checked;
        setRemindersPaused(paused);
      },
    },
    {
      label: '稍后提醒（20 分钟）',
      click: () => snoozeAll(),
    },
    // M5：暂停追踪（勾选态）
    { label: '暂停追踪', type: 'checkbox', checked: false, enabled: false },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        (app as unknown as { isQuitting?: boolean }).isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  return tray;
}

export function getTray(): Tray | null {
  return tray;
}
