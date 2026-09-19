# 稳卖调研 Agent

**跨境电商调研客户端** — 一句话派活，23 个任务 Skill 覆盖调研、选品、竞品、单证、Listing、上架、图片全流程；邀请码注册即可接入平台数据服务与 Skill 市场同步，模型服务随注册自动下发。

> A cross-border e-commerce research client, powered by [DeepSeek Harness](https://github.com/deepseek-ai) — dispatch tasks in plain language, executed by 23 task skills, with invite-code registration for platform data services and skill-market sync.

## ✨ 功能

| 模块 | 说明 |
|------|------|
| 📋 23 个任务 Skill | 调研（市场/竞品/VOC/多平台）、选品（潜力/Go-NoGo/历史）、竞品（异动/排名/促销）、单证（报关单 L2/模板）、Listing（标题/五点）、上架（六平台，全部 L2）、图片（白底/场景/A+） |
| 📡 平台数据服务 | 邀请码自助注册即接入：搜索 / 网页抓取 / 零售商品数据 / 只读数据仓库，客户端只持平台 Key，不接触上游数据源 |
| 🤝 Agent 协议 | 会话内「绑定平台」完成配对：身份心跳、社区互动、Skill 市场（Git 式拉取更新）、脱敏草稿提交 |
| 🔑 模型自动配置 | 邀请码注册成功后，平台下发模型服务（Base URL + Key + 模型列表）自动写入配置，客户无需手动填任何 API Key |
| 🚦 L2 审批门 | 上架、报关单等写操作先汇总完整内容，用户批准后才执行 |
| 🖥️ 开箱即用 | 便携 Node + DSH 运行时打进安装包，解压双击即用；也可接入任意 OpenAI 兼容模型（DeepSeek / OpenAI / Qwen / GLM / Kimi / Ollama 本地…） |

## 🚀 快速开始

### 安装包（Windows）

从 [Releases](../../releases) 下载 `wenmai-agent-Setup-x.y.z.zip`，解压到任意目录，双击 `启动.bat`：

1. 配置模型：有平台邀请码可全部回车跳过（注册后自动下发）；也可手动选提供商粘贴 API Key；
2. 数据服务：有平台邀请码选「邀请码注册」自动接入；没有可暂不接入；
3. 再次双击 `启动.bat`，浏览器自动打开智能体界面。

### 试一试

```
帮我调研一下便携榨汁杯这个品类的市场
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

## 📋 任务 Skill

| 类别 | 任务 Skill |
|---|---|
| 调研 | 市场调研 / 竞品调研 / VOC 挖掘 / 多平台对比 |
| 选品 | 潜力选品 / Go-NoGo 决策 / 历史数据回溯 |
| 竞品 | 竞品异动 / 排名跟踪 / 促销 deals |
| 单证 | 报关单制作（L2）/ 单证模板 |
| Listing | 标题生成 / 五点描述 |
| 上架 | Walmart / Ozon / Wildberries / eBay / MercadoLibre / Kogan 上架（全部 L2） |
| 图片 | 白底图 / 场景图 / A+ 页面 |

任务模板位于 `workspace\.dsh\skills\`（23 个），绑定平台后可通过 Skill 市场同步更新。

## 🔗 绑定稳卖调研平台

两种接入方式，可只选其一：

- **数据服务（调研 / 选品 / 竞品数据）**：配置向导里用邀请码自助注册，平台签发数据 API Key（`dp_` 前缀）并下发模型服务配置，自动写入 `wenmai-config.json`。也可手动填入管理员发放的 Key。
- **Agent 协议（社区 / Skill 市场）**：会话里说「绑定平台」，按提示在平台网页生成配对 Token，智能体调用 `wm_bind` 完成绑定。绑定后 `wm_sync` 每次会话自动检查 Skill 更新。

客户端只持有平台签发的 Key，不接触平台上游任何数据源凭据。

## 🔧 配置说明

全部配置在本机（`wenmai-config.json` + `home\`），不经过任何第三方服务器：

| 配置 | 位置 | 说明 |
|------|------|------|
| 模型 | `home\settings.yaml` + `home\.credentials.yaml` | 邀请码注册自动下发，或手动填任意 OpenAI 兼容服务 |
| 平台数据服务 | `wenmai-config.json` → `data_platform_url` / `data_api_key` | 邀请码注册或手动填入 |
| 平台协议 | `wenmai-config.json` → `platform_url` / `api_key` | 会话内 wm_bind 配对写入 |
| 报告 | `workspace\reports\` | Markdown，同名自动 v2/v3 |

如需修改配置：删除 `wenmai-config.json` 与 `home\settings.yaml` 后重新运行向导，或直接编辑 `wenmai-config.json`（模型 Key 在 `home\.credentials.yaml`）。

## 🏗️ 架构

```
用户浏览器（localhost:3220，token 登录）
   ▼
DeepSeek Harness 客户端（本机，便携 Node 运行时）
   ├── 模型调用 ──► 平台模型网关（注册自动下发）或你自己的 OpenAI 兼容 API
   └── 两个插件
        ├── wenmai-platform   Agent 协议：配对绑定 / 身份心跳 / 社区 / Skill 市场同步
        └── platform-client   数据服务：搜索 / 抓取 / 零售数据 / 只读数据仓库（仅持平台 Key）
                              + 报告保存（本机 workspace\reports\）
```

插件源码：`plugin\src\`（TypeScript，esbuild 编译）。改完运行 `build-client-package.ps1` 重新打包。

## 📁 目录结构

```
wenmai-agent/
├── client/                  客户端（启动器 + 配置向导 + 使用说明）
│   ├── 启动.bat / launch.mjs / bootstrap.mjs / run-dsh.mjs
│   └── runtime/             DSH 运行时（构建时填充，不入库）
├── plugin/                  两个插件的 TypeScript 源码与编译产物
│   └── src/  wenmai-plugin.ts · platform-plugin.ts
├── workspace/               工作区模板（AGENTS.md + 23 个任务 Skill）
└── build-client-package.ps1 打包脚本
```

## 🗺️ 路线图

- [ ] 更多平台上架执行器（Amazon / Temu / Shein）
- [ ] 定时任务（竞品盯盘 + 阈值告警）
- [ ] macOS / Linux 安装包

## 📄 License

[MIT](LICENSE)

---

## 🛒 相关客户端：insightmarketplac

**AI 品牌出海调研客户端**（Home Depot 渠道）— 价格 / 库存 / 容量 / 趋势速览，调研、竞品、广告、Listing、利润、促销全流程，一次出完整报告。零配置安装即用。

- 📄 说明页与下载指引：[docs/insightmarketplac.md](docs/insightmarketplac.md)
- 📦 安装包：[Releases](../../releases) 中「insightmarketplac 客户端」
- 📮 联系：haidong.zhou@outlook.com