# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
