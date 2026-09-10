# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- **多会话交替工作时列表抖动**：会话行的位置不再随每次轮询的活跃度换位（宿主返回顺序抖动、`running` 在 1.5s 无输出窗口反复翻转、`lastEventMs` 互相领先都不再影响行序），改为按"首次出现"锚定行序，只在会话首次出现和整轮开始/结束时变化。
- **"当前显示"的会话来回跳**：没手动点选时不再每次都取列表第一条，而是咬住上一次显示的会话；只有它消失（被关闭 / 下线）才回落到下一个可用会话。
- 本步耗时 `stepMs` 在一步结束后定格：原先空闲的会话会让它一直涨（tooltip 显示"本步 600s"），现在结束即冻结。
- 浮窗渲染对数字字段兜底（`toNum`）：宿主字段缺失或非数字时按 0 处理，不再让单帧异常打断渲染。

### Security
- HTTP 端点加本机 Host 校验：非 `127.0.0.1` / `localhost` / `[::1]` 一律 403，挡住 DNS rebinding 类跨站读取（会话标题与工作目录属于可读信息）。
- 只读端点限制方法：非 `GET` / `HEAD` 回 405（带 `Allow` 头）。
- 端点写响应包 try/catch：客户端提前断开（刷新页面）不再向宿主抛异常。

### Changed
- 测试 20 → 29 项（tracker 15 + host 8 + widget 6，其中 widget 是新增的客户端渲染测试：DOM 桩 + `vm` 跑 `lib/widget.js`；含一条端到端用例 —— 用真实 tracker 造"两会话交替输出"的流量，先断言宿主返回顺序确实在抖，再断言浮窗行序与当前会话纹丝不动）。

## [0.1.0] - 2026-09-10

首个可用版本。

### Added
- 宿主插件订阅会话事件 firehose（`session/event`），滑动窗口计算实时输出吞吐（tok/s），并用提供方 `usage.outputTokens` 做估算校正（EMA）。
- 浮窗（注入脚本，零客户端依赖）：
  - `实时 / 均速` 双口径手动切换，数字配色随口径（实时绿 / 均速蓝）。
  - 会话列表：纵向堆叠真实会话标题，当前项绿字、其余白字，点名字即切换，超长省略号截断，最多 3 行 + `…还有 N 个`。
  - 行内状态标：整轮进行中显示绿色转圈（思考 / 跑工具期间也算），结束显示 `–`。
  - 双击关闭已完成会话的显示（记 localStorage），底部提供 `…N 个已关闭（点此恢复）`。
  - 本步 token、会话累计 token、TTFT；实时口径附带 40 拍速度波形。
  - 状态行区分 `生成中` / `工具执行中…` / `思考中…`。
  - 位置、折叠状态、口径、选中会话均记忆；支持拖动与折叠。
  - 自更新探测：每 60s 比对脚本版本，有新版本时亮出 `⟳` 按钮。
- 安装脚本 `install.ps1`（link 到 DSH web profile + 写入 `cordis.patch.yml`）。
- 测试：tracker 单测 + 宿主冒烟共 20 项；`test/preview.mjs` 本地样式预览。

[Unreleased]: https://github.com/looking321-rt/dsh-tps-meter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/looking321-rt/dsh-tps-meter/releases/tag/v0.1.0
