#!/usr/bin/env node
// launch.mjs — wenmai 客户端总入口：无配置进向导，有配置启动 DSH
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(ROOT, 'wenmai-config.json')

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
  } catch {
    return null
  }
}

let config = await readConfig()

if (!config) {
  console.log('未检测到配置，进入首次配置向导。')
  console.log('')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bootstrap.mjs')], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  config = await readConfig()
  if (!config) process.exit(1)
}

process.env.DSH_HOME = path.join(ROOT, 'home')
process.env.DSH_PORT = process.env.DSH_PORT || '3220'
process.env.ADS_REPORTS_DIR = path.join(ROOT, 'workspace', 'reports')
process.env.RESEARCH_REPORTS_DIR = path.join(ROOT, 'workspace', 'reports')
process.env.WENMAI_CONFIG = CONFIG_FILE
process.env.WALMART_AGENT_CONFIG = CONFIG_FILE
const dataUrl = config.data_platform_url || config.platform_url
if (dataUrl) {
  process.env.DATA_PLATFORM_URL = dataUrl
  if (config.data_api_key) {
    process.env.DATA_PLATFORM_KEY = config.data_api_key
    process.env.DATA_PLATFORM_WAREHOUSE = '1'
  }
}

console.log(`[agent] 平台协议: ${config.api_key ? '已绑定 insightmarketplac' : '未绑定（会话内可用 wm_bind 绑定）'}`)
console.log(`[agent] 数据服务: ${config.data_api_key ? `已接入（${dataUrl}）` : '未接入（调研类 Skill 将提示数据源未连接）'}`)
console.log(`[agent] Walmart Connect: ${config.walmart?.mode === 'live' ? '直连模式' : '演示模式'}`)

await import('./run-dsh.mjs')
