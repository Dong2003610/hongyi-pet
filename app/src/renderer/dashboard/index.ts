import spec from '../../../pet-spec.json';
import type { ChatMessage, PetSpec, PetStats, Settings, InteractionSpec, Reminder, ReminderRepeat } from '../../shared/contracts';
import './index.css';
import { setupTaskList } from './task-list';
import { setupNews } from './news';

const petSpec = spec as PetSpec;
document.title = `${petSpec.character.displayName}的小屋`;

const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

const petNameEl = document.getElementById('pet-name') as HTMLHeadingElement;
const petNameInput = document.getElementById('pet-name-input') as HTMLInputElement;
const petAvatarImg = document.getElementById('pet-avatar-img') as HTMLImageElement;

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const toggleOpenAtLogin = document.getElementById('toggle-open-at-login') as HTMLDivElement;
const toggleSound = document.getElementById('toggle-sound') as HTMLDivElement;
const toggleSedentary = document.getElementById('toggle-sedentary') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;
const chatMessages = document.getElementById('chat-messages') as HTMLDivElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSendBtn = document.getElementById('chat-send') as HTMLButtonElement;
const reminderTextInput = document.getElementById('reminder-text') as HTMLInputElement;
const reminderTimeInput = document.getElementById('reminder-time') as HTMLInputElement;
const reminderRepeatSelect = document.getElementById('reminder-repeat') as HTMLSelectElement;
const reminderAddBtn = document.getElementById('reminder-add-btn') as HTMLButtonElement;
const remindersListEl = document.getElementById('reminders-list') as HTMLDivElement;
const pomodoroStatusEl = document.getElementById('pomodoro-status') as HTMLSpanElement;
const pomodoroTimerEl = document.getElementById('pomodoro-timer') as HTMLSpanElement;
const pomodoroStartBtn = document.getElementById('pomodoro-start-btn') as HTMLButtonElement;
const pomodoroStopBtn = document.getElementById('pomodoro-stop-btn') as HTMLButtonElement;
const pomodoroWorkInput = document.getElementById('pomodoro-work-min') as HTMLInputElement;
const pomodoroBreakInput = document.getElementById('pomodoro-break-min') as HTMLInputElement;
const aiHintEl = document.getElementById('ai-hint') as HTMLSpanElement;
const chatClearBtn = document.getElementById('chat-clear') as HTMLButtonElement;
const openPocketBtn = document.getElementById('open-pocket-btn') as HTMLButtonElement;
const taskListPanel = setupTaskList();
let historyEpoch = 0;
let chatVersion = 0;

function setChatBusy(value: boolean): void {
  chatSendBtn.disabled = chatClearBtn.disabled = value;
  chatMessages.setAttribute('aria-busy', String(value));
  document.querySelectorAll<HTMLButtonElement>('[data-chat-prompt]').forEach((button) => { button.disabled = value; });
}

// Keep the main navigation small; secondary surfaces retain direct back links.
document.querySelector('#panel-interact .settings-group')?.before(document.querySelector('.stats-grid')!);
document.querySelector('#panel-interact .pomodoro-bar')?.closest('.settings-group')?.setAttribute('hidden', '');
const reminderDetails = document.createElement('details'); reminderDetails.className = 'today-reminders';
const reminderSummary = document.createElement('summary'); reminderSummary.textContent = '接下来的提醒'; reminderDetails.append(reminderSummary);
const oldReminderPanel = document.getElementById('panel-reminder')!;
while (oldReminderPanel.firstChild) reminderDetails.append(oldReminderPanel.firstChild);
document.getElementById('panel-tasks')!.append(reminderDetails); oldReminderPanel.remove();
document.querySelector('.header-tools')?.prepend(document.getElementById('task-account-button')!);

let currentSettings: Settings | null = null;
let pomodoroEndsAt = 0;
let pomodoroInterval: ReturnType<typeof setInterval> | undefined;

// ── Avatar ──
try {
  const avatarUrl = require('../../assets/pet/core-ip/core-ip.png');
  petAvatarImg.src = avatarUrl;
} catch { petAvatarImg.style.display = 'none'; }

// ── Display name ──
async function loadDisplayName(): Promise<void> {
  const s = await window.petAPI?.settings.get();
  const name = s?.displayName || petSpec.character.displayName;
  petNameEl.textContent = name;
  document.title = `${name}的小屋`;
}
function startEditName(): void {
  petNameInput.value = petNameEl.textContent || '';
  petNameEl.style.display = 'none';
  petNameInput.style.display = 'inline-block';
  petNameInput.focus();
  petNameInput.select();
}
async function saveEditName(): Promise<void> {
  const newName = petNameInput.value.trim();
  petNameInput.style.display = 'none';
  petNameEl.style.display = '';
  if (newName && newName !== (petNameEl.textContent || '')) {
    try {
      await window.petAPI?.settings.update({ displayName: newName });
      petNameEl.textContent = newName;
      document.title = `${newName}的小屋`;
    } catch { petNameEl.textContent = petSpec.character.displayName; }
  }
}
petNameEl.addEventListener('click', startEditName);
petNameInput.addEventListener('blur', saveEditName);
petNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); petNameInput.blur(); }
  else if (e.key === 'Escape') { petNameInput.style.display = 'none'; petNameEl.style.display = ''; }
});
window.petAPI?.events.onDisplayName((name: string) => {
  petNameEl.textContent = name;
  document.title = `${name}的小屋`;
});
document.getElementById('pet-personality')!.textContent = petSpec.character.personality.join('、');

// ── Stats ──
function updateStats(stats: PetStats): void {
  affectionEl.textContent = String(stats.affection);
  moodEl.textContent = String(stats.mood);
  todayInteractionsEl.textContent = String(stats.todayInteractions);
  const unit = document.createElement('small');
  unit.textContent = '分钟';
  companionMinutesEl.replaceChildren(String(stats.companionMinutes), unit);
}
async function loadStats(): Promise<void> {
  const stats = await window.petAPI?.interactions.stats();
  if (stats) updateStats(stats);
}
window.petAPI?.events.onStats((s: PetStats) => updateStats(s));

// ── Chat ──
function appendChat(role: string, text: string, message?: ChatMessage, restored = false): void {
  if (!restored) chatVersion++;
  if (!restored && message?.activeTaskName !== undefined) showSelection(message.activeTaskName);
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const roleSpan = document.createElement('span');
  roleSpan.className = 'role';
  roleSpan.textContent = role === 'me' ? '我' : '💬';
  const content = document.createElement('p'); content.className = 'chat-content';
  content.textContent = message?.cards?.some((card) => card.kind === 'choice' || card.kind === 'task') && /\n\d+\./.test(text) ? text.split('\n')[0]! : text;
  div.classList.add(role === 'me' ? 'from-me' : 'from-pet'); div.append(roleSpan, content);
  if (message?.cards?.length) {
    const group = document.createElement('div'); group.className = 'chat-cards';
    message.cards.forEach((card, index) => {
      const item = document.createElement('article'); item.className = `chat-card card-${card.kind}`;
      const title = document.createElement('strong'); title.textContent = `${message.cards!.length > 1 ? `${index + 1}. ` : ''}${card.title}`;
      const detail = document.createElement('p'); detail.textContent = card.detail ?? ''; item.append(title, detail);
      if (card.kind === 'news' && card.url && window.petAPI?.news) {
        const link = document.createElement('button'); link.type = 'button'; link.className = 'news-source-link'; link.textContent = '查看原文 ↗';
        link.addEventListener('click', () => void window.petAPI!.news!.open(card.url!).catch(() => { link.textContent = '链接打开失败，请稍后重试'; }));
        item.append(link);
      }
      if (card.state === 'failed') item.classList.add('has-error');
      if (!restored && card.actions?.length) {
        const actions = document.createElement('div'); actions.className = 'chat-card-actions';
        for (const action of card.actions) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
          button.addEventListener('click', async () => {
            if (chatSendBtn.disabled) return;
            setChatBusy(true); actions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
            const original = button.textContent; button.textContent = '处理中…';
            try { const reply = await window.petAPI!.chat.act(action.id); appendChat('pet', reply.content, reply); }
            catch { appendChat('pet', '操作结果未能返回，请查询任务状态后再操作。'); }
            finally { setChatBusy(false); button.textContent = original; }
          }); actions.append(button);
        } item.append(actions);
      } else if (restored) { const label = document.createElement('small'); label.textContent = '历史操作记录 · 当前状态可重新查询'; item.append(label); }
      group.append(item);
    }); div.append(group);
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
async function sendChat(): Promise<void> {
  if (chatSendBtn.disabled) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendChat('me', text);
  setChatBusy(true);
  try {
    if (!window.petAPI) throw new Error('聊天服务暂不可用');
    if (window.petAPI?.chat.turn) { const reply = await window.petAPI.chat.turn(text); appendChat('pet', reply.content, reply); }
    else { const reply = await window.petAPI?.chat.send(text); if (reply) appendChat('pet', reply); }
  } catch {
    appendChat('pet', '回复未能返回。涉及任务操作时，请先查询当前状态，避免重复新增。');
    if (!chatInput.value) chatInput.value = text;
  }
  finally { setChatBusy(false); }
}
chatSendBtn.addEventListener('click', () => void sendChat());
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void sendChat(); } });
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const prompt = target.closest<HTMLElement>('[data-chat-prompt]')?.dataset.chatPrompt;
  if (prompt && !chatSendBtn.disabled) { activateTab('chat'); chatInput.value = prompt; void sendChat(); }
  const tab = target.closest<HTMLElement>('[data-open-nav]')?.dataset.openNav;
  if (tab) { activateTab(tab); if (tab === 'settings') void loadAiConfiguration(); }
});
window.addEventListener('pet:ask', (event) => { if (chatSendBtn.disabled) return; activateTab('chat'); chatInput.value = (event as CustomEvent<string>).detail; void sendChat(); });
function showSelection(name: string | null): void {
  const selection = document.getElementById('chat-selection')!; selection.hidden = !name; selection.textContent = name ? `当前选中：${name}` : '';
}
window.addEventListener('pet:account', () => { showSelection(null); chatMessages.replaceChildren(); void loadChatHistory(); });
window.addEventListener('pet:select', (event) => {
  showSelection((event as CustomEvent<string>).detail);
  activateTab('chat'); chatInput.focus();
});
window.petAPI?.events.onDashboardMode?.((mode) => {
  document.body.classList.toggle('quick-chat', mode === 'quick');
  if (mode === 'quick') { activateTab('chat'); requestAnimationFrame(() => chatInput.focus()); }
});
document.getElementById('quick-open-house')?.addEventListener('click', () => { void window.petAPI?.window.showDashboard().catch(() => {}); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('quick-chat')) void window.petAPI?.window.hideDashboard().catch(() => {});
});

// ── Interactions ──
async function loadInteractions(): Promise<void> {
  const interactions = await window.petAPI?.interactions.list();
  if (!interactions) return;
  interactionsList.replaceChildren();
  for (const interaction of interactions) {
    const btn = document.createElement('button');
    btn.className = 'interaction-btn';
    const emoji = document.createElement('span');
    emoji.textContent = interaction.emoji;
    const label = document.createElement('span');
    label.textContent = interaction.label;
    btn.append(emoji, label);
    btn.addEventListener('click', async () => {
      try { await window.petAPI?.interactions.trigger(interaction.id); } catch {}
    });
    interactionsList.appendChild(btn);
  }
}

// ── Pomodoro ──
function updatePomodoroUI(phase: string, endsAt: number): void {
  if (phase === 'idle') {
    pomodoroStatusEl.textContent = '未开始';
    pomodoroTimerEl.textContent = '';
    pomodoroStartBtn.style.display = '';
    pomodoroStopBtn.style.display = 'none';
    pomodoroEndsAt = 0;
  } else {
    pomodoroStatusEl.textContent = phase === 'work' ? '专注中' : '休息中';
    pomodoroStartBtn.style.display = 'none';
    pomodoroStopBtn.style.display = '';
    pomodoroEndsAt = endsAt;
  }
}
function tickPomodoro(): void {
  if (pomodoroEndsAt <= 0) { pomodoroTimerEl.textContent = ''; return; }
  const remaining = Math.max(0, Math.ceil((pomodoroEndsAt - Date.now()) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  pomodoroTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
}
pomodoroStartBtn.addEventListener('click', async () => {
  const r = await window.petAPI?.pomodoro.start();
  if (r) updatePomodoroUI(r.phase, r.endsAt);
});
pomodoroStopBtn.addEventListener('click', async () => {
  await window.petAPI?.pomodoro.stop();
  updatePomodoroUI('idle', 0);
});
window.petAPI?.events.onPomodoro((r) => updatePomodoroUI(r.phase, r.endsAt));

async function savePomodoroConfig(): Promise<void> {
  if (!currentSettings) return;
  const work = Math.max(5, Math.min(180, Math.round(Number(pomodoroWorkInput.value) || 25)));
  const rest = Math.max(1, Math.min(60, Math.round(Number(pomodoroBreakInput.value) || 5)));
  pomodoroWorkInput.value = String(work);
  pomodoroBreakInput.value = String(rest);
  try {
    await window.petAPI?.settings.update({ pomodoroWorkMin: work, pomodoroBreakMin: rest });
    currentSettings.pomodoroWorkMin = work;
    currentSettings.pomodoroBreakMin = rest;
  } catch {}
}
pomodoroWorkInput.addEventListener('change', () => void savePomodoroConfig());
pomodoroBreakInput.addEventListener('change', () => void savePomodoroConfig());

// ── Reminders ──
function setDefaultReminderTime(): void {
  const now = new Date(Date.now() + 8 * 3600_000);
  now.setUTCHours(now.getUTCHours() + 1);
  reminderTimeInput.value = now.toISOString().slice(0, 16);
}
setDefaultReminderTime();

reminderAddBtn.addEventListener('click', async () => {
  const text = reminderTextInput.value.trim();
  const time = reminderTimeInput.value;
  if (!text || !time) return;
  const repeat = reminderRepeatSelect.value as ReminderRepeat;
  reminderAddBtn.disabled = true;
  try {
    await window.petAPI?.reminders.save({ text, dueAt: new Date(`${time}:00+08:00`).toISOString(), repeat });
    reminderTextInput.value = '';
    setDefaultReminderTime();
    reminderRepeatSelect.value = 'none';
    await loadReminders();
  } catch { remindersListEl.textContent = '提醒保存失败，请重试；同名任务可在对话中选择。'; }
  finally { reminderAddBtn.disabled = false; }
});

async function loadReminders(): Promise<void> {
  let reminders: Reminder[] | undefined; let feedError: string | undefined;
  try {
    if (window.petAPI?.reminders.feed) { const feed = await window.petAPI.reminders.feed(); reminders = feed.items; feedError = feed.error; }
    else reminders = await window.petAPI?.reminders.list();
  } catch { remindersListEl.textContent = '提醒读取失败，请重试。'; return; }
  if (!reminders) return;
  remindersListEl.replaceChildren();
  if (feedError) { const p = document.createElement('p'); p.className = 'task-error'; p.textContent = feedError; remindersListEl.append(p); }
  if (reminders.length === 0) {
    const p = document.createElement('p');
    p.textContent = '暂无提醒';
    p.style.cssText = 'font-size:12px;color:var(--muted);padding:6px 0;';
    remindersListEl.appendChild(p);
    return;
  }
  for (const r of reminders) {
    const item = document.createElement('div');
    item.className = 'reminder-item';
    const info = document.createElement('div');
    info.className = 'info';
    const dueDate = new Date(Date.parse(r.dueAt) + 8 * 3600_000);
    const time = document.createElement('div');
    time.className = 'time';
    const dateStr = `${dueDate.getUTCMonth() + 1}/${dueDate.getUTCDate()} ${String(dueDate.getUTCHours()).padStart(2, '0')}:${String(dueDate.getUTCMinutes()).padStart(2, '0')}`;
    time.textContent = `${dateStr} · ${r.source === 'task' ? '任务提醒 · 已同步' : '本机提醒'}`;
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = r.text;
    if (r.repeat && r.repeat !== 'none') {
      const tag = document.createElement('span');
      tag.className = 'repeat-tag';
      tag.textContent = r.repeat === 'daily' ? '每天' : '工作日';
      time.appendChild(tag);
    }
    info.append(time, text);
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      try { await window.petAPI?.reminders.remove(r.id, r.source); await loadReminders(); }
      catch { delBtn.textContent = '重试'; delBtn.disabled = false; }
    });
    item.append(info, delBtn);
    remindersListEl.appendChild(item);
  }
}
window.petAPI?.events.onRemindersUpdated(() => void loadReminders());
window.petAPI?.events.onTaskListUpdated(() => void loadReminders());

// ── Settings ──
async function loadSettings(): Promise<void> {
  const s = await window.petAPI?.settings.get();
  if (!s) return;
  currentSettings = s;
  setToggle(toggleAlwaysOnTop, s.alwaysOnTop);
  setToggle(toggleClickThrough, s.clickThrough);
  setToggle(toggleOpenAtLogin, s.openAtLogin);
  setToggle(toggleSound, s.soundEnabled);
  setToggle(toggleSedentary, s.sedentaryReminder);
  pomodoroWorkInput.value = String(s.pomodoroWorkMin ?? 25);
  pomodoroBreakInput.value = String(s.pomodoroBreakMin ?? 5);
  const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
  sizeBtns.forEach((btn) => {
    const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
    btn.classList.toggle('active', Math.abs(scale - s.petScale) < 0.01);
  });
}

function setToggle(el: HTMLDivElement, active: boolean): void {
  el.classList.toggle('active', active);
}

async function toggleSetting(key: keyof Settings, el: HTMLDivElement): Promise<void> {
  if (!currentSettings) return;
  const current = currentSettings[key];
  const newVal = typeof current === 'boolean' ? !current : current;
  try {
    await window.petAPI?.settings.update({ [key]: newVal } as Partial<Settings>);
    (currentSettings as unknown as Record<string, unknown>)[key] = newVal;
    setToggle(el, Boolean(newVal));
  } catch {}
}

toggleAlwaysOnTop.addEventListener('click', () => void toggleSetting('alwaysOnTop', toggleAlwaysOnTop));
toggleClickThrough.addEventListener('click', () => void toggleSetting('clickThrough', toggleClickThrough));
toggleOpenAtLogin.addEventListener('click', () => void toggleSetting('openAtLogin', toggleOpenAtLogin));
toggleSound.addEventListener('click', () => void toggleSetting('soundEnabled', toggleSound));
toggleSedentary.addEventListener('click', () => void toggleSetting('sedentaryReminder', toggleSedentary));

sizeSelector.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  if (!currentSettings) return;
  const scale = parseFloat(target.dataset.scale || '1');
  try {
    await window.petAPI?.settings.update({ petScale: scale });
    currentSettings.petScale = scale;
    sizeSelector.querySelectorAll('.size-btn').forEach((btn) => btn.classList.remove('active'));
    target.classList.add('active');
  } catch {}
});

// ── File pocket ──
openPocketBtn.addEventListener('click', async () => { await window.petAPI?.files.openPocket(); });

// ── Close ──
closeBtn.addEventListener('click', async () => { await window.petAPI?.window.hideDashboard(); });

// ── Drag ──
let dragging = false;
document.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return;
  const dragArea = document.getElementById('drag-area');
  if (!dragArea) return;
  const rect = dragArea.getBoundingClientRect();
  if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
    if (e.button === 0) { dragging = true; e.preventDefault(); window.petAPI?.window.beginDrag(); }
  }
});
document.addEventListener('mousemove', () => { if (dragging) window.petAPI?.window.updateDrag(); });
document.addEventListener('mouseup', () => { if (dragging) { dragging = false; window.petAPI?.window.endDrag(); } });

// ── Tabs ──
const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
const tabPanels = document.querySelectorAll<HTMLDivElement>('.tab-panel');
function activateTab(name: string): void {
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));
  if (name === 'chat') chatMessages.scrollTop = chatMessages.scrollHeight;
  if (name === 'tasks') void taskListPanel.open();
}
document.getElementById('tab-bar')?.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('.tab-btn') as HTMLElement | null;
  if (target?.dataset.tab) activateTab(target.dataset.tab);
});

async function loadChatHistory(): Promise<void> {
  const epoch = ++historyEpoch; const version = chatVersion;
  try {
    const history = await window.petAPI?.chat.history();
    if (history && epoch === historyEpoch && version === chatVersion) { chatMessages.replaceChildren(); history.forEach((message) => appendChat(message.role === 'user' ? 'me' : 'pet', message.content, message, true)); }
  } catch { if (epoch === historyEpoch) appendChat('pet', '历史对话暂时读取失败，可以继续聊天。'); }
}

chatClearBtn.addEventListener('click', async () => {
  if (chatSendBtn.disabled) return;
  historyEpoch++; setChatBusy(true);
  try { await window.petAPI?.chat.clear(); chatMessages.replaceChildren(); chatVersion++; showSelection(null); }
  catch { appendChat('pet', '清空失败，原有对话已保留，请稍后重试。'); }
  finally { setChatBusy(false); }
});

async function loadAiConfiguration(): Promise<void> {
  if (!window.petAPI?.ai.configuration) return;
  try {
    const config = await window.petAPI.ai.configuration();
    (document.getElementById('ai-base-url') as HTMLInputElement).value = config.baseUrl;
    (document.getElementById('ai-model') as HTMLInputElement).value = config.model;
    (document.getElementById('ai-city') as HTMLInputElement).value = config.city;
    (document.getElementById('ai-api-key') as HTMLInputElement).value = '';
  } catch { document.getElementById('ai-config-message')!.textContent = '配置读取失败，请重试。'; }
}
document.getElementById('ai-config-form')!.addEventListener('submit', (event) => {
  event.preventDefault(); const field = (id: string) => document.getElementById(id) as HTMLInputElement;
  const message = document.getElementById('ai-config-message')!;
  void window.petAPI?.ai.configure({ baseUrl: field('ai-base-url').value.trim(), model: field('ai-model').value.trim(), apiKey: field('ai-api-key').value, city: field('ai-city').value.trim() })
    .then(() => { field('ai-api-key').value = ''; message.textContent = '已保存，即刻生效。可点击连接测试确认服务可用。'; aiHintEl.textContent = 'AI 已配置'; })
    .catch(() => { message.textContent = '保存失败，请检查服务地址、模型和密钥。'; });
});
document.getElementById('ai-test')!.addEventListener('click', async () => {
  const button = document.getElementById('ai-test') as HTMLButtonElement; const message = document.getElementById('ai-config-message')!;
  button.disabled = true; message.textContent = '正在连接…';
  try { await window.petAPI?.ai.test(); message.textContent = '连接成功，可以开始聊天。'; }
  catch { message.textContent = '连接失败，请检查网络、服务地址、模型和密钥。'; }
  finally { button.disabled = false; }
});

// ── Init ──
async function init(): Promise<void> {
  setupNews();
  activateTab('chat');
  await loadChatHistory();
  await loadDisplayName();
  await loadInteractions();
  await loadSettings();
  await loadStats();
  await loadReminders();
  const aiEnabled = await window.petAPI?.ai.status();
  aiHintEl.textContent = aiEnabled
    ? 'AI 已配置'
    : '本地助手 · 可在设置中连接 AI';
  if (pomodoroInterval) clearInterval(pomodoroInterval);
  pomodoroInterval = setInterval(tickPomodoro, 500);
  const ps = await window.petAPI?.pomodoro.status();
  if (ps) updatePomodoroUI(ps.phase, ps.endsAt);
}

init();
window.petAPI?.events.onNews?.((message) => appendChat('pet', message.content, message));
