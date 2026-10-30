import { safeStorage } from 'electron';
import { readFile, unlink } from 'node:fs/promises';
import { atomicWriteJson } from './persistence';

export function taskListStorage(file: string) {
  const canRemember = () => safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  return {
    canRemember,
    async load(): Promise<unknown> {
      try {
        const stored = JSON.parse(await readFile(file, 'utf8')) as { encrypted?: unknown };
        if (!canRemember() || typeof stored.encrypted !== 'string') return null;
        return JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))) as unknown;
      } catch { return null; }
    },
    async save(session: unknown | null): Promise<void> {
      if (session === null) {
        try { await unlink(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法清除本机登录信息，请稍后重试。'); }
        return;
      }
      if (!canRemember()) throw new Error('本机加密存储不可用。');
      const encrypted = safeStorage.encryptString(JSON.stringify(session)).toString('base64');
      await atomicWriteJson(file, { encrypted });
    },
  };
}
