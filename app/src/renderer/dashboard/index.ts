import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, InteractionSpec, Reminder, ReminderRepeat } from '../../shared/contracts';
import './index.css';

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
function appendChat(role: string, text: string): void {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const roleSpan = document.createElement('span');
  roleSpan.className = 'role';
  roleSpan.textContent = role === 'me' ? '我' : '💬';
  div.append(roleSpan, ` ${text}`);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
async function sendChat(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendChat('me', text);
  try {
    const reply = await window.petAPI?.chat.send(text);
    if (reply) appendChat('pet', reply);
  } catch { appendChat('pet', '……'); }
}
chatSendBtn.addEventListener('click', () => void sendChat());
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void sendChat(); } });

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
  const now = new Date();
  now.setHours(now.getHours() + 1);
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  reminderTimeInput.value = `${y}-${mo}-${d}T${h}:${mi}`;
}
setDefaultReminderTime();

reminderAddBtn.addEventListener('click', async () => {
  const text = reminderTextInput.value.trim();
  const time = reminderTimeInput.value;
  if (!text || !time) return;
  const repeat = reminderRepeatSelect.value as ReminderRepeat;
  try {
    await window.petAPI?.reminders.save({ text, dueAt: new Date(time).toISOString(), repeat });
    reminderTextInput.value = '';
    setDefaultReminderTime();
    reminderRepeatSelect.value = 'none';
    await loadReminders();
  } catch {}
});

async function loadReminders(): Promise<void> {
  const reminders = await window.petAPI?.reminders.list();
  if (!reminders) return;
  remindersListEl.replaceChildren();
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
    const dueDate = new Date(r.dueAt);
    const time = document.createElement('div');
    time.className = 'time';
    const dateStr = `${dueDate.getMonth() + 1}/${dueDate.getDate()} ${String(dueDate.getHours()).padStart(2, '0')}:${String(dueDate.getMinutes()).padStart(2, '0')}`;
    time.textContent = dateStr;
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
      await window.petAPI?.reminders.remove(r.id);
      await loadReminders();
    });
    item.append(info, delBtn);
    remindersListEl.appendChild(item);
  }
}
window.petAPI?.events.onRemindersUpdated(() => void loadReminders());

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
}
document.getElementById('tab-bar')?.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('.tab-btn') as HTMLElement | null;
  if (target?.dataset.tab) activateTab(target.dataset.tab);
});

async function loadChatHistory(): Promise<void> {
  const history = await window.petAPI?.chat.history();
  if (history) history.forEach((message) => appendChat(message.role === 'user' ? 'me' : 'pet', message.content));
}

chatClearBtn.addEventListener('click', async () => {
  await window.petAPI?.chat.clear();
  chatMessages.replaceChildren();
});

// ── Init ──
async function init(): Promise<void> {
  activateTab('chat');
  await loadChatHistory();
  await loadDisplayName();
  await loadInteractions();
  await loadSettings();
  await loadStats();
  await loadReminders();
  const aiEnabled = await window.petAPI?.ai.status();
  aiHintEl.textContent = aiEnabled
    ? '🤖 AI 聊天已启用'
    : '🤖 未启用 AI：在 %APPDATA%\\小红桌宠\\ 放置 ai-config.json 后重启（参见项目 README）';
  if (pomodoroInterval) clearInterval(pomodoroInterval);
  pomodoroInterval = setInterval(tickPomodoro, 500);
  const ps = await window.petAPI?.pomodoro.status();
  if (ps) updatePomodoroUI(ps.phase, ps.endsAt);
}

init();
