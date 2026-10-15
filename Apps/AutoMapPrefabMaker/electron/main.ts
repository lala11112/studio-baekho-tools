import { app, BrowserWindow } from 'electron';
import { createMapWindowService } from './window-service';
let service: ReturnType<typeof createMapWindowService>;
void app.whenReady().then(() => {
  service = createMapWindowService({ dataRoot: app.getPath('userData'), resourceRoot: app.isPackaged ? process.resourcesPath : app.getAppPath() });
  service.open();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) service.open(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => service?.shutdown());
