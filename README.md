# 稳卖调研 Agent

**跨境电商数字员工团队客户端** — 一句话派活，8 个数字员工（市场调研 / 选品 / 竞品监控 / 广告优化 / 打单 / Listing / 上架 / 图片设计）按 27 个任务 Skill 执行，覆盖调研 → 选品 → 投放 → 上架全流程；可绑定「稳卖调研」平台接入数据服务与 Skill 市场同步。

> A cross-border e-commerce digital-employee team, powered by [DeepSeek Harness](https://github.com/deepseek-ai) — dispatch tasks in plain language to 8 persona agents backed by 27 task skills, with optional platform pairing for data services and skill-market sync.

## ✨ 功能

| 模块 | 说明 |
|------|------|
| 🧑‍💼 数字员工路由 | 8 个员工人设 + 任务 Skill 匹配表（AGENTS.md），多员工任务自动拆分依序执行 |
| 📋 27 个任务 Skill | 调研（市场/竞品/VOC/多平台）、选品（潜力/Go-NoGo/历史）、竞品（异动/排名/促销）、广告（间谍/选词/盈亏/路线图）、单证（报关单 L2/模板）、Listing（标题/五点）、上架（六平台，全部 L2）、图片（白底/场景/A+） |
| 📡 平台数据服务 | 邀请码自助注册即接入：搜索 / 网页抓取 / 零售商品数据 / 只读数据仓库，客户端只持平台 Key，不接触上游数据源 |
| 🤝 Agent 协议 | 会话内「绑定平台」完成配对：身份心跳、社区互动、Skill 市场（Git 式拉取更新）、脱敏草稿提交 |
| 📊 Walmart 广告管理 | Campaign 创建 / 预算 / 出价策略 / 关键词 / 期间报表（CTR / CPC / CVR / ROAS / ACOS），Sponsored Products / Brands / Videos |
| 📡 Reddit 情报 | 品类痛点（10 类）+ 购买信号（9 类）规则引擎，输出广告选词 / 文案角度 / 否定词建议 |
| 🚦 L2 审批门 | 上架、报关单、预算调整等写操作先汇总完整内容，用户批准后才执行 |
| 🧪 演示模式 | 未配置 Walmart API 也能完整体验广告管理（内置模拟账户，写操作持久保存） |
| 🖥️ 开箱即用 | 便携 Node + DSH 运行时打进安装包，解压双击即用；任意 OpenAI 兼容模型（DeepSeek / OpenAI / Qwen / GLM / Kimi / Ollama 本地…） |

## 🚀 快速开始

### 安装包（Windows）

从 [Releases](../../releases) 下载 `wenmai-agent-Setup-x.y.z.zip`，解压到任意目录，双击 `启动.bat`：

1. 配置模型：选提供商 → 粘贴 API Key（[DeepSeek](https://platform.deepseek.com) 推荐）；
2. 数据服务：有平台邀请码选「邀请码注册」自动接入；没有可暂不接入；
3. 平台协议：回车用默认地址，稍后在会话里说「绑定平台」完成配对；
4. Walmart Connect：选「演示模式」先体验，或填 API 凭证直连真实账户；
5. 再次双击 `启动.bat`，浏览器自动打开智能体界面。

### 试一试（演示模式开箱即用）

```
帮我调研一下便携榨汁杯这个品类的市场
cordless vacuum 在 Reddit 上有什么用户痛点
把 SP-Cordless-Vacuum-Q4 的日预算调到 80
给这个产品写一套 Walmart Listing 标题和五点
上架到 Ozon（L2 审批：先看完整内容，批准后执行）
```

### 从源码构建

```bash
git clone https://github.com/Hdhaidong/wenmai-agent.git
cd wenmai-agent
# 需要本机 Node.js ≥ 22；DSH 运行时见 client/runtime/dsh（npm i @deepseek-ai/dsh）
powershell -NoProfile -ExecutionPolicy Bypass -File build-client-package.ps1
```

## 🧑‍💼 数字员工与任务 Skill

| 员工 | 任务 Skill |
|---|---|
| 市场调研员 | 市场调研 / 竞品调研 / VOC 挖掘 / 多平台对比 |
| 选品分析师 | 潜力选品 / Go-NoGo 决策 / 历史数据回溯 |
| 竞品监控哨兵 | 竞品异动 / 排名跟踪 / 促销 deals |
| 广告优化师 | 广告间谍 / 关键词选词 / 盈亏分析 / 投放路线图 |
| 打单专员 | 报关单制作（L2）/ 单证模板 |
| Listing 工程师 | 标题生成 / 五点描述 |
| 上架专员 | Walmart / Ozon / Wildberries / eBay / MercadoLibre / Kogan 上架（全部 L2） |
| 图片设计师 | 白底图 / 场景图 / A+ 页面 |

任务模板位于 `workspace\.dsh\skills\`（27 个），绑定平台后可通过 Skill 市场同步更新。

## 🔗 绑定稳卖调研平台

两种接入方式，可只选其一：

- **数据服务（调研 / 选品 / 竞品数据）**：配置向导里用邀请码自助注册，平台签发数据 API Key（`dp_` 前缀），自动写入 `wenmai-config.json`。也可手动填入管理员发放的 Key。
- **Agent 协议（社区 / Skill 市场）**：会话里说「绑定平台」，按提示在平台网页生成配对 Token，智能体调用 `wm_bind` 完成绑定。绑定后 `wm_sync` 每次会话自动检查 Skill 更新。

客户端只持有平台签发的 Key，不接触平台上游任何数据源凭据。

## 🔑 直连真实 Walmart Connect 账户

演示模式适合体验与流程验证。接入真实广告账户：

1. 编辑 `wenmai-config.json`，把 `walmart.mode` 改为 `live`；
2. 填入凭证（来自 [developer.walmart.com/generateKey](https://developer.walmart.com/generateKey) 或 WCPN 合作伙伴入驻）：

```json
{
  "walmart": {
    "mode": "live",
    "client_id": "…",
    "client_secret": "…",
    "consumer_id": "…",
    "key_version": "1",
    "private_key": "-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----",
    "advertiser_id": "…"
  }
}
```

> 私钥也可用 `private_key_file` 指向 PEM 文件路径。Walmart Connect Ads API 的完整能力与准入要求见[官方文档](https://developer.walmart.com/advertising-partners-search/docs/overview)。

## 🔧 配置说明

全部配置在本机（`wenmai-config.json` + `home\`），不经过任何第三方服务器：

| 配置 | 位置 | 说明 |
|------|------|------|
| 模型 | `home\settings.yaml` + `home\.credentials.yaml` | 任意 OpenAI 兼容服务 |
| 平台数据服务 | `wenmai-config.json` → `data_platform_url` / `data_api_key` | 邀请码注册或手动填入 |
| 平台协议 | `wenmai-config.json` → `platform_url` / `api_key` | 会话内 wm_bind 配对写入 |
| Walmart | `wenmai-config.json` → `walmart` | 演示 / 直连模式与凭证 |
| Reddit | `wenmai-config.json` → `reddit` | 匿名（默认）/ 脚本应用凭证 |
| 报告 | `workspace\reports\` | Markdown，同名自动 v2/v3 |
| 演示账户状态 | `mock-walmart-state.json` | 演示模式的写操作持久化 |

Reddit 更稳的采集：到 [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) 创建 **script** 类型应用，把 client_id / secret / 用户名 / 密码填入 `reddit` 段。

## 🏗️ 架构

```
用户浏览器（localhost:3220，token 登录）
   ▼
DeepSeek Harness 客户端（本机，便携 Node 运行时）
   ├── 模型调用 ──► 你自己的 OpenAI 兼容 API（Key 只在本机）
   └── 三个插件
        ├── wenmai-platform   Agent 协议：配对绑定 / 身份心跳 / 社区 / Skill 市场同步
        ├── platform-client   数据服务：搜索 / 抓取 / 零售数据 / 只读数据仓库（仅持平台 Key）
        └── walmart-ads       wc_* 广告工具（演示引擎 或 Walmart Connect API 直连）
                              + reddit_insights（Reddit 痛点 / 购买信号）
                              + 报告保存（本机 workspace\reports\）
```

插件源码：`plugin\src\`（TypeScript，esbuild 编译）。改完运行 `build-client-package.ps1` 重新打包。

## 📁 目录结构

```
wenmai-agent/
├── client/                  客户端（启动器 + 配置向导 + 使用说明）
│   ├── 启动.bat / launch.mjs / bootstrap.mjs / run-dsh.mjs
│   └── runtime/             DSH 运行时（构建时填充，不入库）
├── plugin/                  三个插件的 TypeScript 源码与编译产物
│   └── src/  wenmai-plugin.ts · platform-plugin.ts · walmart-plugin.ts
├── workspace/               工作区模板（AGENTS.md 员工路由 + 27 个任务 Skill）
└── build-client-package.ps1 打包脚本
```

## 🗺️ 路线图

- [ ] Sponsored Display 支持（官方 API 开放后）
- [ ] 更多平台上架执行器（Amazon / Temu / Shein）
- [ ] 定时任务（竞品盯盘 + 阈值告警）
- [ ] macOS / Linux 安装包

## 📄 License

[MIT](LICENSE) — Reddit 情报规则引擎移植自 [reddit-radar-workbench](https://github.com/Hdhaidong/reddit-radar-workbench)（同为 MIT）。
