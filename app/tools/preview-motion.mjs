import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'qa/20261030-motion');
const source = path.resolve(root, '../incoming-assets/motion-originals-20261030');
const before = JSON.parse(await fs.readFile(path.join(source, 'pet-spec.json'), 'utf8'));
const after = JSON.parse(await fs.readFile(path.join(root, 'pet-spec.json'), 'utf8'));
await fs.mkdir(output, { recursive: true });
const labels = { idle: '待机', blink: '眨眼', happy: '跳跃', notify: '提醒', peek: '探头', pet: '摸头', eat: '吃东西', 'walk-left': '向左走', 'walk-right': '向右走', sleep: '睡觉' };
const data = { before: { states: before.states, images: {} }, after: { states: after.states, images: {} } };
for (const [name, spec, directory] of [['before', before, source], ['after', after, path.join(root, 'src/assets/pet')]]) {
  const tiles = [];
  for (const [row, state] of spec.states.entries()) for (const [column, frame] of state.frames.entries()) {
    const bytes = await fs.readFile(path.join(directory, frame));
    data[name].images[frame] = `data:image/png;base64,${bytes.toString('base64')}`;
    tiles.push({ input: await sharp(bytes).resize(180, 180).png().toBuffer(), left: column * 180, top: row * 210 + 22 });
    tiles.push({ input: Buffer.from(`<svg width="180" height="22"><text x="6" y="16" font-size="13" fill="#263238">${frame}</text></svg>`), left: column * 180, top: row * 210 });
  }
  await sharp({ create: { width: 1080, height: 210 * spec.states.length, channels: 4, background: '#edf0f3' } })
    .composite(tiles).png().toFile(path.join(output, `${name}.png`));
}

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小红动作对照</title><style>
*{box-sizing:border-box}body{margin:0;padding:28px;font:15px/1.6 system-ui;color:#302e33;background:#f7f5f3}main{max-width:900px;margin:auto}h1{font-size:25px;margin:0 0 8px}p{color:#655f66}header{display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin:20px 0}select,button{padding:8px 12px;font:inherit;border:1px solid #d6cbd0;border-radius:9px;background:white}button{cursor:pointer}.panels{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{background:#fff;border:1px solid #e8dfe2;border-radius:15px;padding:16px;overflow:hidden}.stage{height:360px;display:grid;place-items:center;background:repeating-conic-gradient(#f4f1f2 0 25%,#fbf9fa 0 50%) 0/24px 24px}.viewport{position:relative;width:220px;height:220px;overflow:hidden;border:1px dashed #c4b7bd}.viewport:after{content:'';position:absolute;left:0;right:0;top:94.73%;border-top:1px solid #cd818d;pointer-events:none}.layer,.sprite{width:100%;height:100%;position:absolute;inset:0}.sprite{object-fit:contain;transform-origin:50% 95%}.caption{font:12px/1.6 monospace;word-break:break-word;min-height:40px;margin-top:10px}.note{padding:14px 18px;background:#f0e7eb;border-radius:12px}@media(max-width:650px){body{padding:14px}.panels{grid-template-columns:1fr}.stage{height:340px}}
</style><main><h1>小红 · 动作修改对照</h1><p>左侧是修改前的实际素材与播放规则，右侧是修改后。红线表示落点，虚线表示桌宠窗口。</p>
<header><label>动作 <select id="state">${after.states.map(s => `<option value="${s.id}">${labels[s.id]}</option>`).join('')}</select></label><label>窗口大小 <select id="size">${[110,132,176,220,264,330].map(n => `<option ${n===220?'selected':''}>${n}</option>`).join('')}</select></label><label>速度 <select id="speed"><option value="0.5">0.5 倍</option><option value="1" selected>正常</option></select></label><button id="pause">暂停</button><button id="step">下一帧</button></header>
<div class="panels">${['before','after'].map((side,i) => `<section class="panel"><b>${i?'修改后':'修改前'}</b><div class="stage"><div class="viewport" id="${side}"><div class="layer"><img class="sprite" alt="${i?'修改后':'修改前'}人物"></div></div></div><div class="caption" id="${side}-caption"></div></section>`).join('')}</div>
<p class="note">睡觉保留原来的六张动作图，切换间隔从 1.5 秒放慢到 2.5 秒；吃东西去掉踢腿，行走去掉站定帧。原始素材完整保留。侧脸、服装线条和四肢造型的差异仍需以后补画连续帧改善。</p></main>
<script>const data=${JSON.stringify(data).replaceAll('<','\\u003c')};const $=id=>document.getElementById(id);const loaded={};let elapsed=0,last=0,paused=false;
for(const side of ['before','after']){loaded[side]={};for(const [name,url] of Object.entries(data[side].images)){const img=new Image;img.src=url;loaded[side][name]=img;}}
function draw(){const id=$('state').value,size=Number($('size').value);for(const side of ['before','after']){const state=data[side].states.find(s=>s.id===id),i=Math.floor(elapsed/state.frameDurationMs)%state.frames.length,frame=state.frames[i],box=$(side),sprite=box.querySelector('img'),layer=box.firstElementChild;box.style.width=box.style.height=size+'px';sprite.src=loaded[side][frame].src;const lift=id==='happy'?(frame==='happy-02.png'?16:frame==='happy-03.png'?18:0):0;layer.style.transform='translateY(-'+lift+'%)';const scale=side==='before'&&frame==='happy-05.png'?.73:1;sprite.style.scale=scale;const breath=side==='before'?id!=='happy':id==='idle'||id==='sleep'||state.proceduralMotion==='breathing';const wave=(1-Math.cos(elapsed/3200*Math.PI*2))/2;sprite.style.transform=breath?'scale('+(1+wave*.012)+','+(1+wave*.022)+')':'none';$(side+'-caption').textContent=frame+' · '+state.frames.length+' 帧 · '+state.frameDurationMs+'ms'+(state.proceduralMotion?' · 呼吸':'');}}
function loop(now){if(last&&!paused)elapsed+=(now-last)*Number($('speed').value);last=now;draw();requestAnimationFrame(loop)}$('state').onchange=()=>{elapsed=0;draw()};$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'继续':'暂停'};$('step').onclick=()=>{paused=true;$('pause').textContent='继续';const s=data.after.states.find(s=>s.id===$('state').value);elapsed=(Math.floor(elapsed/s.frameDurationMs)+1)*s.frameDurationMs;draw()};window.motionPreview={set:(id,time)=>{$('state').value=id;elapsed=time;paused=true;draw()}};draw();requestAnimationFrame(loop);
</script></html>`;
await fs.writeFile(path.join(output, 'preview.html'), html);

// GIFs are compact visual evidence; HTML remains the interactive, normal-size
// review surface. Each GIF includes both original and repaired animation.
for (const id of ['walk-left', 'walk-right', 'happy', 'eat', 'sleep']) {
  const duration = id === 'sleep' ? 15000 : 2100;
  const delay = id === 'sleep' ? 200 : 70;
  const pages = [];
  for (let time = 0; time < duration; time += delay) {
    const overlays = [];
    for (const [column, side] of ['before', 'after'].entries()) {
      const state = data[side].states.find(s => s.id === id);
      const frame = state.frames[Math.floor(time / state.frameDurationMs) % state.frames.length];
      const bytes = Buffer.from(data[side].images[frame].split(',')[1], 'base64');
      const scale = side === 'before' && frame === 'happy-05.png' ? .73 : 1;
      const breath = id === 'sleep' ? (1 - Math.cos(time / 3200 * Math.PI * 2)) / 2 : 0;
      const width = Math.round(220 * scale * (1 + breath * .012));
      const height = Math.round(220 * scale * (1 + breath * .022));
      const lift = id === 'happy' ? frame === 'happy-02.png' ? 16 : frame === 'happy-03.png' ? 18 : 0 : 0;
      const artwork = await sharp(bytes).resize(width, height).png().toBuffer();
      // Canvas includes generous outer padding, just as the desktop viewport
      // has transparent margins above the registered character.
      overlays.push({ input: artwork, left: column * 240 + Math.round(10 + (220 - width) / 2), top: Math.round(24 + (220 - height) * .95 - lift * 2.2) });
    }
    const background = Buffer.from(`<svg width="480" height="254"><rect width="480" height="254" fill="#f4f0f2"/><path d="M0 233H480" stroke="#c58a96"/><text x="12" y="18" font-size="13">BEFORE</text><text x="252" y="18" font-size="13">AFTER</text></svg>`);
    pages.push(await sharp(background).ensureAlpha().composite(overlays).raw().toBuffer());
  }
  await sharp(Buffer.concat(pages), { raw: { width: 480, height: 254 * pages.length, channels: 4, pageHeight: 254 } })
    .gif({ delay, loop: 0, effort: 3, dither: 0 }).toFile(path.join(output, `${id}.gif`));
}
console.log(`Motion previews: ${output}`);
