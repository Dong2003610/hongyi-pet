# 小红桌宠 (Hongyi Desktop Pet)

基于 **Electron + TypeScript + Vite + Webpack** 开发的 Windows 桌面宠物应用。

## 功能特性

- 🐾 10 种动画状态（待机、行走、睡眠、进食、游玩等），53 帧动画素材
- 📏 6 档窗口大小调节（100px ~ 200px）
- 📝 桌面提醒事项清单（新建 / 删除 / 跨窗口同步，支持每天/工作日重复、贪睡）
- ⏰ 定时任务提醒（全屏弹窗 + 音效，系统唤醒后自动重新调度，睡眠不丢提醒）
- 🍅 番茄钟（专注/休息时长可在面板自定义）
- 🤖 AI 聊天（可选，接入 OpenAI 兼容接口；未配置时自动回退本地规则回复）
  - 📅 实时日期时间注入，回答准确
  - 🌤️ 实时天气（Open-Meteo 免费源，城市可配置）
  - 🏮 农历 / 生肖 / 节日 / 节气（纯本地计算）
  - 📆 节假日调休查询（"明天上班吗"）
  - 🗒️ 今日待办提醒自动感知
  - 💻 电脑状态感知（内存占用 / 电源状态）
  - 🖋️ 每日一句（hitokoto）
- 🔊 内置音效（进食/抚摸/提醒，程序合成的轻量 wav）
- 🏷️ 宠物改名
- 🖥️ Dashboard 控制面板（无边框可拖拽窗口）
- 📁 文件口袋（拖文件到桌宠身上收纳）

## 目录结构

```
hongyi-pet/
├── app/                    # 主项目
│   ├── src/                # 源代码（主进程 / 渲染进程 / 素材 / 音效）
│   ├── tools/              # 素材与音效处理脚本
│   ├── tests/              # 测试
│   └── forge.config.js     # Electron Forge 配置
├── incoming-assets/        # 原始动画素材 (512x512 PNG)
└── pet-spec.json           # 宠物配置规格
```

## 开发

```bash
cd app
npm install
npm start
```

## 打包

```bash
cd app
npm run portable:win
```

推送代码后 GitHub Actions 会自动构建 portable 包（见 `.github/workflows/build.yml`）。

## AI 聊天配置（可选）

1. 复制 `app/ai-config.example.json` 为 `ai-config.json`
2. 填入你的 API 信息后，把文件放到 `%APPDATA%\小红桌宠\`（开发模式为 `%APPDATA%\com-hongyi-desktop-pet\`）
3. 重启桌宠，Dashboard 聊天区会显示「🤖 AI 聊天已启用」

配置示例：

```json
{
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "你的 Key",
  "model": "glm-4-flash",
  "enabled": true,
  "city": "北京"
}
```

> `city` 用于实时天气注入（Open-Meteo 免费源，无需 Key），改成你所在的城市即可，省略时默认「北京」。桌宠聊天时会自动携带当前日期时间和天气，因此日期回答准确、聊天气也有据可依。

兼容 OpenAI `/chat/completions` 协议的服务商均可使用：

| 服务商 | baseUrl | 免费模型示例 |
|---|---|---|
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`（免费） |
| 火山引擎（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | 按用量计费，新用户有免费额度 |
| DeepSeek | `https://api.deepseek.com` | 按用量计费，价格极低 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 部分小模型免费 |

> ⚠️ `ai-config.json` 含 API Key，只放在本机 userData 目录，**不要**提交到 Git 仓库。

---
Powered by Doubao Builder · GitHub: [Dong2003610](https://github.com/Dong2003610)
