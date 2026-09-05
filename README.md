# 小红桌宠 (Hongyi Desktop Pet)

基于 **Electron + TypeScript + Vite + Webpack** 开发的 Windows 桌面宠物应用。

## 功能特性

- 🐾 10 种动画状态（待机、行走、睡眠、进食、游玩等），53 帧动画素材
- 📏 6 档窗口大小调节（100px ~ 200px）
- 📝 桌面提醒事项清单（新建 / 删除 / 跨窗口同步）
- ⏰ 定时任务提醒（全屏弹窗 + 提示音）
- 🏷️ 宠物改名
- 🖥️ Dashboard 控制面板（无边框可拖拽窗口）

## 目录结构

```
hongyi-pet/
├── app/                    # 主项目
│   ├── src/                # 源代码（主进程 / 渲染进程 / 素材）
│   ├── tools/              # 素材处理脚本
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

---
Powered by Doubao Builder · GitHub: [Dong2003610](https://github.com/Dong2003610)
