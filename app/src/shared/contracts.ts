export interface PetSpec {
  schemaVersion: number;
  app: {
    name: string;
    appId: string;
    version: string;
    language: string;
  };
  targets: {
    windows: { enabled: boolean; arch: string };
    macos: { enabled: boolean; arch: string };
  };
  character: {
    inputType: string;
    coreAsset: string;
    displayName: string;
    archetype: string;
    personality: string[];
    preserveTraits: string[];
    style: string;
    mirrorSafe: boolean;
  };
  assetPipeline: {
    backgroundMode: string;
    segmentationBackend: string;
    subjectKind: string;
    generationBackground: string;
    backgroundTolerance: number;
    edgeFeather: number;
    safeMargin: number;
    targetOccupancy: number;
  };
  experience: {
    theme: {
      primary: string;
      accent: string;
      background: string;
      surface: string;
      text: string;
      muted: string;
      cornerRadius: number;
    };
    petSizing: {
      baseWindowPx: number;
      defaultScale: number;
    };
    interactions: InteractionSpec[];
  };
  motion: {
    breathing: { enabled: boolean; periodMs: number; scaleX: number; scaleY: number };
    squashStretch: { enabled: boolean; durationMs: number; intensity: number };
    idleIntervalMs: { min: number; max: number };
  };
  features: {
    transparentWindow: boolean;
    drag: boolean;
    tray: boolean;
    edgeSnap: boolean;
    reminders: boolean;
    interactions: boolean;
    relationship: boolean;
    filePocket: boolean;
    dashboard: boolean;
    typingReaction: boolean;
    autonomousMovement: boolean;
  };
  states: PetState[];
  storage: {
    userData: string;
    filePocket: string;
  };
  build: {
    windows: { arch: string; installer: string; portable: string };
    macos: { arch: string; diskImage: string; portable: string };
    timeoutMinutes: number;
    unsigned: boolean;
  };
}

export interface InteractionSpec {
  id: string;
  emoji: string;
  label: string;
  stateId: string;
  durationMs: number;
  affectionGain: number;
  feedback: string[];
}

export interface PetState {
  id: string;
  triggers: string[];
  frames: string[];
  frameDurationMs: number;
  loop: boolean;
  priority: number;
  interrupt: string;
  cooldownMs: number;
  direction: string;
  anchor: { x: number; y: number };
  mirrorSafe: boolean;
  proceduralMotion?: 'breathing';
}

export interface PetStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  companionMinutes: number;
  lastInteractionDate: string;
}

export interface Settings {
  edgeSnap: boolean;
  alwaysOnTop: boolean;
  typingReaction: boolean;
  clickThrough: boolean;
  petScale: number;
  displayName?: string;
  openAtLogin: boolean;
  soundEnabled: boolean;
  sedentaryReminder: boolean;
  pomodoroWorkMin?: number;
  pomodoroBreakMin?: number;
}

export type ReminderRepeat = 'none' | 'daily' | 'weekdays';

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
  repeat: ReminderRepeat;
  source?: 'local' | 'task';
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: 'chat' | 'task' | 'reminder' | 'news';
  cards?: ChatCard[];
  activeTaskName?: string | null;
  accountId?: string;
}

export interface ChatCard {
  kind: 'task' | 'choice' | 'preview' | 'focus' | 'reminder' | 'error' | 'news';
  title: string;
  detail?: string;
  taskId?: string;
  url?: string;
  state?: 'saved' | 'pending' | 'failed';
  actions?: Array<{ id: string; label: string }>;
}

export interface NewsPreferences { enabled: boolean; time: string }
export interface NewsStatus {
  preferences: NewsPreferences; fetchedAt?: string; failures: string[];
  sources: Array<{ name: string; official: boolean }>;
}

export type TaskListView = 'today' | 'pending' | 'week';

export interface TaskListStatus {
  connected: boolean;
  username?: string;
  remembered: boolean;
  canRemember: boolean;
}

export interface LinkedTask {
  id: string;
  name: string;
  priority: 'high' | 'medium' | 'low';
  completed: boolean;
  createdAt: string;
  reminderAt: string | null;
  elapsedSeconds?: number;
  updatedAt?: string;
  sortOrder?: number | null;
  completedAt?: string | null;
}

export type TaskListKind = 'daily' | 'weekly';
export interface TaskListCreateInput {
  id: string;
  kind: TaskListKind;
  name: string;
  priority: LinkedTask['priority'];
  date: string;
  reminderAt?: string | null;
}
export interface TaskListUpdateInput {
  id: string;
  kind: TaskListKind;
  expectedUpdatedAt?: string;
  patch: { name?: string; priority?: LinkedTask['priority']; completed?: boolean; reminderAt?: string | null; date?: string };
}

export interface TaskCompanionPreferences {
  reminders: boolean;
  morning: boolean;
  morningTime: string;
  evening: boolean;
  eveningTime: string;
  quiet: boolean;
  quietStart: string;
  quietEnd: string;
}
export interface TaskFocusStatus {
  phase: 'idle' | 'running' | 'paused';
  taskId?: string;
  name?: string;
  seconds: number;
  remaining: number;
  error?: string;
  free?: boolean;
  roundSeconds?: number;
}

export interface TaskListSnapshot {
  view: TaskListView;
  date: string;
  fetchedAt: string;
  items: LinkedTask[];
}

export interface StateActivity {
  kind: string;
  stateId?: string;
  durationMs?: number;
  feedback?: string;
}

export interface RuntimeReadyReport {
  status: string;
  stateId: string;
  frame: string;
  assetCount: number;
  expectedAssetCount: number;
  naturalWidth: number;
  naturalHeight: number;
  petVisible: boolean;
  ipcReady: boolean;
  renderers?: {
    pet: boolean;
    dashboard: boolean;
    reminder: boolean;
  };
}

export interface RuntimeFailureReport {
  message: string;
}

export interface InteractionResult {
  interaction: InteractionSpec;
  feedback: string;
  stats: PetStats;
}

export interface TypingStatus {
  enabled: boolean;
  reason: string;
}

export interface AppUpdateStatus {
  phase: 'unsupported' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'preparing' | 'ready' | 'installing' | 'error';
  currentVersion: string; latestVersion?: string; notes?: string; message: string; progress?: number; checkedAt?: string;
  autoCheck: boolean; useMirror: boolean;
}
export interface PetAPI {
  updates?: {
    status: () => Promise<AppUpdateStatus>;
    check: () => Promise<AppUpdateStatus>;
    configure: (input: { autoCheck: boolean; useMirror: boolean }) => Promise<AppUpdateStatus>;
    apply: () => Promise<void>;
    cancel: () => Promise<void>;
  };
  news?: {
    status: () => Promise<NewsStatus>;
    configure: (input: NewsPreferences) => Promise<NewsPreferences>;
    open: (url: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<Settings>;
    update: (patch: Partial<Settings>) => Promise<Settings>;
  };
  reminders: {
    list: () => Promise<Reminder[]>;
    feed: () => Promise<{ items: Reminder[]; error?: string }>;
    save: (input: { text: string; dueAt: string; repeat?: ReminderRepeat }) => Promise<Reminder>;
    remove: (id: string, source?: 'local' | 'task') => Promise<boolean>;
    snooze: (id: string, minutes: number) => Promise<Reminder | undefined>;
  };
  interactions: {
    list: () => Promise<InteractionSpec[]>;
    trigger: (id: string) => Promise<InteractionResult>;
    stats: () => Promise<PetStats>;
  };
  chat: {
    send: (text: string) => Promise<string>;
    history: () => Promise<ChatMessage[]>;
    clear: () => Promise<void>;
    turn: (text: string) => Promise<ChatMessage>;
    act: (id: string) => Promise<ChatMessage>;
  };
  ai: {
    status: () => Promise<boolean>;
    configuration: () => Promise<{ baseUrl: string; model: string; city: string; configured: boolean }>;
    configure: (input: { baseUrl: string; model: string; apiKey?: string; city?: string }) => Promise<void>;
    test: () => Promise<void>;
  };
  taskList: {
    status: () => Promise<TaskListStatus>;
    login: (input: { username: string; password: string; remember: boolean }) => Promise<TaskListStatus>;
    logout: () => Promise<TaskListStatus>;
    list: (view: TaskListView) => Promise<TaskListSnapshot>;
    create: (input: TaskListCreateInput) => Promise<LinkedTask>;
    update: (input: TaskListUpdateInput) => Promise<LinkedTask>;
    openWebsite: () => Promise<void>;
    companion: () => Promise<{ preferences: TaskCompanionPreferences; focus: TaskFocusStatus; error?: string }>;
    configure: (input: TaskCompanionPreferences) => Promise<TaskCompanionPreferences>;
    focus: (input: { action: 'start' | 'pause' | 'resume' | 'stop' | 'retry'; id?: string; minutes?: number }) => Promise<TaskFocusStatus>;
    briefing: (kind: 'morning' | 'evening') => Promise<string>;
    plan: (input: { goal: string; date: string }) => Promise<{ ai: boolean; items: TaskListCreateInput[] }>;
    rollover: (date: string) => Promise<TaskListCreateInput[]>;
    select: (input: { id: string; kind: TaskListKind }) => Promise<void>;
  };
  pomodoro: {
    start: () => Promise<{ phase: string; endsAt: number }>;
    stop: () => Promise<void>;
    status: () => Promise<{ phase: string; endsAt: number }>;
  };
  files: {
    getPathForFile: (file: File) => string;
    put: (paths: string[]) => Promise<{ copied: string[]; failed: Array<{ source: string; reason: string }> }>;
    openPocket: () => Promise<void>;
  };
  window: {
    beginDrag: () => Promise<void>;
    updateDrag: () => Promise<void>;
    endDrag: () => Promise<void>;
    beginResize: () => Promise<void>;
    updateResize: () => Promise<void>;
    endResize: () => Promise<void>;
    showContextMenu: () => Promise<void>;
    showReminder: () => Promise<void>;
    showDashboard: () => Promise<void>;
    showQuickChat: () => Promise<void>;
    showFeedback: (text: string) => Promise<void>;
    hideReminder: () => Promise<void>;
    hideDashboard: () => Promise<void>;
    hidePet: () => Promise<void>;
  };
  runtime: {
    ready: (report: RuntimeReadyReport) => Promise<void>;
    fail: (report: RuntimeFailureReport) => Promise<void>;
  };
  events: {
    onUpdate?: (listener: (status: AppUpdateStatus) => void) => () => void;
    onUpdateOpen?: (listener: () => void) => () => void;
    onNews?: (listener: (message: ChatMessage) => void) => () => void;
    onStateActivity: (listener: (activity: StateActivity) => void) => () => void;
    onReminder: (listener: (reminder: Reminder) => void) => () => void;
    onReminderCompose: (listener: () => void) => () => void;
    onRemindersUpdated: (listener: () => void) => () => void;
    onTaskListUpdated: (listener: () => void) => () => void;
    onDashboardMode: (listener: (mode: 'quick' | 'full') => void) => () => void;
    onStats: (listener: (stats: PetStats) => void) => () => void;
    onTypingStatus: (listener: (status: TypingStatus) => void) => () => void;
    onDisplayName: (listener: (name: string) => void) => () => void;
    onPlaySound: (listener: (kind: string) => void) => () => void;
    onPomodoro: (listener: (status: { phase: string; endsAt: number }) => void) => () => void;
  };
}

declare global {
  interface Window {
    petAPI?: PetAPI;
    __petE2E?: {
      snapshot: () => Promise<{
        tray: boolean;
        roles: Array<{ role: 'pet' | 'reminder' | 'dashboard'; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      }>;
      quit: () => Promise<void>;
    };
  }
}

export function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError('Expected string array');
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('Expected string array');
  }
}

export function assertInteractionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 100) {
    throw new TypeError('Invalid interaction id');
  }
}

export function assertSettingsPatch(value: unknown): asserts value is Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid settings patch');
  }
  const obj = value as Record<string, unknown>;
  const booleanKeys = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough', 'openAtLogin', 'soundEnabled', 'sedentaryReminder']);
  const allowedKeys = new Set([...booleanKeys, 'petScale', 'displayName', 'pomodoroWorkMin', 'pomodoroBreakMin']);
  for (const [key, item] of Object.entries(obj)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
    if (booleanKeys.has(key) && typeof item !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
    if (key === 'petScale' && (typeof item !== 'number' || !Number.isFinite(item) || ![0.5, 0.6, 0.8, 1, 1.2, 1.5].includes(item))) {
      throw new TypeError('Invalid settings field: petScale');
    }
    if (key === 'displayName' && item !== undefined && (typeof item !== 'string' || item.length > 50)) {
      throw new TypeError('Invalid settings field: displayName');
    }
    if (key === 'pomodoroWorkMin' && item !== undefined && (typeof item !== 'number' || !Number.isInteger(item) || item < 5 || item > 180)) {
      throw new TypeError('Invalid settings field: pomodoroWorkMin');
    }
    if (key === 'pomodoroBreakMin' && item !== undefined && (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 60)) {
      throw new TypeError('Invalid settings field: pomodoroBreakMin');
    }
  }
}

export function assertReminderInput(value: unknown): asserts value is { text: string; dueAt: string; repeat?: ReminderRepeat } {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid reminder input');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || obj.text.length > 500) {
    throw new TypeError('Invalid reminder text');
  }
  if (typeof obj.dueAt !== 'string' || isNaN(Date.parse(obj.dueAt))) {
    throw new TypeError('Invalid reminder dueAt');
  }
  if (obj.repeat !== undefined && obj.repeat !== 'none' && obj.repeat !== 'daily' && obj.repeat !== 'weekdays') {
    throw new TypeError('Invalid reminder repeat');
  }
}

export function assertRuntimeReadyReport(value: unknown): asserts value is RuntimeReadyReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime ready report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.stateId !== 'string') throw new TypeError('Invalid stateId');
  if (typeof obj.frame !== 'string') throw new TypeError('Invalid frame');
  if (typeof obj.assetCount !== 'number') throw new TypeError('Invalid assetCount');
  if (typeof obj.naturalWidth !== 'number') throw new TypeError('Invalid naturalWidth');
  if (typeof obj.naturalHeight !== 'number') throw new TypeError('Invalid naturalHeight');
}

export function assertRuntimeFailureReport(value: unknown): asserts value is RuntimeFailureReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime failure report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.message !== 'string') throw new TypeError('Invalid message');
}
