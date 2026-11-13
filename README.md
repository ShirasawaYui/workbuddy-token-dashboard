# WorkBuddy Token 用量看板

**解析 WorkBuddy 本地会话日志，把 token 消耗、缓存命中、credit 结算与响应速度还原成一张看得懂的看板**

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js\&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![server: zero dependency](https://img.shields.io/badge/server-%E9%9B%B6%E4%B8%89%E6%96%B9%E4%BE%9D%E8%B5%96-orange)
![Vue 3](https://img.shields.io/badge/UI-Vue%203%20%2B%20ECharts-42b883?logo=vuedotjs\&logoColor=white)
![themes: light / dark](https://img.shields.io/badge/themes-%E6%9A%96%E7%A0%82%E4%BA%AE%E8%89%B2%20%2F%20%E6%B7%B1%E7%84%99%E6%9A%97%E8%89%B2-6d28d9)

![暖砂亮色 · 总览](docs/screenshots/01-overview-light.png)

</div>

---

仓库：[ShirasawaYui/workbuddy-token-dashboard](https://github.com/ShirasawaYui/workbuddy-token-dashboard)。
这是基于 [selennac/workbuddy-token-dashboard](https://github.com/selennac/workbuddy-token-dashboard) 的 **MIT 二次开发版本**，保留了基底的数据口径与推导算法，重写了前端视觉与布局，并补上冷启动按需加载、明细排序等能力；原作者的版权与许可声明完整保留，详见[来源与二次开发](#来源与二次开发)。

WorkBuddy 本身不提供任何 token 用量视图。这个项目直接读取它在本地落盘的会话 JSONL（`~/.workbuddy/projects/**/*.jsonl`），起一个**零三方依赖**的解析服务和一个 Vue 3 看板，回答四个平时根本没法回答的问题：

- **钱花在哪了** —— credit 按项目 / 模型 / 会话 / 工具摊开，贵的那几个一目了然
- **缓存命中率什么时候掉的** —— 趋势图按「命中输入 / 未命中输入 / 输出」堆叠，费用上涨究竟是量涨了还是命中率掉了，一眼分清
- **模型到底快不快** —— 本地**没有任何耗时字段**，吐字速度和每请求固定开销是从事件时间线里推出来的（见[耗时是怎么算出来的](#耗时是怎么算出来的)）
- **时间花在哪了** —— 模型生成 / 工具执行 / 人的环节 / 离开电脑，四段互不重叠

技术栈：**Node.js（服务端仅用 `node:` 内置模块）+ Vue 3 + Vite + ECharts**。

**为什么可以放心用**（也是这一版最在意的边界）：

- **纯本地只读** —— 只读 `~/.workbuddy/projects/**/*.jsonl`，不写入、不修改 WorkBuddy 本体或它的配置；所有请求走同源 `/api`，源码里没有任何外部统计 / 上报请求。
- **无 Agent 介入** —— 关掉对话后照常使用，不依赖 Agent 运行时，也不需要会话临时注入的 PATH（配 `start-dashboard.bat` 双击启动）。
- **数据即时刷新** —— 服务端每 5 秒增量重扫、前端静默重取，稳定态一拍只花一个 `/api/meta`；页面切到后台暂停、切回立刻补拍，失败会重试而不会把旧数字冒充实时。
- **性能友好** —— 启动只解析近 7 天文件，切到更宽档位才按需补齐；零三方依赖后端，10 万条 / 500 会话规模稳定态约 6ms。
- **界面美观现代** —— 暖砂亮色 / 深焙暗色双主题、全宽自适应工作台、自绘控件与可缩放图表。

> 下文截图与示例数字均来自 `scripts/demo.js` 生成的合成数据（3 个虚构项目、2 个模型），不含任何真实使用记录。时间线按真实规律构造，所以耗时推导与速度拟合在演示数据上同样成立。少数标注「真实数据实测」的数字来自作者本机规模统计，只用于说明量级，不含项目名、路径与会话内容。

## 这一版做了什么

基底已经能算准账，这一版主要解决「好不好看、快不快、顺不顺手」：

| 方向 | 内容 |
| --- | --- |
| **双主题** | 暖砂羊皮纸亮色 / 深焙黑曜石暗色，侧栏顶部 ☀️/🌙 一键切换，偏好写入 `localStorage`；设计系统集中在 `web/src/style.css` 的 CSS 变量 |
| **全宽工作台** | 去掉 1440px 限宽，改为 `252px` 左侧固定导航栏 + 右侧 `minmax(0, 1fr)` 自适应工作台；品牌、主题、三个视图页签、最近活跃盯盘卡与服务状态统一收进侧栏，窄屏（< 1180px）自动折成上下结构 |
| **前端视觉** | 树莓玫红 × 松石青 × 焦糖琥珀 × 桑葚紫撞色；KPI 卡左侧彩色竖条、XTHUB 风细线表格与胶囊徽标、Bento 非对称双栏；`<select>` / `<input type="date">` 全部换成自绘控件 |
| **冷启动按需加载** | 启动只解析近 7 天有写入的文件，其余只登记 stat 指纹；切到更宽档位时按双边界补齐，配「正在读取历史数据」提示与脱敏索引（见[冷启动按需加载](#冷启动按需加载)） |
| **明细排序** | 会话抽屉「逐次请求明细」与工作台「明细」版面各加一个顶部 Tag，默认时间逆序，点击切正 / 逆序（见[明细排序（两处）](#明细排序两处)） |
| **长会话可读性** | 上下文增长曲线默认只铺 100 个请求点，底部滚动杆带全长缩略轮廓；5 秒重绘保留用户拖到的窗口；图例配色与主图一致 |
| **工程与回归** | 10 万请求级性能加固、`revision` 稳定态跳过重绘、按需加载索引与安全边界、单测 66 / 浏览器 E2E 119 项，全程控制台 `0 error / 0 warning` |

一键启动、命令清单与验证结果见[快速开始](#快速开始)与[测试](#测试)。

## 看板长什么样

**总览：左侧盯盘，右侧看账。** 左侧固定导航栏把主题切换、三个视图页签、最近活跃会话卡与累计统计收在一起，右侧全宽铺开 KPI、用量趋势、项目排行、模型分布、模型明细与工具调用分布。下面还有时间去向三段堆叠条、最慢的工具调用，以及按天分桶的「时间去向趋势」——只有一个总数时看不出变好还是变坏，趋势才可行动。

![暖砂亮色总览](docs/screenshots/01-overview-light.png)

**同一视角的深焙暗色主题。** 不是把亮色简单反相：暗色用 `#131110` 画布与石墨面板，强调色、状态条和图表配色都有对应的暗色取值，长时间盯盘不刺眼。切换是即时的，偏好持久化，刷新页面不会跳回亮色。

![深焙暗色总览](docs/screenshots/02-overview-dark.png)

**会话列表：按项目分组，成本结构直接摊开。** 组头本身就是一行小计，数值按列对齐，收起一个组也不会丢总量信息；组内每行给请求数、输入 / 输出、缓存命中率、credit、时长与「用时构成」微缩条。表头可点击排序（默认 credit 降序），点任意一行打开会话抽屉。会话多时先渲染前 200 行，组头小计仍按全量计算，可「显示更多 / 显示全部」。

![会话列表](docs/screenshots/03-sessions.png)

**会话详情抽屉：** 本轮用量卡、会话轮次列表、六张 KPI、时间去向、最慢工具、上下文增长曲线与逐次请求明细从上到下排开。一次用户提问到回答之间往往夹着多次模型请求和工具调用，所以抽屉按 `(sessionId, traceId)` 把一轮聚成一行；点开某一轮可看该轮的逐请求明细，还能一键跳到下方完整明细表定位并高亮同轮的行。

几个刻意的口径与交互：

- 缺失 `traceId` 的请求**各自独立**成「未归属请求」，绝不并成一个空轮；
- 命中率分母为 0 时显示 `—`，不把「没有输入」画成 0%；
- 最近 5 分钟内有更新的轮次标为「活跃 · 最近更新」，**不**冒充「已结算」；
- 轮次列表与展开明细、逐次请求明细都走定高虚拟窗口，几百轮也只渲染视口内的行；`turnLimit` 裁剪时汇总仍覆盖全部轮次，界面会明说「仅显示最近 N 轮」；
- 「逐次请求明细」右上角的时间排序 Tag 默认 `时间 ↓ 最新在前`，`#` 始终表示「第几次请求」，不随排序翻转；上下文增长曲线恒按请求序号正序，切排序不影响它；
- 自动刷新失败时保留上一拍数据，但顶部会出现提示条，不会让旧数字看起来是实时的。

![会话详情抽屉](docs/screenshots/04-session-detail.png)

**最近活跃盯盘卡（左侧栏常驻）。** 抬头就能看到最可能被关心的那一轮：会话标题、最近活动时间、本轮积分、累计积分、请求数与轮次数，四项指标随 5 秒刷新链自动更新，点「查看详情」直接打开抽屉。默认「跟随最近活跃」，多会话交替写入时目标会自己切过去；点「固定此会话」就锁住当前会话，别的会话再活跃也只给一句交代、不抢走视图。界面一律叫「最近活跃」，**不叫「当前打开」**——本地日志里没有前台窗口信号。刚创建、还没有结算记录的会话只显示「尚无用量记录」空态，不会摆一排假的 0。

**请求明细：按 `messageId` 去重，展开可见耗时推导全过程。** 端到端耗时、每请求固定开销、净出字时长、瞬时速度逐项列出，任何一段算不出来都显示 `—`，而不是编一个数。右上角同样有时间排序 Tag；这里切换会走后端按全局时间顺序重新分页，不是只翻转当前这一页，并自动回到第 1 页。

![请求明细](docs/screenshots/05-requests.png)

**筛选与自绘控件。** 时间档位顺序为「今天 → 昨天 → 近 7 天 → 近 30 天 → 全部」，默认「今天」；起止日期、项目 / 模型 / 类型、关键词与趋势粒度排成一条细线控制栏。`<select>` 的展开列表和 `<input type="date">` 的日历面板浏览器不开放样式，所以用 `AppSelect` / `AppDatePicker` 重写（`Teleport` 到 body、支持键盘操作、空间不足自动上翻）。宽档位首次加载历史时，顶部给「正在读取历史数据」提示但**不清空当前视图**，筛选栏同时交代「已加载 N / M 个文件」。

**窄屏适配**：低于 1180px 时左侧栏折成顶栏、页签横排，KPI 变 3 列 × 2 排且严格等高（1150px 实测 6 张全部 110px），时间去向面板的内容填充率仍 > 70%。

![窄屏布局](docs/screenshots/06-narrow.png)

## 快速开始

环境要求：**Node.js ≥ 20**。无需数据库，无需任何三方服务。

### 一键启动（推荐）

直接双击项目根目录的 **`start-dashboard.bat`**。它会：打印本次使用的 node 绝对路径 → 必要时补构建前端 → 起服务 → 等 `/api/meta` 就绪后自动打开浏览器 → 保持窗口常驻。**按 Ctrl+C 或关掉这个窗口即停止服务**。

之所以需要这个脚本：WorkBuddy 把 node 挂在**会话内临时注入的 PATH** 上，你自己的用户 PATH 里没有 `node` / `npm`，关掉对话后在普通终端敲 `npm start` 会报「不是内部或外部命令」。脚本不按名字调用，而是按绝对路径调用 `node.exe`，并在启动窗口第一行打印出来便于核对：

```
Node runtime : PINNED absolute path (NOT from your user PATH)
              %USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
Version      : v22.22.2
```

脚本顶部 `NODE_EXE` 用 `%USERPROFILE%` 展开，不写死账户名，换机器 / 换账户也能用。若 WorkBuddy 升级 Node 导致该版本目录失效，脚本会自动在 `%USERPROFILE%\.workbuddy\binaries\node\versions\` 下探测其它版本，打印 `AUTO-DETECTED fallback` 与实际路径；都找不到时才回落到 PATH 里的 `node` 并要求改脚本顶部。

| 用法 | 作用 |
| --- | --- |
| 双击 `start-dashboard.bat` | 启动并自动打开浏览器 |
| `start-dashboard.bat build` | 先用同一个 node 重建 `web/dist` 再启动（改完前端用） |
| `start-dashboard.bat check` | 只打印 node 路径 / 版本 / 数据源 / 产物状态，**不启服务** |

脚本顶部还可改 `PORT`（默认 `5178`）；`web/dist` 缺失时会用同一个 node 自动构建一次；设 `DASHBOARD_NO_BROWSER=1` 跳过自动开浏览器，取消 `FORCE_FULL_LOAD=1` 注释可回到全量加载路径。窗口内已设 `chcp 65001`，服务日志的中文不会乱码；`.gitattributes` 里为 `.bat` 固定了 `eol=crlf`，Windows 命令行才能正确逐行解析。

### 没装 WorkBuddy？先看演示

```bash
npm install
npm run build
npm run demo        # 生成合成数据并启动 → http://127.0.0.1:5178
```

`npm run demo` 会在 `.demo/` 下生成一份合成会话 JSONL 并以其为数据源启动服务，方便体验与截图；真实数据源不变，两条命令互不影响。README 的全部截图都基于这份数据。

### 用真实数据

装了 WorkBuddy 的话，数据已经在本地了，直接：

```bash
npm install
npm run dev         # 前后端一起起：看板 127.0.0.1:5177 / 接口 127.0.0.1:5178
```

数据目录默认取 `~/.workbuddy`，可用环境变量覆盖：

```bash
WORKBUDDY_HOME=D:/other/.workbuddy npm run dev:server
```

生产模式（单端口，服务端顺带托管打包产物）：

```bash
npm run build
npm start           # http://127.0.0.1:5178
```

### 交付产物与自检

`npm run build` 生成 `web/dist/`：`index.html` + `assets/` 下带内容 hash 的 JS / CSS / 字体 / 图片，共 **7 个文件、869,364 B（约 850 KB）**。它是**构建产物、不入库**（`.gitignore` 忽略 `dist/`），交付时随源码目录一起拷贝即可；换环境只需重跑一次 `npm run build`。

`npm start` 由同一个 Node 进程在 `http://127.0.0.1:5178` 同时提供 `/api/*` 与静态页面，不需要 nginx、Vite 或第二个常驻进程。启动日志会明确写出 `web/dist 已托管`；若产物缺失则提示先 `npm run build`，此时只提供 API。SPA 深链接与找不到的静态路径都回落到 `index.html`，`/api/*` 的未知路径仍返回 404。

**运行依赖只有三样**：Node.js ≥ 20、项目源码（含 `node_modules` 或 `npm ci` 重装）、一份可读的 WorkBuddy 会话日志目录。服务只读 `WORKBUDDY_HOME/projects/**/*.jsonl`，扫描状态写在项目内 `server/.cache/`，**不写入 WorkBuddy 目录、不修改其配置**；前端所有请求走同源 `/api`，源码里没有任何指向外部统计服务的请求；应用也不依赖 Agent 运行时，关掉对话后照常使用（用 `start-dashboard.bat` 启动，不需要 WorkBuddy 会话 PATH）。

在**干净目录**（无 `node_modules`、无 `web/dist`）按文档从零复现：

```bash
npm ci                              # 用 package-lock.json 精确重装
npm run build                       # 生成 web/dist
WORKBUDDY_HOME=/path/to/workbuddy npm start
curl -fsS http://127.0.0.1:5178/api/meta
curl -fsS http://127.0.0.1:5178/ | grep 'id="app"'
```

干净环境实测（把源码复制到新目录后真实执行，端口改 5183 避免冲突）：`npm ci --offline` 装 39 个包 / 16s → `npm run build` 2.07s → `npm start` 启动后 `/api/meta` 返回 219 条请求 / 10 个会话；首页与 JS/CSS 资源均 200 且 MIME、字节数与产物一致，SPA 兜底正常、未知 API 404、目录穿越无源码泄漏、监听地址仅 `127.0.0.1:5183`。临时验证目录已在收尾时删除。

最终全套回归（2026-11-14 重启新后端后复跑）：

| 验证项 | 结果 |
| --- | --- |
| `npm test` 单元测试 | **66 / 66** |
| `npm run test:e2e` 浏览器端到端 | **119 / 119**（含 1150px 窄屏与两处排序断言） |
| `npm run test:reconcile` 独立全量对账 | 10 个静态会话逐项吻合 |
| `npm run test:live` | **31 / 31** |
| `npm run test:active` | **26 / 26** |
| `npm run test:phase1` | **42 / 42** |
| `npm run test:final` | **27 / 27** |
| `npm run test:large` | **10 / 10** |
| 浏览器控制台 | `0 error / 0 warning` |

### 本地边界

解析服务默认**只监听 `127.0.0.1:5178`**，Vite 开发服务器也只监听 `127.0.0.1:5177`，局域网与其他网卡都访问不到。除了绑定回环，服务端还会：

- 校验 `Host` 头，拒绝非本机主机名（挡 DNS rebinding）；
- CORS 默认只允许回环地址上的本地来源，不再下发 `Access-Control-Allow-Origin: *`。

本机 `localhost` 会优先解析成 `::1`，所以文档、Vite 代理、E2E 与对账脚本统一写 `127.0.0.1`。确需调整时可用环境变量（改动等于扩大可达范围，请自行评估）：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `WORKBUDDY_HOME` | `~/.workbuddy` | 数据源目录，须含 `projects/` 子目录 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `5178` | API / 生产页面端口 |
| `DEV_PORT` | `5177` | Vite dev 端口，仅用于生成默认 CORS 白名单 |
| `CORS_ORIGIN` | 回环白名单 | 追加逗号分隔的来源；显式写 `*` 才恢复任意来源 |
| `HOST_ALLOWLIST` | 空 | 追加逗号分隔的允许 Host |
| `SCAN_INTERVAL_MS` | `5000` | 增量扫描间隔 |
| `FORCE_FULL_LOAD` | 空 | 设为 `1` 时启动走全量解析路径（回归夹具 / 排障） |
| `HOT_DAYS` | `7` | 冷启动预热窗口天数 |
| `TOKEN_DASHBOARD_CACHE_DIR` | `server/.cache` | 索引与扫描状态目录；并行跑多个数据源时指到独立目录 |

### 实时调试夹具

`npm run demo:live` 会重置 `.live/workbuddy` 下的**单个会话**，启动服务后按节拍持续往 JSONL 追加：每轮 3 次模型请求共享一个 `traceId`，每批只追加 1 次请求，中间夹工具调用与返回，每轮换 `traceId`，并周期性插入一条缺失 `traceId` 的用量行。模型名、工具名与会话标题故意带 HTML 特殊字符，用来验证 tooltip 转义。它是纯合成数据，用来调试「边写边读」和后续轮次聚合，不读取真实会话。

只想追加固定批数（服务另开）时：

```bash
node scripts/live-demo.js --gen
WORKBUDDY_HOME=.live/workbuddy npm start
node scripts/live-demo.js --no-serve --steps=6 --interval=600
```

### Windows 提示

npm 在 workspace 下可能漏装平台专用的可选依赖，若启动报 `Cannot find module @rollup/rollup-win32-x64-msvc` 或 `@esbuild/win32-x64`：

```bash
npm i -D @rollup/rollup-win32-x64-msvc @esbuild/win32-x64
```

这两个包已在 devDependencies 里，全新安装不会再遇到；换到 macOS / Linux 时删掉重新 `npm install` 即可。另外，npm workspaces 的软链记录的是绝对路径，**移动项目目录后**需要重跑一次 `npm install`（报 `Cannot find module 'token-dashboard-server'` 就是这个原因）。`start-dashboard.bat` 必须是 CRLF 换行，仓库已用 `.gitattributes` 固定，别用会改换行符的编辑器另存为 LF。

## 数据从哪来

WorkBuddy 把每个工作区的会话记录写成追加式 JSONL：

```
~/.workbuddy/projects/<项目目录名>/<sessionId>.jsonl
```

- `<项目目录名>` 是 cwd 的编码形式（如 `d-CODE-MyApp` 对应 `D:\code\MyApp`），目录名只是兜底，每行里的 `cwd` 字段才是真值
- 追加写：文件只会变长，不会原地改写——这决定了可以增量解析

每一行是一个 JSON 对象，`type` 取值：

| type | 含义 |
| --- | --- |
| `session-meta` | 会话元信息 |
| `ai-title` | AI 生成的会话标题（看板里的会话名） |
| `message` | 用户/助手消息，**可能带用量** |
| `reasoning` | 思考过程 |
| `function_call` | 工具调用，**大部分用量在这里** |
| `function_call_result` | 工具返回 |
| `file-history-snapshot` | 文件快照 |

token 用量只挂在有真实请求的行上，位置是 `providerData.rawUsage`：

```jsonc
{
  "type": "function_call",
  "timestamp": 1790000000000,
  "sessionId": "3f9c2a1e-47b8-4d0f-9a51-c2e8d6b03a77",
  "cwd": "D:\\code\\webshop",
  "name": "Bash",
  "providerData": {
    "messageId": "01a9d3f2c8e41b675a209d1c3e8b7f11",   // 唯一键
    "traceId": "a71f3c02b5d94e8a",                     // 一轮对话，含多次请求
    "model": "deepseek-v4.1-flash",
    "rawUsage": {
      "prompt_tokens": 36945,               // 本次请求的输入
      "completion_tokens": 30382,           // 本次请求的输出（含思考）
      "total_tokens": 67327,
      "prompt_cache_hit_tokens": 8832,      // 命中提示缓存的输入
      "prompt_cache_miss_tokens": 28113,    // 未命中的输入（按全价计）
      "completion_thinking_tokens": 23690,  // 思考 token
      "credit": 2.14                        // 平台算好的结算单位 = 真实成本
    }
  }
}
```

## 五个必须踩准的口径

**1. 计数单位是 `messageId`，不是行数，也不是 `traceId`。**
`messageId` 全局唯一，标识一次 API 请求；`traceId` 标识一轮用户对话，里面包含「思考 → 调工具 → 拿结果 → 再思考」的多次请求，会重复 1~58 次。按 `traceId` 计数会把用量少算几倍，看板统一以 `messageId` 去重。

**2. `rawUsage` 是单次请求的增量，不是累计值。**
相邻两次请求的 `prompt_tokens` 从 36945 涨到 67363，是上下文随对话增长，不是「累计到 67363」，求和时直接相加即可。

**3. `credit` 就是成本，不需要自己维护价格表。**
credit 和 token 数不成正比——一个真实例子：`kimi-k3-1` 6 次请求结算 107.2 credit，`deepseek-v4.1-flash` 404 次才 59.4，**6 次花掉的钱是 404 次的 1.8 倍**。自建价格表很难算准这种差异，直接用平台算好的 `credit` 反而最准。

**4. 一轮 = `(sessionId, traceId)`；缺 `traceId` 的请求各自独立成轮。**
`/api/session` 的 `turns` 按轮聚合输入、输出、缓存命中/未命中、reasoning、credit 与去重后的请求数；`turnSummary` 是全轮次合计，`latestTurn` 是最近一轮。三者与 `summary` / `steps` 使用**同一份筛选后的记录**，不会出现「KPI 是今天的、轮次是全历史」的口径分裂。日志里偶尔有不带 `traceId` 的用量行，它们按 `messageId` 各自成为 `isOrphan: true` 的「未归属轮次」，绝不合并成一个空轮 —— 否则跨天的孤立请求会被错算成一次对话。`turnLimit`（默认 200、上限 500）只裁剪返回的列表，`turnSummary` 始终覆盖全部轮次；`steps[].turnKey` 与 `turns[].turnKey` 对应，前端可直接在本地按轮次下钻。

**5.「最近活跃」不是「当前打开」。**
`/api/meta` 的 `latestActiveSessionId` 取三者最大值：会话文件的 `mtimeMs`、时间线最后事件、最后一条用量记录 —— 只看 credit 会让跟随滞后整整一轮，因为一轮开始时的用户消息和工具调用还没有结算记录。只有 `session-meta` / `ai-title`、既无事件也无用量的文件不参与候选，避免凭空冒出一个 0 消耗会话。本地日志没有 WorkBuddy 前台窗口信号，并发多个会话时只能知道「哪个文件最后被写过」；想锁定某个会话请用左侧盯盘卡的「固定此会话」。

## 耗时是怎么算出来的

本地 JSONL **没有任何耗时字段**（把 13 个会话、4445 行、1162 条带用量的记录全字段枚举验证过）。但时间可以从事件时间线上推出来，只需要三个事实：

1. 一次请求 = 一个 `providerData.messageId`，且恰好只有一行带 `rawUsage`——这一行的 `timestamp` 就是该次请求的**完成时刻**。
2. 请求的起点 ≈ 上一个**边界事件**（用户消息 / 上一条工具返回）的 `timestamp`，两者相减 = 端到端耗时。
3. 工具耗时可以直接配对：`function_call.callId` ↔ `function_call_result.callId`，实测几乎 100% 配得上（配不上的只有被中断的会话）。这是耗时维度里最硬的部分。

`reasoning` / `file-history-snapshot` 这类行的时间戳和请求完成点相差不到 20 毫秒，留在时间线上只会把 127 秒的生成时间错记到某个碎行头上，所以直接丢弃。

**直接相除是错的。** `输出 token ÷ 耗时` 会严重低估短请求，实测按输出量分桶：

| 输出 token | 平均耗时 | 相除得到的「速度」 |
| --- | --- | --- |
| 0 – 200 | 3.97s | 29 t/s |
| 1 000 – 5 000 | 10.9s | 178 t/s |
| 5 000 – 20 000 | 33.0s | 226 t/s |
| 20 000+ | 128s | 239 t/s |

真相是 `耗时 ≈ 每请求固定开销 + 输出 ÷ 吐字速度`，所以用**最小二乘拟合**：斜率倒数就是吐字速度，截距就是固定开销。真实数据实测 `deepseek-v4.1-flash`：斜率 → 250 t/s，截距 → 3.41s，R² = 0.96（n = 1154）。每条请求的**净出字时长 = 耗时 − 该模型固定开销**，短请求也能得到量级正确的瞬时速度。

两个口径必须分开说，混着展示会让人以为数字前后矛盾：

| 口径 | 定义 | 用在哪 |
| --- | --- | --- |
| 拟合吐字速度 | 全量样本拟合斜率，按输出量加权 | 看板主指标、模型明细 |
| 实测平均速度 | Σ输出 ÷ Σ净时长，**系统性偏低**（含调度空转） | 只作对照 |

已知限制：净出字时长里仍含 prefill（处理输入）的时间，未命中缓存输入很大的请求单条读数会被拉低；这一项主要落在截距里，不影响模型级斜率。想彻底分离需要把 prefill 一起建模，但缓存命中/未命中两个字段高度共线，直接多元回归不收敛，留作后续。

**时间去向**把在岗时长拆成**模型生成 / 工具执行 / 人的环节**三段，阶段划分互不重叠：并行工具调用先来 `fc#1`、`fc#2` 再来 `fcr#1`、`fcr#2`，逐段累加正好等于 `fcr#2 − fc#1`，不会因为工具并行而重复计时。

这个视图的几个口径都是按实测定的，不是拍脑袋：

- **叫「人的环节」而不是「等待用户」**。那段时间是你在读、在想、在组织下一句，不是模型在空转。名字起错，读的人就会得出相反的结论。
- **30 分钟的「离开」阈值**：97 个人机间隔的长度从 1.1min **连续**铺到 23.8min，唯一一个真实断层在 23.8min → 51.8min（×2.18），30 分钟正好落在断口里。⚠ 所以**没有**再分「90 秒 / 10 分钟」那种中间档——数据里不存在第二个断点，硬切只会把「读一段长回复」误判成「离开」。
- **阈值实际上只作用于「人的环节」**：模型段最长 11.8min、工具段最长 5.1min，都远够不到 30 分钟。所以「离开」判断天然只发生在「模型答完 → 你下一条消息」之间。
- **离开不画进条里**：离开一天能到 20 小时，画进去另外三段会被压成看不见的细线。离开的量单独用文字交代。
- **「人的环节」里 ≥5 分钟的间隔单独报一个数**：是读长文档、去开会还是真的走开，日志里区分不出来——如实交代，而不是替用户假设一个档位把它切掉。
- **每 credit 在岗 N 分**：在岗时长绝对值多少其实没意义，但「换 1 个 credit 要在岗多久」可以横向比，这是把「这段时间花得值不值」变成可算的数的最小抓手。

**跨会话合成用并集（扫描线），不是相加。** 并行开两个会话时，同一段时间会被算两次：实测 15 个会话相加 107.5h，而真实墙钟（并集）只有 100.4h —— **虚高 7%**，并行越多错得越离谱。做法是把时间轴切成「活跃集合不变」的小段，每段按活跃会话数均分给各自的类型 —— 这样 Σ三段 恒等于在岗时长（并集长度），占比才自洽。离开只在**没有任何会话在工作**时才计入，否则一个人去开会，会把另一个还在跑的会话的真实在岗时间也涂成「离开」。

**时间去向趋势**：按当前粒度分桶（先按桶边界切开区间再逐桶做扫描线，跨零点的段不会整段算进前一天）。只有一个总数时，「这周比上周怎么样」无从谈起 —— 绝对值多少不重要，趋势才可行动。

## 架构

```
浏览器 (Vue3 + ECharts, :5177 dev / :5178 生产同源)
    │  /api/*
    ▼
解析服务 (Node http, :5178)
    ├── config.js      定位数据源、端口、CORS / Host 白名单、冷热与回退开关
    ├── scanner.js     发现 projects/**/*.jsonl，冷热三态 + 增量续读（记录 + 时间线事件）
    ├── parser.js      行 → 规范化用量记录 / 时间线事件
    ├── timing.js      耗时推导：请求耗时、工具配对、阶段分解、速度拟合、扫描线并集
    ├── store.js       内存存储 + 过滤 / 分组 / 分桶聚合 + revision
    ├── file-index.js  极简文件索引（stat 指纹、真实首尾时间戳、模型集合）
    └── index.js       REST API + 静态托管 + 5s 自动重扫 + ensureLoaded 按需加载入口
```

解析服务**只用 `node:` 内置模块**，没有 express、没有 sqlite，`npm start` 即跑。

**增量策略**：JSONL 是追加写的，按文件维护 `{ size, offset, mtimeMs }`——没变直接跳过；变大就从 `offset` 读尾巴、只解析新增行；变小判定被重写、整体重解析；且只处理到最后一个 `\n`，避免把正在写的半行解析掉。冷启动时未加载的文件只登记指纹，后续扫描对它们**只更新指纹、不解析、不算 changed**，所以稳定态 5 秒一拍不会把历史重新吞回来。

**时间线事件也必须增量累积**：耗时的差值跨解析块——工具跑了几分钟，中间文件可能被追加过好几轮，某次请求的起点就落在上一次读进来的那段里。所以解析块除了吐记录，还要吐一份有序事件流（用户消息 / 带用量的请求 / 工具返回，其余行直接丢弃），攒齐之后才做配对；配对逻辑放在单行解析里的话，每条请求的起点都会丢。

**刷新链路（两段独立的定时器，缺一段都看不到实时数据）**：

| 环节 | 做什么 | 周期 |
| --- | --- | --- |
| 服务端 `index.js` | 增量重扫 JSONL，把新记录读进内存 `Store` | 5s（`SCAN_INTERVAL_MS` 可调） |
| 前端 `App.vue` | 静默重取 `meta` + 当前页签 + 已打开的抽屉 | 5s，切到后台自动暂停、切回立刻补一拍 |

这点很容易踩：**只加服务端扫描，页面不会自己变**（页面只在挂载 / 筛选变化 / 点刷新时取数），看上去就像「自动扫描没生效」；反过来只加前端轮询，也只是把同一份旧数据反复拉下来。所以判断「自动更新有没有生效」，看侧栏底部那个「最近扫描」时间会不会自己往前走最快。

前端自动那一路走的是只读接口，**不调 `POST /api/refresh`**——强制重扫是手动按钮的语义，两边职责分开。`meta.revision` 只在服务端 `rebuild()` 时 +1，前端在「版本没变且上一拍全部同步成功」时整拍跳过重取与重绘；一次取数失败也会在下一拍重试，不会把失败当成已完成。

## 前端的几个取舍

**双主题与全宽工作台。** 颜色全部收敛到 `style.css` 的 CSS 变量，`html[data-theme]` 一处切换全局生效，偏好存 `localStorage`。布局是 `grid-template-columns: 252px minmax(0, 1fr)`，右侧不设 `max-width`，2K 大屏自动铺满；< 1180px 自动折成上下结构。把最近活跃盯盘卡放进侧栏，是为了释放右侧首屏的垂直空间，而不是再加一条横幅。

**会话明细的窗口化渲染。** 真实数据里最长会话有 1381 次请求，13 列全量铺开是上万个单元格；叠加 5 秒自动重取，整张表会跟着重渲染，滚动明显掉帧。现在只渲染视口内的行（固定行高 34px + 上下占位行撑出滚动高度），DOM 节点数与会话长度脱钩 —— 几百条的会话实测只渲染约 19 行。不引三方虚拟列表是因为需求只有「定高行 + 单列滚动」这一种，手写不到 30 行；引库反而要额外处理它和 sticky 表头、和 5 秒轮询的配合。轮次列表与展开明细用同一套定高窗口。

**上下文增长曲线用双 Y 轴 + 可缩放窗口。** 输入动辄上万 token、输出只有几百，量级差约 100 倍，合在一根轴上输出会被压成贴着底边的直线，等于没画。拆成左轴输入（缓存命中 + 未命中两层堆叠面积，总高度就是单次请求的输入上下文）、右轴输出（柱）——双轴唯一站得住的场景就是**同单位、不同量级**，换成 token vs 百分比那种异单位双轴就开始骗人了。长会话默认只铺前 100 个请求点，底部滚动杆里画整条曲线的缩略轮廓，滚轮缩放 / 拖动平移；5 秒重绘前会取出当前 `dataZoom` 的 `start/end` 并回并，否则刚拖到的位置会被弹回 #1。图例图标取 `series.itemStyle.color` 而**不是** `lineStyle.color`，三个 series 都显式补了主色，才没让图例落回 ECharts 默认调色板。

**筛选条件存 localStorage，只在当天生效。** 四条规则：
① 隔天打开一律回默认 —— 还原出昨天的关键词，用户第一反应是「我明明没筛，数据怎么这么少」，这是记忆功能最经典的翻车方式；
② 相对区间（今天 / 昨天 / 近 7 天…）**只存档位名**，还原时按当天重算，绝不冻结算出来的绝对日期；页面跨零点一直开着时，`poll()` 与切回前台都会检查本地日期，变了就重算 `from/to`；
③ 绝对条件（项目 / 模型 / 类型）先用 meta 校验一道，已消失的选项清回「全部」，避免空选择器 + 恒 0 条结果；
④ 历史数据渐进补全期间**不清用户已选项**，等加载完成才恢复校验，避免刚选的项目被瞬间抹掉。
区间档位定义抽到 `web/src/utils/ranges.js`，FilterBar 与存储共用同一份 —— 两边各写一套迟早会对不上。

**状态提示集中一处。** stale（自动刷新失败）、历史加载中、历史读取失败共用一个容器并按优先级显示，服务从未连上时一条都不常驻；「正在读取历史数据」出现期间**当前视图不清空**，只是独立的一条 banner。

## API

除 `/api/refresh` 为 `POST` 外均为 `GET`。统一支持 `from`、`to`、`projectId`、`model`、`kind`、`keyword`、`granularity`（`hour` / `day` / `month`），所有视图口径一致：

| 端点 | 用途 |
| --- | --- |
| `GET /api/meta` | 数据源路径、可用筛选值、记录数、模型速度画像、`revision`，以及 `loadedFiles` / `totalFiles` / `fullLoad` 加载状态 |
| `GET /api/overview` | KPI + 趋势 + 按模型 / 项目 / 工具分布 + 时间去向（含按粒度趋势）+ 工具耗时排行 |
| `GET /api/sessions` | 会话级聚合（AI 标题、缓存命中率、时长、时间去向） |
| `GET /api/session?sessionId=` | 单会话逐次请求（耗时 / 净出字时长 / 瞬时速度）+ 上下文增长曲线 + 轮次（`turns` / `turnSummary` / `latestTurn`，支持 `turnLimit`） |
| `GET /api/requests` | 请求明细，分页 `page` / `size`，`order=asc|desc` 控制时间顺序（缺省逆序） |
| `POST /api/refresh` | 立即重扫 |

速度相关字段别搞混：`summary.measuredSpeed` 是实测口径（偏低）；`overview.speed.tps` 是拟合口径，界面上那个主指标；`step.tps` 是单条请求的瞬时速度，噪声大，净出字时长不足时给 `null`。

按时间筛选到历史区间时，服务端会在 handler 之前按 `birthtimeMs <= to && mtimeMs >= from` 圈出尚未加载的冷文件并解析补齐，**该请求返回时数据已是新版本**，前端不需要再发一次换数请求；`/api/session` 则按 `sessionId` 定向加载那一个文件。

## 测试

```bash
npm test               # 全套单测：解析/耗时/边界/轮次/最近活跃/API 去重/tooltip 转义/排序换算（66 项）
npm run test:web       # 只跑前端纯函数单测
npm run test:reconcile # 独立全量解析 vs 看板 API 对账；含轮次独立复算（需服务在跑）
npm run test:e2e       # 真实浏览器渲染 + 逐项交互断言（119 项，需先 build）
npm run test:live      # live 追加 + 故障重试 + 页签同步 + tooltip 注入面验证（31 项）
npm run test:active    # 多会话交替追加 + 跟随/固定模式 + 无 credit 新会话（26 项）
npm run test:large     # 500 会话的真实 DOM 截断、显示更多/全部、分组折叠（10 项）
npm run test:final     # 脏行/半行/重写/跨天筛选、故障恢复、本地边界与敏感数据集成验证（27 项）
npm run test:phase1    # 冷启动/按需加载/索引/安全/前端提示的服务链路验证（42 项）
npm run index:rebuild  # 全量重建 server/.cache/file-index.json（CLI，不启服务、不占端口）
npm run index:verify   # 只校验不写盘；输出「校验通过 / 发现 N 个异常文件」
npm run perf:gen       # 生成 10 万请求级合成数据到 .perf/（不启服务）
npm run perf:bench     # 冷启动 / 各 API / 少量追加 / 内存基准
npm run perf:compare   # 将首次终端基线与指定 tag 的最终基准做前后对照
```

`test:reconcile` 的第二段会**独立重写一遍耗时算法**（刻意不 import `src/timing.js`，否则等于拿同一份代码验自己），只挑最近没被写过的静态会话，逐项比对工具耗时合计、每次请求耗时、阶段时长与全程跨度——正在写入的会话不参与比对，那是时序问题不是算错。第三段同理**独立重写一遍轮次分组**（不 import `src/store.js`），逐会话核对轮次数、每轮的 Token / credit / 请求数，以及轮次合计是否等于原始记录逐项求和。它在 `server/` workspace 下运行时，相对的 `WORKBUDDY_HOME` 会被解析成 `server/.demo/...`，**必须传绝对路径**。

`test:e2e` 用 CDP 驱动无头浏览器真实渲染：逐个切页签、开抽屉、展开本轮轮次明细并定位、展开请求详情与自绘控件、切换最近活跃的跟随 / 固定模式、断言两处排序 Tag 的默认值与切换结果、断言页面已无原生 `select` / date 输入、控制台无 error / warning，并断言「时间去向三段堆叠条宽度之和 = 100%」（算漏一段只会表现为条变短，肉眼很难发现），最后把视口压到 1150px 断点验证 KPI 等高。**这一步很必要**——ECharts 容器挂在 `v-else-if` 分支里、`v-show` 对多根组件不生效、按需引入的 `dataZoom` 组件漏注册会被静默忽略，构建阶段全都不报错，只有真实渲染才暴露。

`test:live` 另起一个只绑回环的 5179 服务，用 `.live/` 合成夹具按批追加，观察记录数逐步增长、核对 `traceId` 分组与孤立请求，再把真实的 tooltip 模板输出插进浏览器 `innerHTML`，断言恶意名称不会变成元素。它还注入一次总览 503 验证 `revision` 不变也会重试，并分别给抽屉和最近活跃卡注入短暂失败，断言非实时标记出现、下一拍自动清除且不残留旧状态。`test:active` 用 5180 服务和 `.active/` 夹具，四个会话交替追加验证跟随切换与「固定」不被抢走。`test:final` 在 `.final/` 夹具上跑「脏行 → 半行补完 → 跨天日期筛选 → 文件变小重写」，并用真实 HTTP 请求验证恶意 Host、CORS 白名单、静态目录穿越、原始提示词不进入 API / DOM。`test:phase1` 起真实服务验证冷启动 `N < M`、切档后与全量路径逐条一致、加载失败可重试恢复、索引损坏回退全量与 Host / CORS / 穿越边界。

浏览器 profile 落在**系统临时目录**（`wb-e2e-profile-<端口>` / `wb-shots-profile-<端口>`），退出时删除。不放在 `.cache/` 是因为 Windows 上 Chromium 退出后句柄不会立刻释放，删除失败一次就是 57MB —— 实测 `.cache/` 里攒过 13 个共 **743MB**，比整个仓库还大。万一这次没删掉，下次运行开头的 sweep 会清（只清**一小时前**的）。

`tools/screenshots.js` 负责重截 README 的 6 张图：CDP 无头浏览器、`deviceScaleFactor=2`、每次截图前等图表动画收尾、数据源固定为 `.demo/` 合成数据。运行前先起演示服务，再用 `BASE_URL=http://127.0.0.1:<端口> node tools/screenshots.js` 覆盖 `docs/screenshots/`。

## 冷启动按需加载

服务**不再在启动时全量读所有会话日志**。启动时只 `stat` 全部文件（毫秒级），完整解析「近 7 天内有写入」的文件，其余冷文件只登记 `size / mtimeMs / birthtimeMs` 指纹、不读内容；默认档位是「今天」，首屏零额外读盘。切到「近 30 天」「全部」或按日期自定义筛选时，服务端在返回该请求前按 `birthtimeMs <= to && mtimeMs >= from` 双边界圈出候选冷文件、解析补齐，数据到手才响应；页面同时给一条「正在读取历史数据」提示（不清空当前视图），筛选栏写「已加载 N / M 个文件」。加载过的文件不卸载，重复切档不再读盘。

判断不依赖读内容，也不需要重建读取逻辑：`fs.stat()` 免费给的创建时间与修改时间就够了。索引（`server/.cache/file-index.json`）只记汇总量（stat 指纹、真实首尾时间戳、模型集合），**不写标题 / cwd / 提示词**；损坏、版本不符或换 `WORKBUDDY_HOME` 时丢弃并自动回退全量一次，不作为正确性依赖。

真实数据实测（173 个 JSONL / 375 MB，阶段 1 交付时）：

| 场景 | 结果 |
| --- | --- |
| 冷启动 | 加载 **28 / 173** 个文件、解析 **43,657,521 B**（全量路径 398,451,060 B） |
| 默认「今天」首屏 | 13 ms，`loadedFiles` 与 `revision` 均不变 |
| 首次切「全部」 | 1,637 ms 补齐 145 个文件 → 173/173，`revision` 只 +1 |
| 再切回「今天」 | 零读盘，业务 KPI 与切档前逐字段恒等 |

2026-11-14 重启后真实数据已增长到 177 个文件，冷启动为 **31 / 177**，`fullLoad=false`；按 2 年规模外推的冷启动门槛定为 ≤ 3000ms，当前余量充足（基准模型约 386ms、压力模型约 906ms）。

一键回退到全量路径：`FORCE_FULL_LOAD=1 npm start`（回归夹具、排障用）；`HOT_DAYS=N` 可改预热窗口（默认 7）。启动日志写「已加载 N / M 个文件 · 启动解析 X B」，并区分「FORCE_FULL_LOAD=1」与「索引不可用」两种全量原因。并行跑回归、或同时起多个指向不同 `WORKBUDDY_HOME` 的服务时，用 `TOKEN_DASHBOARD_CACHE_DIR=<临时目录>` 把缓存指到别处，避免各实例互踩同一个 `file-index.json` 的 `sourceKey`。

两点边界：

- 切档补载会触发一次 `rebuild()`，`summary.netMs / measuredSpeed / speedSamples` 与 `overview.speed` 随速度画像「越用越准」而变；积分、请求数、token、命中率、轮次、趋势分桶、最慢工具**逐字段恒等**。每拍追加新记录时同样会变，不是新增的口径问题。
- 冷文件没读过就没有索引真值，若其创建时间被复制 / 备份还原改晚，历史单日筛选可能漏判；用 `npm run index:rebuild` 全量重建真值即可。内存按「加载过不卸载」，切「全部」后仍随历史总量增长，本期只解决启动等待、不解决内存上限。

`npm run perf:bench` 的合成夹具所有文件都是刚写的、没有时间分布，**测不出冷热差异**，因此它固定带 `FORCE_FULL_LOAD=1`，基准数字仍可与早期版本对照；冷启动收益以上面的真实数据实测为准。

## 明细排序（两处）

「会话版面 → 打开会话 → 逐次请求明细」与「明细版面 → 请求明细」的右上角各有一个**时间排序 Tag**（`时间 ↓ 最新在前` / `时间 ↑ 最早在前`），点一下在逆序 / 正序间切换，控件本身写明当前方向，交互与会话列表的可点击列头一致。两处**默认都是时间逆序**；会话列表仍默认按 credit 降序，不受影响。

- 抽屉里的排序纯前端完成：`#` 始终表示「第几次请求」，不随排序翻转；「上下文增长曲线」恒按时间正序（横轴是请求序号），切排序不影响它；轮次「在完整明细中定位」会按当前顺序换算下标。
- 明细版面的排序走 `GET /api/requests?order=asc|desc`，由后端按**全局**时间顺序分页（不是只翻转当前页），切换后自动回到第 1 页；不传 `order` 或传非法值时仍是原来的逆序口径。
- 顺序换算集中在 `web/src/utils/sortOrder.js`，两个位置共用 `web/src/components/SortTag.vue`。

## 大数据表现

`npm run perf:bench -- --gen --tag=xxx` 会生成 20 项目 × 25 会话 × 200 请求 = **10 万条**用量记录，启动一个只绑回环的服务，实测冷启动、各 API、少量追加后的强制重扫与进程内存。所有计时都检查 HTTP 成功状态，追加段还逐次核对 `recordCount` 增加了对应条数，避免把错误响应或漏扫误记成性能提升。结果落在 `.perf/bench-<tag>.json`，可用 `--tag=before/after` 做前后对照。数据全是合成的，不读真实会话。

本机实测（Node 22，10 万条 / 500 会话）：

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 冷启动（全量解析 + 重建） | 1062ms | 545ms |
| 稳定态一拍（无新记录） | 约 121ms（meta + 总览 + 会话详情） | **5.8ms（只取 meta）** |
| 单会话详情 API | 7.1ms | 1.5ms |
| 追加 1 / 10 / 100 条后的重扫 | 106 / 93 / 87ms | 65 / 59 / 56ms |

最终基准在同样规模下重跑，并新增 `npm run perf:compare`：冷启动 **538ms**、稳定态 **6.1ms**、单会话详情 **1.6ms**、追加 1/10/100 条 **65.9/57.5/60.1ms**，与优化前终端基线相比分别下降约 **49% / 95% / 78% / 31~38%**，结果写入 `.perf/bench-final.json` 与 `.perf/compare-final.json`。**优化前原始 JSON 已被初版 `--gen` 误删，基线数值来自首次终端实测输出，不能重新生成**；对照脚本明确打印这一来源，不把它伪装成可复现文件。

几个关键做法：`Store.records()` 不再每次查询都复制并排序全历史，rebuild 时排一次即可；单会话详情走 `sessionId` 索引；`/api/meta` 返回 `revision`，前端只有在「版本没变且上一拍全部同步成功」时才整拍跳过重取与重绘；失败会在下一拍重试，切页签会主动补齐最新版本。同 URL 的 GET 在飞行中复用同一个 Promise，手动刷新会等当前 poll 与旧 GET 收尾后再重扫；会话列表超过 200 行时只渲染前 200 行（组头小计仍按全部会话算）；全量轮次索引改成惰性——生产路由根本不读它，没必要每次 rebuild 都白算 3 万多个轮次并排序。

**已知边界**：少量追加时仍会全量重算耗时推导、速度拟合与派生字段，所以 1 条和 100 条的重扫耗时接近（约 55~65ms），成本仍是 O(N) 而非 O(新增量)。10 万条 / 5 秒扫描间隔下占空比约 1.2%，且只在写盘期间发生，当前可接受；要做成真正随新增量增长，需要按会话维护增量游标（跨块事件配对）、把 `netMs/tps` 改成按画像即时计算、并让轮次累加器可增量更新。这属于单独的数据引擎改造；若规模再上一个数量级，应先提交实测依据再决定是否引入 SQLite。

**明确未覆盖**：ECharts tooltip 没有做鼠标悬停级交互断言——它是 canvas 坐标触发，坐标抖动会让验证本身变成噪声；现有改用「真实模板输出 → 浏览器 `innerHTML`」的确定性探针，并补了真实页面中的恶意标题文本显示。`App.poll()` 也没有独立组件单测框架；它由 live 的总览 503、抽屉首次失败、摘要条失败窗口与稳定态请求计数做浏览器级覆盖。性能优化前的原始基准 JSON 不可复现，已如实记录来源。

## 故障排查

先看启动日志，它一次打印数据源、监听地址、页面产物状态、已解析条数、已加载 / 总文件数与扫描间隔，多数问题在这一屏就能定位。

| 症状 | 原因与处理 |
| --- | --- |
| `npm start` 报「不是内部或外部命令」／脚本提示 `No usable node.exe found` | node 只在 WorkBuddy 会话临时注入的 PATH 里，不在你的用户 PATH。改用双击 `start-dashboard.bat`（显式绝对路径）；若连自动探测也失败，把脚本顶部 `NODE_EXE` 改成机器上真实的 `node.exe`。 |
| `start-dashboard.bat` 一闪而过、报「此时不应有 <<」之类 | 批处理被存成了 LF 换行；仓库用 `.gitattributes` 固定 `*.bat eol=crlf`，重新 `git checkout` 该文件即可。 |
| 页面空白、但 `/api/meta` 有数据 | 没执行 `npm run build`，启动日志会写「未找到 web/dist」。构建后重启 `npm start`。 |
| `Cannot find module @rollup/rollup-win32-x64-msvc` 或 `@esbuild/win32-x64` | npm workspace 漏装平台专用可选依赖：`npm i -D @rollup/rollup-win32-x64-msvc @esbuild/win32-x64`。两者已在根 `devDependencies`，换到 macOS / Linux 时删掉重新 `npm ci`。 |
| `Cannot find module 'token-dashboard-server'` | workspace 软链记录的是绝对路径，**移动过项目目录**。重新 `npm ci`（或 `npm install`）即可。 |
| `EADDRINUSE` | 端口被占：`PORT=5179 npm start`。注意 E2E、对账与 live 脚本默认连 5178，跑它们时要让服务回到默认端口。 |
| 启动后 0 条请求 / 0 个会话 | `WORKBUDDY_HOME` 没指向含 `projects/` 子目录的位置；核对日志「数据源」行。演示数据用 `npm run demo`。 |
| 数字不更新 | 每 5 秒增量扫描一次（`SCAN_INTERVAL_MS` 可调）；可点「重新扫描」强制重扫。页面切到后台会暂停轮询，切回自动补拍。 |
| 顶部出现「自动刷新未成功」提示 | 某一拍取数失败，保留的是上一拍数据；恢复后下一拍自动撤销，不需要刷新页面。 |
| 别的设备打不开 / 用 `localhost` 连不上 | 设计如此：只绑 `127.0.0.1`。本机 `localhost` 常优先解析成 `::1`，统一改用 `127.0.0.1`。确需扩大范围才动 `HOST` / `HOST_ALLOWLIST`。 |
| 跨域或自定义 Host 被拒 | Host 头白名单与 CORS 回环白名单生效；用 `HOST_ALLOWLIST` / `CORS_ORIGIN` 追加，别用 `CORS_ORIGIN=*`。 |
| 会话轮次或会话行「少了一截」 | 轮次接口只取最近 200 轮（界面会写「仅显示最近 N 轮」，汇总仍覆盖全部）；会话主列表超过 200 行会截断，点「显示更多／显示全部」。 |
| 构建提示 chunk > 500 kB | ECharts 打进单个 chunk，已知且不影响运行；后续可做 `manualChunks` 拆分。 |
| 昨天保存的筛选条件第二天不见了 | 「记住筛选」按当天有效设计，跨天自动回到默认「今天」。页面一直开着跨零点时会自动重算区间。 |
| 启动日志显示「已加载 31 / 177」、页面里历史项目 / 模型偏少 | 设计如此：只加载近 7 天，筛选栏有「已加载 N / M 个文件」交代。切一次「全部」或按日期筛到历史区间即补齐；想每次都全量用 `FORCE_FULL_LOAD=1 npm start`。 |
| 切「全部」第一次明显等一会儿 | 首次要补读历史文件（真实数据约 1.6s），期间有「正在读取历史数据」提示且**当前视图不清空**；之后常驻，不再等待。 |
| 启动日志写「索引不可用…回退全量」 | `server/.cache/file-index.json` 损坏、版本不符或刚换过 `WORKBUDDY_HOME`；本次自动全量加载并重建索引，只发生一次。也可 `npm run index:rebuild` 手动重建。 |
| 上下文曲线挤成一团、看着像多出一根深绿柱 | 点太密时堆叠分界线近乎垂直、半透明面积同列叠加所致，不是第三种数据。用底部滚动杆 / 滚轮放大局部（默认只铺前 100 点）。 |
| 10 万条数据下总览偶有卡顿 | 稳定态每拍只取 `/api/meta`；有写入时 `/api/overview` 单次约 113ms，属已知边界（见下节）。 |

## 已知限制与后续增强

**统计口径**

- 不递归归属子 Agent 的用量；统计范围与基底一致，扩展会单独说明。
- 「最近活跃」按本地日志最后写入时间判断，**不识别 WorkBuddy 前台窗口**；固定会话被删除或换数据源时给空态，需手动切回跟随。
- 耗时与吐字速度是从事件时间线推导的，不是日志里的实测字段；首字延迟（TTFT）拿不到，样本不足的模型会标低置信。
- 速度画像（`speedProfiles` / `defaultOverheadMs`）按「当前已加载记录」在每次 `rebuild()` 时重拟合，`summary.netMs / measuredSpeed / speedSamples` 与 `overview.speed` 会随切档或新记录渐进；业务 KPI 不受影响。

**性能**

- 少量追加仍需 O(N) 全量重算耗时推导、速度拟合与派生字段，10 万条约 55~65ms；稳定态已由 `revision` 跳过重取，实测占空比约 1.2%，当前保留。
- 每次扫描仍会 `stat` 所有 JSONL 文件；`/api/overview` 单次约 113ms（稳定态不再调用）。规模再上一个数量级时先提交实测依据，再决定是否引入 SQLite。
- 「加载过不卸载」：切到「全部」后内存常驻全量数据，两年后估约 2.8 GB（常规强度）/ 6.6 GB（极端强度）。本期只解决启动等待，不解决内存上限。
- 合成性能夹具无时间分布，冷启动按需加载的收益只在真实数据上可测；`perf:bench` 固定走全量路径以保持前后对照。

**展示与验证**

- 虚拟窗口因 sticky 表头有约 1 行系统性偏移（`OVERSCAN=6` 兜住，不露白）；`turnLimit` 尾部裁剪时保持滚动位置会看到行内容左移；卡片与列表行的「活跃」判定在 5 分钟边界可能差一帧。
- ECharts 的图表配色常量目前按亮色主题定义，暗色主题下坐标轴文字与网格线仍沿用亮色取值，对比度不如 CSS 部分；这是已知的视觉债，后续可改为读取 CSS 变量。
- ECharts tooltip 无鼠标悬停级交互断言，改用真实模板输出 + 浏览器 `innerHTML` 的确定性探针；优化前基准 JSON 已丢失，对照脚本明确标注数值来源为首次终端输出。
- 交付的是本地 Web 应用与 `web/dist` 构建产物，**不制作 exe**；`web/dist` 不入库，源码与文档已推送到[公开仓库](https://github.com/ShirasawaYui/workbuddy-token-dashboard)，未创建 Release。

后续增强项见[路线图](#路线图)，均不在本次交付范围内。

## 目录结构

```
web/dist/                    生产构建产物（npm run build 生成，不入库）
server/.cache/               增量扫描状态与文件索引（自动生成，不入库）
server/                     零三方依赖的解析服务
  src/config.js             数据源定位、端口、CORS / Host 白名单、冷热与回退开关
  src/parser.js             行 → 规范化用量记录 + 时间线事件
  src/scanner.js            发现 JSONL + 冷热三态 + 增量续读（记录与事件都增量累积）
  src/timing.js             耗时推导：请求耗时 / 工具配对 / 阶段分解 / 速度拟合
  src/store.js              内存存储 + 过滤 / 分组 / 分桶聚合 + revision
  src/file-index.js         极简文件索引（汇总量、临时文件 rename、损坏 / 换源回退）
  src/index.js              REST API + 静态托管 + 5s 自动重扫 + ensureLoaded
  test/incremental.test.js  增量解析单测 + 耗时推导单测
  test/active.test.js       最近活跃会话口径单测
  test/phase1.test.js       冷热三态 / 双边界 / 故障语义 / 索引 / 口径恒等单测
  test/perf-hardening.test.js 查询索引与 revision 的口径 / 行为单测
  test/reconcile.js         与独立全量解析对账（含耗时维度的独立复算）
web/                        Vue3 + Vite + ECharts
  src/App.vue               左侧导航栏 + 全宽工作台 + 双主题 + 轮询 / 状态提示
  src/style.css             暖砂亮色 / 深焙暗色双主题设计系统
  src/composables/          useChart（按需引入 + dataZoom + 重绘保留窗口）、
                            usePopup（弹层定位）、useFilterStorage（当天有效的筛选记忆）
  src/components/ui/        AppSelect、AppDatePicker（自绘控件）
  src/components/           KpiCard、FilterBar、PhaseBar / PhaseMiniBar、
                            SessionDrawer（会话抽屉）、TurnPanel（本轮卡片 + 轮次列表）、
                            ActiveSessionBar（最近活跃盯盘）、SortTag（时间排序 Tag）
  src/utils/                ranges（时间档位）、granularity（趋势粒度）、
                            sortOrder（明细排序换算）、turnView（轮次视图纯函数）、
                            tooltipHtml / escapeHtml / format
  src/views/                Overview / Sessions / Requests
  test/*.test.js            区间档位、粒度、排序换算、API、tooltip、轮次视图等纯函数单测
start-dashboard.bat          一键启动：显式指定 node 绝对路径、打印路径、自动开浏览器
scripts/demo.js             生成合成演示数据并启动（npm run demo）
scripts/live-demo.js        单会话持续追加的 live 夹具（npm run demo:live）
scripts/dev.js              一条命令同时起前后端
tools/e2e-verify.js         真实浏览器端到端验证（119 项）
tools/verify-live.mjs       live 追加 + 故障恢复 + tooltip 注入面验证
tools/verify-active.mjs     多会话交替追加 + 跟随 / 固定 + 无 credit 新会话
tools/verify-large-list.mjs 500 会话的真实 DOM 上限、显示更多 / 全部与分组折叠
tools/verify-final.mjs      边界、本地安全与敏感数据集成验证
tools/verify-phase1.mjs     冷启动 / 按需加载 / 索引 / 安全 / 前端提示服务链路验证
tools/index-rebuild.mjs     索引重建与校验 CLI（非 HTTP，不占端口）
tools/perf-bench.mjs        10 万请求级合成数据生成 + 冷启动 / API / 追加 / 内存基准
tools/perf-compare.mjs      性能前后对照（明确标注优化前基线来源）
tools/screenshots.js        重新生成 README 的 6 张截图（基于演示数据，含双主题）
docs/screenshots/           README 截图（合成数据，不含真实用量）
```

## 路线图

以下均**未**在本次交付实现；取舍依据见[已知限制与后续增强](#已知限制与后续增强)。

- **成本告警**：定时扫描，超过日 / 周 credit 阈值时通知；速度退化纳入同一套告警
- **落库**：把 `store.js` 的 upsert 换成 SQLite，支持跨月留存与复杂查询
- **提示词优化建议**：结合 `function_call_result` 的体积，找出「回灌给模型的工具输出过大」的调用
- **对比视图**：按模型横向对比「同样任务谁更省、谁更快」
- **把 prefill 一起建模**：加输入项会更准，但缓存字段高度共线，需要先中心化或改岭回归
- **首字延迟（TTFT）**：目前拿不到，需要平台侧埋点
- **暗色主题图表配色**：让 ECharts 也读取 CSS 变量，消除亮 / 暗切换后的色差

深色模式（双主题切换、偏好持久化）、冷启动按需加载与两处明细正 / 逆序切换均为已交付内容，不在此清单。

## 来源与二次开发

本项目基于 [selennac/workbuddy-token-dashboard](https://github.com/selennac/workbuddy-token-dashboard)（MIT，Copyright (c) 2026 阿比白熊）做二次开发，原 `LICENSE` 完整保留，本仓库同样以 MIT 开放。

在基底之上完成的工作包括：暖砂亮色 / 深焙暗色双主题与全宽工作台布局、耗时与轮次口径的一系列修正、10 万请求级性能加固、冷启动按近 7 天加载 + 切档按需补齐与脱敏索引、会话轮次与最近活跃视图、两处明细的时间正 / 逆序切换，以及相应的单元 / 端到端回归。上游仓库在 Git 中保留为 `upstream` remote，便于日后同步；本仓库作为独立版本维护，不是上游的补丁分支。

## 贡献

Issue / PR 都欢迎，仓库地址：https://github.com/ShirasawaYui/workbuddy-token-dashboard 。
提交前请跑一遍 `npm test` 与 `npm run test:e2e`；改了前端记得 `npm run build`，重截 README 截图用 `tools/screenshots.js`。

## License

[MIT](LICENSE) —— 含上游原作者的版权声明与许可声明。
