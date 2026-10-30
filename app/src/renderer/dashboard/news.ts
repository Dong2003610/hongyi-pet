import type { NewsStatus } from '../../shared/contracts';

export function setupNews(): void {
  const form = document.getElementById('news-settings') as HTMLFormElement | null;
  if (!form || !window.petAPI?.news) return;
  const enabled = document.getElementById('news-enabled') as HTMLInputElement;
  const time = document.getElementById('news-time') as HTMLInputElement;
  const status = document.getElementById('news-status')!;
  const button = form.querySelector('button')!;
  let dirty = false;
  function render(value: NewsStatus) {
    if (!dirty) { enabled.checked = value.preferences.enabled; time.value = value.preferences.time; }
    status.textContent = `${value.fetchedAt ? `上次获取：${new Date(value.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）` : '尚未获取新闻。'}\n${value.sources.map(s => s.name).join('、')}${value.failures.length ? `\n暂不可用：${value.failures.join('、')}` : ''}`;
  }
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (button.disabled) return;
    const version = JSON.stringify({ enabled: enabled.checked, time: time.value });
    button.disabled = true;
    try {
      await window.petAPI!.news!.configure(JSON.parse(version));
      if (version === JSON.stringify({ enabled: enabled.checked, time: time.value })) dirty = false;
      status.textContent = '新闻设置已保存。';
    } catch { status.textContent = '保存失败，输入已保留，请重试。'; }
    finally { button.disabled = false; }
  });
  const refresh = () => void window.petAPI!.news!.status().then(render).catch(() => { status.textContent = '新闻设置暂时无法读取，请重新打开设置。'; });
  document.querySelectorAll('[data-open-nav="settings"]').forEach(node => node.addEventListener('click', refresh));
  refresh();
}
