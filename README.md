<div align="center">

# 🐾 TimePaws

**《把时间和注意力，还给你自己》**

[![Stars](https://img.shields.io/github/stars/ksk2023/TimePaws_new?style=flat&logo=github&label=Stars&color=0969da)](https://github.com/ksk2023/TimePaws_new/stargazers)
[![Forks](https://img.shields.io/github/forks/ksk2023/TimePaws_new?style=flat&logo=github&label=Forks&color=57606a)](https://github.com/ksk2023/TimePaws_new/network)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078d6?style=flat&logo=windows&logoColor=white)](https://github.com/ksk2023/TimePaws_new)
[![Electron](https://img.shields.io/badge/Electron-38-9feaf9?style=flat&logo=electron&logoColor=black)](https://www.electronjs.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-f7c948?style=flat&logo=tauri&logoColor=black)](https://tauri.app/)
[![Privacy](https://img.shields.io/badge/Privacy-Local--First-22c55e?style=flat&logo=privacytools&logoColor=white)](#隐私承诺)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)

**本地优先的 Windows 桌面陪伴层，面向 ADHD / 注意力容易漂移的用户。**

只做两件事：**看见自己**（主屏使用追踪）+ **回到计划**（当前任务常驻提醒）。语气是同伴，不评判。

**目录：** [它是什么](#-它是什么--不是什么) · [双栈架构](#-双栈架构) · [核心概念](#-核心概念) · [提醒规则](#-提醒规则) · [快速开始](#-快速开始) · [项目结构](#-项目结构) · [里程碑](#-里程碑) · [隐私承诺](#-隐私承诺)

</div>

---

## 🎯 它是什么 / 不是什么

| 是 | 不是 |
| --- | --- |
| 主显示器前台/可见时长记录 | 监控或考核工具 |
| 常驻小组件 + 温和浮层提醒 | 待办软件全家桶 |
| 全部数据本地 SQLite | 云同步 / 账号 / 遥测 |
| 规则触发的轻提醒 | 应用封锁、摄像头、大模型聊天 |

> 设计前提：不制造焦虑、不做评判。所有数字只给你自己看，提醒也只是轻轻拉一把。

---

## 🏗 双栈架构

同一个产品，两套桌面运行时并行演进：

| 栈 | 目录 | 定位 | 状态 |
| --- | --- | --- | --- |
| **Electron** | `apps/desktop` | 主力实现，Win32 能力完整（追踪 / 托盘 / 浮层 / SQLite） | ✅ 可用 |
| **Tauri 2 (Rust)** | `apps/desktop-rs` | 体积与内存更优的下一代载体，前端复用 | 🚧 早期 |

- Electron 版：Electron 38 + React 19 + TypeScript（严格模式）
- 状态：Zustand；UI：Tailwind CSS（深色低刺激、大字号、圆角）
- 本地库：better-sqlite3（主进程独占连接，WAL）
- Win32：koffi 2.16（user32 / kernel32）
- 包管理：pnpm 10（workspace）
- Tauri 侧构建入口：`build-tauri.bat`

---

## 🧠 核心概念

- **会话（session）**：一段连续的前台停留。应用/标题切换、失去前台、暂停时结束并落库。
- **计入口径**：主屏 + 非最小化 + 非空闲。副屏/后台照常记录但不计入时长。
- **空闲记账**：空闲时长从会话中扣除（`idleAccruedMs`），恢复输入即续。
- **当前任务（doing）**：全局至多一个；专注时长（`focus_ms`）每分钟从计入会话中归集。

---

## 🔔 提醒规则

| 规则 | 触发 | 提醒 |
| --- | --- | --- |
| `heartbeat` | 当前任务连续专注 ≥ 50 分钟（可调 20–120） | 起来走走 |
| `drift` | 有当前任务但 5 分钟内主屏计入 < 30s | 「任务」还在等你 |
| `switch_storm` | 5 分钟内前台切换 ≥ 15 次 | 回到一件事上 |
| `idle_back` | 离开 ≥ 10 分钟后回来 | 欢迎回来 |

**通用保护**：每规则 10 分钟冷却；「稍后提醒」静默 20 分钟；浮层可见时不叠加；提醒可整体暂停。

---

## 🚀 快速开始

要求：Windows 10/11、Node ≥ 20、pnpm ≥ 9。

```powershell
pnpm install
```

### 开发

```powershell
# 终端 1：编译主进程 + 启动 Vite（渲染热更新）
pnpm dev

# 终端 2：启动 Electron（开发期手动启动，便于看主进程日志）
cd apps/desktop
pnpm exec electron .
```

加载策略：主窗口/小组件/浮层先探测 Vite dev server（`127.0.0.1:5183`），连不上自动回退 `dist/index.html`（`file://` + hash 路由）。所以只 build 不起 Vite 也能跑完整应用。

主进程日志：追踪每秒一行 `时间 | app | title | 主屏=Y/N | idle?`，落库错误会标 `[db]`。

### 构建

```powershell
pnpm build   # 产出 release/ 下的 Windows NSIS 安装包（x64）
```

<details>
<summary><b>原生依赖说明（国内环境实测要点）</b></summary>

- registry 建议用镜像：`--registry=https://registry.npmmirror.com`
- pnpm 10 会忽略原生依赖的构建脚本，需要手动补：
  - **Electron 二进制**：
    ```powershell
    cd node_modules/.pnpm/electron@*/node_modules/electron
    $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
    node install.js
    ```
  - **better-sqlite3 双 ABI**：
    ```powershell
    npx prebuild-install -r electron -t 38.8.6          # 运行时
    npx prebuild-install -r node -t <node版本>           # 开发期脚本
    ```
  - **koffi** 自带 win32-x64 预编译，无需额外处理

</details>

---

## 📁 项目结构

```text
TimePaws/
├── apps/
│   ├── desktop/                 # Electron 主力实现
│   │   ├── electron/            # 主进程（Win32、DB、定时器全在这里）
│   │   │   ├── main.ts          # 入口：窗口/托盘/小组件装配、单实例锁、崩溃恢复
│   │   │   ├── tracker.ts       # 窗口追踪（SetWinEventHook + 1Hz 轮询兜底、会话推导、空闲记账）
│   │   │   ├── idle.ts          # 空闲检测（GetLastInputInfo）
│   │   │   ├── display.ts       # 主屏判断（MonitorFromWindow 语义）+ 显示器热插拔监听
│   │   │   ├── overlay.ts       # 提醒浮层（无焦点、右下角、25s 自动隐藏）
│   │   │   ├── reminders.ts     # 提醒规则引擎（heartbeat / drift / switch_storm / idle_back）
│   │   │   ├── task-focus.ts    # 当前任务专注时长积累器
│   │   │   ├── tray.ts          # 托盘（暂停提醒 / 全局贪睡 / 退出）
│   │   │   ├── widget.ts        # 常驻小组件窗口（拖动/吸附/折叠/位置持久化）
│   │   │   ├── settings.ts      # 设置持久化 + 数据导出/清理 + 开机自启
│   │   │   └── db.ts            # SQLite（sessions / daily_app_stats / daily_title_stats / events_switch / tasks）
│   │   └── src/                 # 渲染进程（只展示）
│   │       ├── ui/              # App / Widget / Overlay / TodayPage / StatsPage / TasksPage / SettingsPage
│   │       ├── store/           # Zustand
│   │       ├── lib/             # api 类型、工具
│   │       └── resources/       # 图标（icon.ico / tray*.png，make_icons.py 生成）
│   └── desktop-rs/              # Tauri 2 (Rust) 下一代载体
│       ├── src/                 # 前端（复用 React + Tailwind）
│       └── src-tauri/           # Rust 侧
└── build-tauri.bat              # Tauri 构建入口
```

---

## 🏁 里程碑

| 里程碑 | 内容 | 手工验证 |
| --- | --- | --- |
| **M0** ✅ | 脚手架 + 主窗口 + 托盘 + 可拖动小组件 | 拖动贴边吸附；重启位置不变；折叠/展开；关主窗口后托盘/小组件仍在 |
| **M1** ✅ | Win32 追踪 + 空闲检测 | 切应用看日志实时变化；副屏标记 `主屏=N`；60s 不动标记 idle |
| **M2** ✅ | SQLite + 今日/统计页 | 今日页看到总时长、应用分布、最近活动；统计页 14 天趋势 |
| **M3** ✅ | 任务 + 当前任务 + 小组件 | 回车建任务→设为当前→小组件立即显示并累计专注 |
| **M4** ✅ | 提醒引擎 + 浮层 | 设置页「预览」看浮层；间隔可调；稍后提醒静默 20 分钟 |
| **M5** ✅ | 设置 + 隐私 + 导出 | 暂停追踪后统计停走；导出 JSON 可打开；清空有二次确认 |
| **M6** ✅ | 打磨 + 崩溃恢复 + 打包 | 单实例锁；GPU/渲染崩溃自动恢复；`pnpm build` 出安装包 |

---

## ⚙️ Windows 注意事项

- **DPI 缩放**：125%/150% 下小组件坐标均按 Electron 逻辑像素处理；主屏变更自动拉回可视区。
- **托盘**：关闭主窗口不会退出（缩到托盘）；退出走托盘右键菜单。
- **单实例**：二次启动自动唤起已有窗口，不会出现双实例抢 SQLite WAL。
- **崩溃恢复**：GPU 进程崩溃自动重启应用；渲染进程崩溃 1s 后自动重载（数据在主进程，不丢）。
- **SmartScreen**：首次运行未签名包会提示，选「仍要运行」。
- **数据**：仅存 `%APPDATA%\@anchor\desktop\`（`anchor.db` WAL + `settings.json` + `widget-pos.json` + `exports/`）。设置页可导出 JSON、清空追踪数据。
  > 说明：数据目录名沿用早期工程代号 `@anchor`，后续版本会统一到 `TimePaws`。

---

## 🔒 隐私承诺

- **无网络上报、无账号、无遥测**；所有数据仅本地。
- 可暂停追踪、暂停提醒；可随时导出/清空全部数据。
- 卸载即删应用，数据目录 `%APPDATA%\@anchor\` 保留，可手动删除。

---

<div align="center">

🐾 **TimePaws** · 本地优先 · 不评判 · 只陪你走

</div>
