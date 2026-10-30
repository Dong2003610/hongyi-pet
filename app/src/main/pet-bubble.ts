import { BrowserWindow, screen } from 'electron';
import { bubbleBounds, bubbleDocument, BUBBLE_WIDTH, BUBBLE_HEIGHT } from './pet-surfaces';

// A mouse-transparent surface, not part of the draggable/scaled pet viewport.
// No preload, scripts, network or renderer IPC is exposed here.
export class PetBubble {
  private window?: BrowserWindow;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  constructor(private readonly pet: () => BrowserWindow | undefined, private readonly hidden = false) {}
  reposition(): void {
    const pet = this.pet(); if (!pet || pet.isDestroyed() || !this.window || this.window.isDestroyed()) return;
    const bounds = pet.getBounds();
    this.window.setBounds(bubbleBounds(bounds, screen.getDisplayMatching(bounds).workArea), false);
  }
  hide(): void { this.sequence++; if (this.timer) clearTimeout(this.timer); if (this.window && !this.window.isDestroyed()) this.window.hide(); }
  async show(text: string): Promise<void> {
    const pet = this.pet(); if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
    if (this.timer) clearTimeout(this.timer);
    const sequence = ++this.sequence;
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({ width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT, show: false, transparent: true, frame: false,
        resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, opacity: this.hidden ? 0 : 1,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
      this.window.setIgnoreMouseEvents(true, { forward: true });
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.window.webContents.on('will-navigate', (event) => event.preventDefault());
    }
    const win = this.window;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bubbleDocument(text))}`);
    if (sequence !== this.sequence || win.isDestroyed() || !pet.isVisible()) return;
    this.reposition(); win.showInactive();
    this.timer = setTimeout(() => win.isDestroyed() ? undefined : win.hide(), Math.min(12_000, Math.max(4500, Array.from(text).length * 130)));
  }
  destroy(): void { this.hide(); this.window?.destroy(); this.window = undefined; }
}
