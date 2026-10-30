import type { LinkedTask, TaskCompanionPreferences, TaskFocusStatus, TaskListKind } from '../../shared/contracts';

export const reminderValue = (value: string | null) => value ? new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 16) : '';
export const reminderISO = (value: string) => value ? new Date(`${value}:00+08:00`).toISOString() : null;
const format = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function setupTaskCompanion(root: HTMLElement, showError: (error: unknown) => void, changed: () => Promise<void>) {
  const api = window.petAPI?.taskList;
  if (!api?.companion) return { open: async () => {}, account: (_key: string) => {}, actions: (_item: LinkedTask, _kind: TaskListKind, _row: HTMLElement) => {} };
  root.innerHTML = `<section class="task-tools focus-surface"><div class="focus-heading"><span>一起专注</span><span class="focus-state"></span></div><p class="focus-name">自由专注，或选择下方的一项任务</p><p class="focus-clock" aria-live="off"></p><div class="task-tool-buttons focus-controls"><label class="focus-duration"><input type="number" class="task-focus-minutes" value="25" min="1" max="180" aria-label="专注分钟数"> 分钟</label><button type="button" data-focus="start">自由专注</button><button type="button" data-focus="toggle" hidden>暂停</button><button type="button" data-focus="stop" hidden>结束</button><button type="button" data-focus="retry" hidden>重试同步</button></div><p class="focus-error task-error" role="status"></p><p class="focus-sync task-hint"></p><p class="task-background-error task-error" role="status"></p></section>`;
  const settingsRoot = document.getElementById('companion-settings')!;
  settingsRoot.innerHTML = `<section class="settings-group"><div class="section-title">提醒与陪伴</div><form class="task-companion-settings"><label><input name="reminders" type="checkbox"> 桌宠接收任务提醒</label><label><input name="morning" type="checkbox"> 每日简报 <input name="morningTime" type="time" required></label><label><input name="evening" type="checkbox"> 晚间复盘 <input name="eveningTime" type="time" required></label><label><input name="quiet" type="checkbox"> 免打扰 <input name="quietStart" type="time" required> 至 <input name="quietEnd" type="time" required></label><p class="task-hint">时间均为北京时间。免打扰期间保持安静，提醒在结束后补查。专注时减少走动和主动打扰。</p><button type="submit">保存</button><span class="task-config-message" role="status"></span></form></section>`;
  const settings = settingsRoot.querySelector<HTMLFormElement>('form')!;
  const settingsMessage = settingsRoot.querySelector<HTMLElement>('.task-config-message')!;
  const saveButton = settings.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let settingsDirty = false; let settingsSaving = false; let editRevision = 0;
  const markDirty = () => { settingsDirty = true; editRevision++; settingsMessage.textContent = '有未保存的修改'; };
  settings.addEventListener('input', markDirty); settings.addEventListener('change', markDirty);
  const chatFocus = document.createElement('div'); chatFocus.className = 'task-chat-focus'; chatFocus.hidden = true;
  const chatLabel = document.createElement('span');
  const chatToggle = document.createElement('button'); chatToggle.type = 'button'; chatToggle.onclick = () => void operate(focus.phase === 'running' ? 'pause' : 'resume');
  const chatStop = document.createElement('button'); chatStop.type = 'button'; chatStop.textContent = '结束'; chatStop.onclick = () => void operate('stop');
  const chatError = document.createElement('span'); chatError.className = 'task-error';
  chatFocus.append(chatLabel, chatToggle, chatStop, chatError);
  document.getElementById('chat-messages')?.before(chatFocus);
  let focus: TaskFocusStatus = { phase: 'idle', seconds: 0, remaining: 0 }; let busy = false; let polling = false; let epoch = 0; let account = '';
  const el = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  function render(value: TaskFocusStatus) {
    focus = value;
    el('.focus-state').textContent = value.phase === 'idle' ? '准备开始' : value.phase === 'running' ? '专注中' : value.remaining === 0 ? '本轮完成' : '已暂停';
    el('.focus-name').textContent = value.phase === 'idle' ? '自由专注，或选择下方的一项任务' : value.name ?? '自由专注';
    el('.focus-clock').textContent = value.phase === 'idle' ? '' : format(value.remaining);
    el('[data-focus="start"]').hidden = value.phase !== 'idle'; el('.focus-duration').hidden = value.phase !== 'idle';
    el('[data-focus="toggle"]').hidden = value.phase === 'idle' || value.remaining === 0; el('[data-focus="toggle"]').textContent = value.phase === 'running' ? '暂停' : '继续';
    el('[data-focus="stop"]').hidden = value.phase === 'idle'; el('[data-focus="retry"]').hidden = !value.error; el('.focus-error').textContent = value.error ?? '';
    el('.focus-sync').textContent = value.phase === 'idle' ? '一轮结束后由你决定休息或继续。' : value.free ? `本轮 ${format(value.roundSeconds ?? value.seconds)} · 保存在本机` : `任务累计 ${format(value.seconds)} · ${value.error ? '待同步' : '进度自动保存'}`;
    chatFocus.hidden = value.phase === 'idle';
    chatLabel.textContent = `${value.phase === 'running' ? '⏱' : '⏸'} ${value.name ?? '自由专注'} · ${format(value.remaining)}`;
    chatToggle.hidden = value.remaining <= 0; chatToggle.textContent = value.phase === 'running' ? '暂停' : '继续';
    chatToggle.disabled = chatStop.disabled = busy;
    chatError.hidden = !value.error; chatError.textContent = value.error ? '时长待同步' : '';
  }
  async function open() {
    const request = epoch; const requestedEdits = editRevision;
    try {
      const result = await api!.companion(); if (request !== epoch) return; render(result.focus);
      el('.task-background-error').textContent = result.error ? `同步暂不可用：${result.error}` : '';
      if (requestedEdits === editRevision && !settingsDirty && !settingsSaving && !settings.contains(document.activeElement)) for (const [key, value] of Object.entries(result.preferences)) { const field = settings.elements.namedItem(key) as HTMLInputElement; if (typeof value === 'boolean') field.checked = value; else field.value = value; }
    } catch (error) { showError(error); }
  }
  async function operate(action: 'start' | 'pause' | 'resume' | 'stop' | 'retry', id?: string) {
    if (busy) return;
    const duration = root.querySelector<HTMLInputElement>('.task-focus-minutes')!;
    if (action === 'start' && !duration.reportValidity()) return;
    busy = true; root.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
    try { render(await api!.focus({ action, ...(id ? { id } : {}), ...(action === 'start' ? { minutes: Number(duration.value) } : {}) })); if (action === 'stop') await changed(); }
    catch (error) { showError(error); }
    finally { busy = false; root.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = false; }); await open(); }
  }
  root.addEventListener('click', (event) => { const action = (event.target as HTMLElement).closest<HTMLElement>('[data-focus]')?.dataset.focus; if (action) void operate(action === 'toggle' ? focus.phase === 'running' ? 'pause' : 'resume' : action as 'start' | 'stop' | 'retry'); });
  settings.addEventListener('submit', (event) => {
    event.preventDefault();
    if (settingsSaving) return;
    const accountEpoch = epoch; const revision = editRevision;
    const input = Object.fromEntries(Array.from(settings.elements).filter((field): field is HTMLInputElement => field instanceof HTMLInputElement).map((field) => [field.name, field.type === 'checkbox' ? field.checked : field.value])) as unknown as TaskCompanionPreferences;
    settingsSaving = true; saveButton.disabled = true; settingsMessage.textContent = '保存中…';
    void api!.configure(input).then(() => {
      if (accountEpoch !== epoch) return;
      settingsDirty = revision !== editRevision; editRevision++; settingsMessage.textContent = settingsDirty ? '有未保存的修改' : '已保存';
    }).catch((error) => {
      if (accountEpoch !== epoch) return;
      settingsMessage.textContent = error instanceof Error ? `保存失败，修改已保留：${error.message}` : '保存失败，修改已保留，请重试。';
    }).finally(() => { if (accountEpoch === epoch) { settingsSaving = false; saveButton.disabled = false; } });
  });
  const interval = setInterval(() => { if (busy || polling || document.hidden) return; polling = true; void open().finally(() => { polling = false; }); }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(interval));
  return { open, account: (key: string) => { if (key !== account) { account = key; epoch++; settingsDirty = settingsSaving = false; editRevision++; saveButton.disabled = false; settingsMessage.textContent = ''; void open(); } }, actions(item: LinkedTask, kind: TaskListKind, row: HTMLElement) {
    if (kind !== 'daily' || item.completed) return;
    const button = document.createElement('button'); button.className = 'task-edit-button action-btn'; button.textContent = '专注'; button.type = 'button'; button.dataset.taskWrite = '';
    button.setAttribute('aria-label', `专注：${item.name}`); button.onclick = () => void operate('start', item.id); row.append(button);
  } };
}
