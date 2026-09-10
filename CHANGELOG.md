# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- 本步耗时 `stepMs` 在一步结束后定格：原先空闲的会话会让它一直涨（tooltip 显示"本步 600s"），现在结束即冻结。
- 浮窗渲染对数字字段兜底（`toNum`）：宿主字段缺失或非数字时按 0 处理，不再让单帧异常打断渲染。

### Security
- HTTP 端点加本机 Host 校验：非 `127.0.0.1` / `localhost` / `[::1]` 一律 403，挡住 DNS rebinding 类跨站读取（会话标题与工作目录属于可读信息）。
- 只读端点限制方法：非 `GET` / `HEAD` 回 405（带 `Allow` 头）。
- 端点写响应包 try/catch：客户端提前断开（刷新页面）不再向宿主抛异常。

### Changed
- 测试 20 → 23 项（tracker 15 + host 8）。

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
