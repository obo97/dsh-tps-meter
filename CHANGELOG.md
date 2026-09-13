# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- **删除插件后 DSH 起不来（严重）**：卸载不干净会留下悬空登记，DSH 加载插件树时解析不到包，就在监听端口前退出（桌面端表现「子进程在就绪前退出」，整个界面都连不上）。两处根因：① 旧 `install.ps1` 只删 `cordis.patch.yml` 的行，**从不碰 `dsh.profile.bundles`** —— 而本插件声明了 `dsh.bundle`，DSH 会在每次 `dsh plugin ...` 后自动把它写进那份列表，于是 `pnpm remove` 删了包、列表里却留着名字；② 删 patch 行时按「缩进 ≥4 空格」一路吃到底，会把**后面所有插件的 insert 行一起删掉**（旧逻辑重放实测：4 行插件只剩第 1 行）。
- 安装与卸载改为**单一登记**：只写 `dsh.profile.bundles`（DSH 自己管理的那一层），安装时顺手清掉历史遗留的 patch 行，卸载时三处（bundles / patch / dependencies）一起清且幂等；配置文件按行编辑，保留原有缩进、键序、换行风格（package.json 的 LF + 末尾换行、cordis.patch.yml 的 CRLF + 无末尾换行）与无 BOM 编码，改完还要过一遍 JSON 合法性校验。
- 卸载支持**救援**：先清登记再动 pnpm，pnpm 不可用或失败也照样把登记清干净，最后打印 self-check —— DSH 已经起不来时跑这一条命令即可恢复。
- 跨工作区跑多任务时标题上下跳：新会话不再"插队"到所在组最前（那会把已有行整体顶下去，把常驻会话挤出只有 3 行的可见区），改为**一律追加队尾**；会话短暂消失（整轮结束且零输出的会被宿主过滤掉）后再回来仍回原位 —— 锚定序号保留 10 分钟，不再被当成新会话插队。

### Added
- `test/install.test.mjs`（27 项，`node test/install.test.mjs`）：在临时 profile 上真跑安装/卸载脚本，覆盖单一登记、其它插件行不受牵连、幂等、末项逗号、紧凑 JSON 拒绝改写、换行/BOM 不变形，以及真机 profile 的悬空 bundle 项体检。

### Changed
- 安装/卸载**需要重启一次 DSH** 才生效（登记落在 bundle 层，该层在启动时加载）；旧版走 `cordis.patch.yml` 能热挂载，但与 DSH 的自动核对天然冲突，是上面那个「删不干净」的源头。

## [0.1.2] - 2026-09-10

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

[Unreleased]: https://github.com/looking321-rt/dsh-tps-meter/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/looking321-rt/dsh-tps-meter/compare/v0.1.1...v0.1.2
[0.1.0]: https://github.com/looking321-rt/dsh-tps-meter/releases/tag/v0.1.0
