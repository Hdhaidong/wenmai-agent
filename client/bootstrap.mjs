#!/usr/bin/env node
// bootstrap.mjs — wenmai agent 首次配置向导（本地独立，无平台依赖）
// 流程：模型配置（必填）→ 数据平台接入（可选，邀请码注册/手动 Key）→ 平台协议地址 → Walmart Connect（演示/直连）→ 写入配置
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { writeFile, mkdir, access, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(ROOT, 'wenmai-config.json')
const DEFAULT_PLATFORM_URL = 'https://api.insightmarketplac.com'

const rl = readline.createInterface({ input: stdin, output: stdout })
const ask = async (q, def = '') => {
  const a = (await rl.question(q)).trim()
  return a || def
}

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

console.log('')
console.log('==========================================')
console.log('  稳卖调研 Agent · 首次配置向导')
console.log('==========================================')
console.log('')

// ---- [1/4] 模型配置（必填）----
console.log('[1/4] 模型配置（任意 OpenAI 兼容服务）')
const provider = await ask('  选择提供商：1 DeepSeek（推荐）  2 OpenAI  3 其他兼容服务 [1]: ', '1')
let baseURL = 'https://api.deepseek.com/v1'
let providerName = 'DeepSeek'
if (provider === '2') { baseURL = 'https://api.openai.com/v1'; providerName = 'OpenAI' }
if (provider === '3') {
  baseURL = await ask('  Base URL（形如 https://api.xxx.com/v1）: ')
  providerName = '自定义'
  while (!/^https?:\/\/.+/.test(baseURL)) {
    baseURL = await ask('  格式不正确，请以 http:// 或 https:// 开头重新输入: ')
  }
}
const apiKey = await ask(`  ${providerName} API Key（sk- 开头）: `)
while (!apiKey || apiKey.length < 8) {
  console.log('  API Key 不能为空。')
  apiKey = await ask(`  ${providerName} API Key: `)
}
let models
if (provider === '1') {
  models = [
    { id: 'deepseek-chat', name: '标准模型' },
    { id: 'deepseek-reasoner', name: '深度推理模型' },
  ]
} else {
  const modelId = await ask('  模型名（如 gpt-4o-mini / qwen-plus）: ', 'gpt-4o-mini')
  models = [{ id: modelId, name: modelId }]
}

// ---- [2/4] 数据平台接入（可选）----
console.log('')
console.log('[2/4] 稳卖调研平台 · 数据服务（调研 / 选品 / 竞品数据）')
console.log('  不接入也能用（广告演示模式 + Reddit 情报），但调研类 Skill 会提示数据源未连接。')
const dpMode = await ask('  选择：1 邀请码注册（推荐）  2 手动填 API Key  3 暂不接入 [1]: ', '1')

let platformUrl = DEFAULT_PLATFORM_URL
let dataApiKey = ''
if (dpMode !== '3') {
  platformUrl = await ask(`  平台地址 [${DEFAULT_PLATFORM_URL}]: `, DEFAULT_PLATFORM_URL)
  while (!/^https?:\/\/.+/.test(platformUrl)) {
    platformUrl = await ask('  格式不正确，请以 http:// 或 https:// 开头重新输入: ', DEFAULT_PLATFORM_URL)
  }
  if (dpMode === '1') {
    let account = await ask('  账户名（2-32 位字母数字）：')
    while (!/^[A-Za-z0-9_-]{2,32}$/.test(account)) {
      account = await ask('  账户名需为 2-32 位字母、数字、下划线或连字符，重新输入：')
    }
    let inviteCode = await ask('  邀请码：')
    while (!inviteCode) {
      inviteCode = await ask('  邀请码不能为空：')
    }
    console.log('  注册中...')
    try {
      const res = await fetch(`${platformUrl.replace(/\/+$/, '')}/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: account, invite_code: inviteCode }),
        signal: AbortSignal.timeout(30_000),
      })
      const payload = await res.json()
      if (!res.ok || !payload.success) {
        throw new Error(payload?.error?.message || `HTTP ${res.status}`)
      }
      dataApiKey = payload.data.key
      console.log(`  注册成功：${payload.data.name}（权限：${(payload.data.scopes || []).join(', ')}）`)
    } catch (e) {
      console.log(`  注册失败：${e instanceof Error ? e.message : String(e)}`)
      const manual = await ask('  改为手动填入 API Key（dp_ 开头，直接回车跳过接入）：')
      if (/^dp_[A-Za-z0-9]{16,}$/.test(manual.trim())) dataApiKey = manual.trim()
    }
  } else {
    const manual = await ask('  API Key（dp_ 开头）：')
    while (manual && !/^dp_[A-Za-z0-9]{16,}$/.test(manual)) {
      manual = await ask('  格式不正确（应为 dp_ 开头），重新输入（直接回车跳过接入）：')
    }
    if (manual) dataApiKey = manual
  }
}

// ---- [3/4] 平台协议（Agent Protocol）----
console.log('')
console.log('[3/4] 稳卖调研平台 · Agent 协议（社区 / Skill 市场）')
console.log('  会话里说「绑定平台」用配对 Token 完成绑定即可，这里只需确认地址。')
const protoUrl = await ask(`  协议地址 [${platformUrl}]: `, platformUrl)

// ---- [4/4] Walmart Connect ----
console.log('')
console.log('[4/4] Walmart Connect 广告数据')
console.log('  未接入 Walmart Connect API 也能用：内置演示模式（模拟账户跑通全部功能）。')
const wmMode = await ask('  选择：1 演示模式（推荐先体验）  2 直连模式（需 API 凭证）[1]: ', '1')

const walmart = { mode: 'mock' }
if (wmMode === '2') {
  walmart.mode = 'live'
  walmart.client_id = await ask('  Client ID: ')
  walmart.client_secret = await ask('  Client Secret: ')
  walmart.consumer_id = await ask('  Consumer ID: ')
  walmart.key_version = await ask('  Key Version [1]: ', '1')
  const pk = await ask('  私钥（一行粘贴，换行用 \\n 表示；或稍后在 wenmai-config.json 里填 private_key_file 指向 PEM 文件）: ')
  if (pk) walmart.private_key = pk
  walmart.advertiser_id = await ask('  Advertiser ID（广告主 ID）: ')
  console.log('  已保存直连配置。首次调用若鉴权失败，请核对 consumer_id / 私钥 / key_version。')
}
rl.close()

// ---- 写入配置 ----
console.log('')
console.log('保存配置...')

const config = {
  created_at: new Date().toISOString(),
  platform_url: protoUrl,
  ...(dpMode !== '3' ? { data_platform_url: platformUrl } : {}),
  ...(dataApiKey ? { data_api_key: dataApiKey } : {}),
  model: { provider: providerName, base_url: baseURL, models },
  walmart,
}
await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8')

const homeDir = path.join(ROOT, 'home')
await mkdir(path.join(homeDir, 'storages'), { recursive: true })

await writeFile(
  path.join(homeDir, '.credentials.yaml'),
  ['version: 1', 'refs:', `  MODEL_API_KEY: ${apiKey}`, ''].join('\n'),
  'utf8',
)

const modelsYaml = models.map((m) => `        - id: ${m.id}\n          name: ${m.name}`).join('\n')
await writeFile(
  path.join(homeDir, 'settings.yaml'),
  [
    'llm-pi-ai:',
    '  providers:',
    '    custom:',
    '      apiKeyEnv: MODEL_API_KEY',
    `      displayName: ${providerName} 模型服务`,
    '      api: openai-completions',
    `      baseURL: ${baseURL}`,
    '      models:',
    modelsYaml,
    '',
  ].join('\n'),
  'utf8',
)

const wsRegistry = path.join(homeDir, 'storages', 'workspace.json')
if (!(await exists(wsRegistry))) {
  const wsDir = await realpath(path.join(ROOT, 'workspace'))
  const id = randomUUID()
  const now = new Date().toISOString()
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
    tables: { workspaces: { [id]: { path: wsDir, title: '稳卖调研', sessionIds: [], createdAt: now, updatedAt: now } } },
  }
  await writeFile(wsRegistry, JSON.stringify(doc, null, 2) + '\n', 'utf8')
}

console.log('配置完成（wenmai-config.json + home/）。')
console.log('')
console.log('==========================================')
console.log('  下一步：双击「启动.bat」打开智能体。')
console.log('  首次启动约需 1 分钟初始化，之后自动打开浏览器。')
console.log('  会话里说「绑定平台」即可完成稳卖调研平台配对。')
console.log('==========================================')
console.log('')
console.log('如需修改配置：删除 wenmai-config.json 与 home\\settings.yaml 后重新运行本向导，')
console.log('或直接编辑 wenmai-config.json（模型 Key 在 home\\.credentials.yaml）。')
