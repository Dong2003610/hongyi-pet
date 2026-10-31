import type { AppUpdateStatus } from '../../shared/contracts';

export function setupUpdates(openSettings: () => void): void {
  const api = window.petAPI?.updates; if (!api) return;
  const section = document.createElement('section'); section.className = 'settings-group update-settings'; section.id = 'app-updates';
  section.innerHTML = `<div class="section-title">桌宠更新</div><p id="update-version"></p><p id="update-message" role="status"></p><progress id="update-progress" max="100" hidden></progress><pre id="update-notes" hidden></pre><div class="task-tool-buttons"><button type="button" id="update-check">检查更新</button><button type="button" id="update-apply" hidden>下载并重启</button><button type="button" id="update-cancel" hidden>取消下载</button></div><form id="update-preferences"><label><input type="checkbox" id="update-auto">自动检查新版本</label><label><input type="checkbox" id="update-mirror">优先通过下载镜像获取（ghfast.top）</label><button type="submit">保存更新设置</button></form><p class="task-hint">自动检查只提示，不会自行安装。点击下载并重启后会替换程序；配置、聊天和账号数据保留。更新前请保存其他正在进行的操作。</p>`;
  document.getElementById('panel-settings')!.querySelector('.back-button')!.after(section);
  const badge = document.createElement('button'); badge.type = 'button'; badge.id = 'update-badge'; badge.hidden = true; badge.className = 'update-badge';
  document.getElementById('tab-bar')!.after(badge);
  const field = <T extends HTMLElement>(id: string) => section.querySelector<T>(`#${id}`)!;
  const message = field('update-message'), version = field('update-version'), notes = field('update-notes');
  const check = field<HTMLButtonElement>('update-check'), apply = field<HTMLButtonElement>('update-apply'), cancel = field<HTMLButtonElement>('update-cancel');
  const auto = field<HTMLInputElement>('update-auto'), mirror = field<HTMLInputElement>('update-mirror'), progress = field<HTMLProgressElement>('update-progress');
  const preferences = field<HTMLFormElement>('update-preferences'); let dirty = false, busy = false, saving = false, epoch = 0, latest: AppUpdateStatus | undefined;
  function render(value: AppUpdateStatus) {
    latest = value;
    version.textContent = `当前版本 ${value.currentVersion}${value.latestVersion ? ` · 新版本 ${value.latestVersion}` : ''}`;
    message.textContent = value.message;
    notes.textContent = value.notes ?? ''; notes.hidden = !value.notes;
    if (!dirty) { auto.checked = value.autoCheck; mirror.checked = value.useMirror; }
    const running = ['downloading', 'preparing', 'installing'].includes(value.phase);
    check.disabled = busy || running || value.phase === 'checking' || value.phase === 'unsupported';
    apply.hidden = !value.latestVersion || ['current', 'unsupported'].includes(value.phase);
    apply.disabled = busy || running || value.phase === 'checking'; apply.textContent = value.phase === 'ready' ? '重试更新并重启' : '下载并重启';
    cancel.hidden = value.phase !== 'downloading';
    progress.hidden = !['downloading', 'preparing'].includes(value.phase); progress.value = value.progress ?? 0;
    badge.hidden = !value.latestVersion; badge.textContent = running ? value.message : `发现新版本 ${value.latestVersion} · 打开更新`;
  }
  const refresh = async () => { const request = ++epoch; try { const value = await api!.status(); if (request === epoch) render(value); } catch { message.textContent = '更新状态读取失败，请稍后重试'; } };
  const show = () => { openSettings(); section.scrollIntoView({ block: 'start' }); void refresh(); };
  badge.addEventListener('click', show); window.petAPI?.events.onUpdateOpen?.(show);
  window.petAPI?.events.onUpdate?.(value => { epoch++; render(value); });
  check.addEventListener('click', async () => { if (busy) return; busy = true; if (latest) render(latest);
    try { render(await api.check()); } catch { message.textContent = '检查更新失败，可稍后重试'; }
    finally { busy = false; if (latest) render(latest); }
  });
  apply.addEventListener('click', async () => { if (busy) return; busy = true; if (latest) render(latest);
    try { await api.apply(); } catch (error) { if (latest?.phase !== 'installing') { await refresh(); message.textContent = latest?.message ?? '更新未完成，当前版本继续运行'; } }
    finally { busy = false; if (latest) render(latest); }
  });
  cancel.addEventListener('click', () => void api.cancel().catch(() => { message.textContent = '取消未完成，请稍候'; }));
  preferences.addEventListener('input', () => { dirty = true; });
  preferences.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return; saving = true;
    const button = preferences.querySelector('button')!; button.disabled = true;
    const input = { autoCheck: auto.checked, useMirror: mirror.checked };
    try { const value = await api.configure(input); if (input.autoCheck === auto.checked && input.useMirror === mirror.checked) dirty = false; render(value); message.textContent = '更新设置已保存'; }
    catch { message.textContent = '更新设置保存失败，输入已保留'; }
    finally { saving = false; button.disabled = false; }
  });
  document.querySelectorAll('[data-open-nav="settings"]').forEach(node => node.addEventListener('click', () => void refresh()));
  void refresh();
}
