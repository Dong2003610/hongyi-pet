import spec from '../../../pet-spec.json';
import type { PetSpec, Reminder, ReminderRepeat } from '../../shared/contracts';
import './index.css';

const petSpec = spec as PetSpec;
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

const textInput = document.getElementById('reminder-text') as HTMLInputElement;
const timeInput = document.getElementById('reminder-time') as HTMLInputElement;
const repeatSelect = document.getElementById('reminder-repeat') as HTMLSelectElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const composeCard = document.getElementById('compose-card') as HTMLDivElement;
const dueSoonCard = document.getElementById('due-soon-card') as HTMLDivElement;
const dueTextEl = document.getElementById('due-text') as HTMLDivElement;
const knowBtn = document.getElementById('know-btn') as HTMLButtonElement;

let currentDueId = '';

function setDefaultTime(): void {
  const now = new Date();
  now.setHours(now.getHours() + 1);
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  timeInput.value = `${y}-${mo}-${d}T${h}:${mi}`;
}
setDefaultTime();

function showCompose(): void {
  composeCard.style.display = '';
  dueSoonCard.classList.remove('show');
}

function showDueSoon(reminder: Reminder): void {
  composeCard.style.display = 'none';
  dueSoonCard.classList.add('show');
  currentDueId = reminder.id;
  dueTextEl.textContent = reminder.text;
}

saveBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  const time = timeInput.value;
  if (!text || !time) return;
  const repeat = repeatSelect.value as ReminderRepeat;
  try {
    await window.petAPI?.reminders.save({ text, dueAt: new Date(time).toISOString(), repeat });
    textInput.value = '';
    setDefaultTime();
    repeatSelect.value = 'none';
    await window.petAPI?.window.hideReminder();
  } catch {}
});

cancelBtn.addEventListener('click', async () => {
  textInput.value = '';
  setDefaultTime();
  repeatSelect.value = 'none';
  await window.petAPI?.window.hideReminder();
});

knowBtn.addEventListener('click', async () => {
  if (currentDueId) {
    await window.petAPI?.reminders.remove(currentDueId);
    currentDueId = '';
  }
  await window.petAPI?.window.hideReminder();
});

dueSoonCard.querySelectorAll('.btn-snooze').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const minutes = parseInt((btn as HTMLElement).dataset.minutes || '5', 10);
    if (currentDueId) {
      await window.petAPI?.reminders.snooze(currentDueId, minutes);
      currentDueId = '';
    }
    await window.petAPI?.window.hideReminder();
  });
});

window.petAPI?.events.onReminder((reminder: Reminder) => {
  showDueSoon(reminder);
});

window.petAPI?.events.onReminderCompose(() => {
  showCompose();
  setDefaultTime();
  textInput.focus();
});
