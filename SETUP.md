# 环境搭建与打包流程（新电脑必读）

本仓库带有"受保护文件哈希校验"机制（`.doubao-pet-builder.json`），并且**禁止 git 做换行符转换**，请严格按照以下步骤操作，否则打包会被 preflight 校验拒绝。

## 前置要求

- [Node.js LTS](https://nodejs.org)（v22 或 v24，自带 npm 11+）
- Git

## 一、克隆项目

```cmd
git clone https://github.com/Dong2003610/hongyi-pet.git
cd hongyi-pet\app
```

> 换行符问题已通过仓库根目录的 `.gitattributes` 固化，任何机器克隆都不需要手动关 autocrlf。

## 二、安装依赖（用 npm ci，不要用 npm install）

```cmd
npm ci
```

要点：

- `npm ci` 严格按 `package-lock.json` 安装，**绝不修改锁文件**；`npm install` 会更新锁文件并触发哈希校验失败
- `npm ci` 每次都会删除 `node_modules` 重装，第一次较慢属正常
- Electron 二进制（约 100MB）默认从 GitHub 下载，国内网络慢属正常

### Electron 下载慢/卡住的解决办法

中断（Ctrl+C）后，换国内镜像重新执行（cmd 语法）：

```cmd
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm ci
```

PowerShell 语法：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm ci
```

### 验证 Electron 二进制完整

```cmd
if exist node_modules\electron\dist\electron.exe (echo OK) else npm rebuild electron
```

PowerShell：

```powershell
Test-Path node_modules\electron\dist\electron.exe   # 应输出 True
# 若为 False：npm rebuild electron
```

## 三、日常运行与打包

```cmd
npm run dev            && rem 开发模式运行
npm run portable:win   && rem 打包 Windows portable 版 → app\release
```

其他打包模式：

| 命令 | 产物 |
|------|------|
| `npm run package:win` | Windows 目录包 |
| `npm run portable:win` | Windows 免安装版 |
| `npm run make:win` | Windows 安装程序 |
| `npm run package:mac` / `portable:mac` / `make:mac` | macOS 版（需在 macOS 上执行） |

打包产物输出在 `app\release`，构建临时文件在 `%LOCALAPPDATA%\DoubaoPetBuilder`。

## 四、常见报错速查

| 报错 | 原因 | 解决 |
|------|------|------|
| `ENOENT ... node_modules\electron\package.json` | 没装依赖 | 执行 `npm ci` |
| `protected template infrastructure changed: package-lock.json` | 锁文件被 npm install 改动 | `git restore package-lock.json` 后再打包 |
| `protected template infrastructure changed: tools/xxx.mjs` | 换行符被改（多为旧克隆残留） | 删掉目录重新克隆（`.gitattributes` 已修复此问题） |
| `npm ci can only install packages when ... in sync` | 锁文件与 package.json 不同步 | 更新代码到最新版（锁文件已重新生成）；或删除 `package-lock.json` 后 `npm install` 重新生成 |
| `npm.ps1 cannot be loaded` | PowerShell 执行策略拦截 | 用 cmd 执行，或调用 `npm.cmd` |
| Electron 下载卡住 | 国内访问 GitHub 慢 | 设置 `ELECTRON_MIRROR` 后重跑 |
