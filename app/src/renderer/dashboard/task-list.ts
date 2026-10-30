import type { LinkedTask, TaskListCreateInput, TaskListKind, TaskListSnapshot, TaskListStatus, TaskListUpdateInput, TaskListView } from '../../shared/contracts';
import { reminderISO, reminderValue, setupTaskCompanion } from './task-companion';

export function setupTaskList() {
  const api = window.petAPI?.taskList;
  const el = (id: string) => document.getElementById(id)!;
  const form = el('task-login-form') as HTMLFormElement;
  const username = el('task-username') as HTMLInputElement;
  const password = el('task-password') as HTMLInputElement;
  const remember = el('task-remember') as HTMLInputElement;
  const loginButton = el('task-login-button') as HTMLButtonElement;
  const connected = el('task-connected');
  const account = el('task-account-name');
  const accountButton = el('task-account-button') as HTMLButtonElement;
  const dialog = el('task-account-dialog') as HTMLDialogElement;
  const logout = el('task-logout') as HTMLButtonElement;
  const view = el('task-view') as HTMLSelectElement;
  const refresh = el('task-refresh') as HTMLButtonElement;
  const message = el('task-message');
  const accountMessage = el('task-account-message');
  const summary = el('task-summary');
  const updated = el('task-updated');
  const list = el('task-items');
  const createForm = el('task-create-form') as HTMLFormElement;
  const createName = el('task-create-name') as HTMLInputElement;
  const createDate = el('task-create-date') as HTMLInputElement;
  const createPriority = el('task-create-priority') as HTMLSelectElement;
  const createButton = el('task-create-button') as HTMLButtonElement;
  const createReminder = el('task-create-reminder') as HTMLInputElement;
  const companion = setupTaskCompanion(el('task-companion'), showError, () => loadItems());
  let status: TaskListStatus = { connected: false, remembered: false, canRemember: false };
  let revision = 0;
  let busy = false;
  let reloadRequested = false;
  let draft: { key: string; id: string } | undefined;
  createDate.value = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  function showMessage(text: string, error = false): void {
    for (const target of [message, accountMessage]) { target.textContent = text; target.classList.toggle('task-error', error); }
  }
  function showError(error: unknown): void {
    showMessage(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试。', true);
  }
  function setBusy(value: boolean): void {
    busy = value;
    loginButton.disabled = logout.disabled = refresh.disabled = view.disabled = accountButton.disabled = createButton.disabled = value;
    createName.disabled = createDate.disabled = createPriority.disabled = value;
    createReminder.disabled = value;
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.task-editor input, .task-editor select').forEach((input) => { input.disabled = value; });
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-task-write]').forEach((button) => { button.disabled = value; });
    loginButton.textContent = value ? '连接中…' : '连接清单';
  }
  function clearItems(): void { list.replaceChildren(); summary.textContent = ''; updated.textContent = ''; }
  function renderStatus(next: TaskListStatus): void {
    if (status.connected !== next.connected || status.username !== next.username) window.dispatchEvent(new Event('pet:account'));
    companion.account(next.connected ? next.username ?? 'connected' : '');
    status = next;
    form.hidden = next.connected;
    connected.hidden = !next.connected;
    el('task-account-connected').hidden = !next.connected;
    el('task-disconnected').hidden = next.connected;
    el('task-account-title').textContent = next.connected ? '清单账号' : '连接清单账号';
    accountButton.textContent = next.connected ? `👤 ${next.username}` : '连接账号';
    accountButton.title = next.connected ? '管理清单账号' : '登录原清单账号';
    account.textContent = next.connected ? `${next.username} · ${next.remembered ? '已记住登录' : '仅本次登录'}` : '';
    remember.disabled = !next.canRemember;
    if (!next.canRemember) remember.checked = false;
    if (!next.connected) { clearItems(); draft = undefined; }
  }

  async function mutate(operation: () => Promise<unknown>, successText = '已保存到清单。'): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    showMessage('正在保存…');
    let success = false;
    try { await operation(); success = true; showMessage('已保存到清单。'); }
    catch (error) { showError(error); }
    finally { setBusy(false); }
    if (success) { await loadItems(); if (!message.classList.contains('task-error')) showMessage(successText); }
    return success;
  }

  function editTask(item: LinkedTask, kind: TaskListKind, li: HTMLLIElement): void {
    if (busy || li.querySelector('form')) return;
    const editor = document.createElement('form');
    editor.className = 'task-editor';
    const name = document.createElement('input');
    name.value = item.name; name.maxLength = 500; name.required = true; name.setAttribute('aria-label', '修改任务名称');
    const priority = document.createElement('select');
    priority.setAttribute('aria-label', '修改优先级');
    for (const [value, label] of Object.entries({ high: '高优先级', medium: '中优先级', low: '低优先级' })) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; priority.append(option);
    }
    priority.value = item.priority;
    const reminder = document.createElement('input'); reminder.type = 'datetime-local'; reminder.setAttribute('aria-label', '提醒时间（北京时间，留空取消）'); reminder.value = reminderValue(item.reminderAt);
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = '保存'; save.className = 'action-btn'; save.dataset.taskWrite = '';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.className = 'action-btn'; cancel.dataset.taskWrite = '';
    cancel.addEventListener('click', () => editor.remove());
    editor.append(name, priority, save, cancel);
    if (kind === 'daily') { const label = document.createElement('label'); label.textContent = '到点提醒（北京时间，留空取消）'; label.append(reminder); editor.append(label); }
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!api || !name.value.trim()) return;
      void mutate(() => api.update({ id: item.id, kind, patch: { name: name.value.trim(), priority: priority.value as LinkedTask['priority'], ...(kind === 'daily' ? { reminderAt: reminderISO(reminder.value) } : {}) },
        ...(item.updatedAt ? { expectedUpdatedAt: item.updatedAt } : {}) }));
    });
    li.append(editor); name.focus(); name.select();
  }

  function renderItems(snapshot: TaskListSnapshot): void {
    clearItems();
    const kind: TaskListKind = snapshot.view === 'week' ? 'weekly' : 'daily';
    const done = snapshot.items.filter((item) => item.completed).length;
    summary.textContent = snapshot.view === 'pending' ? `全部未完成：${snapshot.items.length} 项` : `${snapshot.view === 'week' ? `${snapshot.date} 起的本周计划` : `${snapshot.date} 今日任务`} · ${done}/${snapshot.items.length} 已完成`;
    updated.textContent = `更新于 ${new Date(snapshot.fetchedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
    createButton.textContent = kind === 'weekly' ? '添加周计划' : '添加任务';
    el('task-create-reminder-label').hidden = kind === 'weekly';
    createName.placeholder = kind === 'weekly' ? '记一项周计划…' : '记一项任务…';
    if (!snapshot.items.length) {
      const empty = document.createElement('li'); empty.className = 'task-empty';
      empty.textContent = snapshot.view === 'pending' ? '没有未完成任务，轻松一下吧。' : '这里还没有任务。'; list.append(empty);
    }
    for (const [index, item] of snapshot.items.entries()) {
      const li = document.createElement('li'); li.className = `linked-task${item.completed ? ' is-complete' : ''}`;
      const row = document.createElement('div'); row.className = 'linked-task-row';
      const state = document.createElement('input'); state.type = 'checkbox'; state.checked = item.completed; state.className = 'linked-task-state'; state.dataset.taskWrite = '';
      state.setAttribute('aria-label', `${item.completed ? '恢复未完成' : '标记完成'}：${item.name}`);
      state.addEventListener('change', () => {
        const desired = state.checked; state.checked = item.completed;
        if (api) void mutate(() => api.update({ id: item.id, kind, patch: { completed: desired }, ...(item.updatedAt ? { expectedUpdatedAt: item.updatedAt } : {}) }));
      });
      const content = document.createElement('div'); content.className = 'linked-task-content';
      const title = document.createElement('p'); title.className = 'linked-task-name'; title.textContent = `${index + 1}. ${item.name}`;
      title.tabIndex = 0; title.setAttribute('role', 'button'); title.title = '选中这项任务，继续在对话里操作';
      const select = async () => {
        try { await api?.select({ id: item.id, kind }); window.dispatchEvent(new CustomEvent('pet:select', { detail: item.name })); }
        catch (error) { showError(error); }
      };
      title.addEventListener('click', () => void select()); title.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void select(); } });
      const detail = document.createElement('p'); detail.className = `linked-task-detail priority-${item.priority}`;
      detail.textContent = `${{ high: '高', medium: '中', low: '低' }[item.priority]}优先级${snapshot.view === 'pending' ? ` · ${new Date(new Date(item.createdAt).getTime() + 8 * 3600_000).toISOString().slice(0, 10)}` : ''}`;
      if (item.reminderAt) detail.textContent += ` · 提醒 ${reminderValue(item.reminderAt).replace('T', ' ')}`;
      if (item.elapsedSeconds) detail.textContent += ` · 专注 ${Math.floor(item.elapsedSeconds / 60)} 分钟`;
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'action-btn task-edit-button'; edit.textContent = '编辑'; edit.dataset.taskWrite = '';
      edit.setAttribute('aria-label', `编辑：${item.name}`); edit.addEventListener('click', () => editTask(item, kind, li));
      content.append(title, detail); row.append(state, content, edit); li.append(row); list.append(li);
      companion.actions(item, kind, row);
    }
  }

  async function loadItems(): Promise<void> {
    if (!api || !status.connected || busy) return;
    reloadRequested = false;
    const request = ++revision;
    setBusy(true); showMessage('正在读取清单…'); clearItems();
    try {
      const snapshot = await api.list(view.value as TaskListView);
      if (request !== revision) return;
      renderItems(snapshot); showMessage('');
    } catch (error) {
      if (request !== revision) return;
      showError(error);
      try { renderStatus(await api.status()); } catch { /* preserve original error */ }
    } finally {
      if (request === revision) {
        setBusy(false);
        if (reloadRequested) await open();
      }
    }
  }

  async function open(): Promise<void> {
    if (!api || busy) return;
    try { renderStatus(await api.status()); await loadItems(); if (status.connected) await companion.open(); }
    catch (error) { showError(error); }
  }

  accountButton.addEventListener('click', () => { accountMessage.textContent = ''; dialog.showModal(); });
  el('task-account-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { password.value = ''; });
  form.addEventListener('submit', (event) => {
    event.preventDefault(); if (!api || busy) return;
    setBusy(true); showMessage('正在连接账号…');
    const input = { username: username.value.trim(), password: password.value, remember: remember.checked }; password.value = '';
    void (async () => {
      try { renderStatus(await api.login(input)); showMessage(''); dialog.close(); }
      catch (error) { showError(error); }
      finally { input.password = ''; setBusy(false); }
      if (status.connected) { await loadItems(); await companion.open(); }
    })();
  });
  logout.addEventListener('click', () => {
    if (!api || busy) return;
    ++revision; clearItems(); setBusy(true);
    void (async () => {
      try { renderStatus(await api.logout()); showMessage('已退出清单账号。'); dialog.close(); }
      catch (error) { showError(error); }
      finally { setBusy(false); }
    })();
  });
  createForm.addEventListener('submit', (event) => {
    event.preventDefault(); if (!api || busy || !createName.value.trim()) return;
    const fields = { kind: (view.value === 'week' ? 'weekly' : 'daily') as TaskListKind, name: createName.value.trim(), date: createDate.value, priority: createPriority.value as LinkedTask['priority'], ...(view.value !== 'week' && createReminder.value ? { reminderAt: reminderISO(createReminder.value) } : {}) };
    const key = JSON.stringify(fields);
    if (!draft || draft.key !== key) draft = { key, id: crypto.randomUUID() };
    const input: TaskListCreateInput = { ...fields, id: draft.id };
    void mutate(async () => { await api.create(input); draft = undefined; createName.value = ''; createReminder.value = ''; }, `已添加${fields.kind === 'weekly' ? '周计划' : '任务'}，日期：${fields.date}。其他日期的任务可在聊天中查询。`);
  });
  refresh.addEventListener('click', () => void loadItems());
  view.addEventListener('change', () => void loadItems());
  el('task-open-website').addEventListener('click', () => { void api?.openWebsite().catch(showError); });
  window.petAPI?.events.onTaskListUpdated(() => {
    if (!el('panel-tasks').classList.contains('active')) { void api?.status().then(renderStatus).then(() => companion.open()).catch(() => {}); return; }
    if (busy) reloadRequested = true; else void open();
  });
  // The compact chat can be the first surface opened after launch. Initialize
  // local account/timer visibility without fetching the task database.
  void api?.status().then(renderStatus).then(() => companion.open()).catch(() => {});
  return { open };
}
