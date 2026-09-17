// walmart-ads-plugin — Walmart Connect 广告管理 + Reddit 情报（DeepSeek Harness 客户端插件）
// 双模式：未配置 Walmart 凭证时自动进入演示模式（本地模拟数据，写操作持久化），
// 配置后走 Walmart Connect Ads API（developer.api.walmart.com 网关，token + RSA 签名）。
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'

export const name = 'walmart-ads'
export const inject = ['tools', 'systemPrompt']

const CONFIG_FILE = process.env.WALMART_AGENT_CONFIG || path.join(process.cwd(), 'client-config.json')
const STATE_FILE = path.join(path.dirname(CONFIG_FILE), 'mock-walmart-state.json')

// ── 配置 ─────────────────────────────────────────────
interface WalmartConfig {
  mode?: 'mock' | 'live'
  client_id?: string
  client_secret?: string
  consumer_id?: string
  key_version?: string
  private_key?: string
  private_key_file?: string
  advertiser_id?: string
}
interface RedditConfig {
  client_id?: string
  client_secret?: string
  username?: string
  password?: string
}
interface AgentConfig {
  walmart?: WalmartConfig
  reddit?: RedditConfig
}

function loadConfig(): AgentConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as AgentConfig
  } catch {
    return {} // 未配置：Reddit 走匿名、Walmart 走演示模式
  }
}
const agentConfig = loadConfig()

const WM = agentConfig.walmart ?? {}
const REDDIT = agentConfig.reddit ?? {}
const LIVE = WM.mode === 'live' && Boolean(WM.client_id && WM.client_secret && WM.consumer_id && (WM.private_key || WM.private_key_file))

// ── Walmart 直连客户端（developer.api.walmart.com 网关）──
const WM_BASE = 'https://developer.api.walmart.com/api-proxy/service/WPA/Api/v1'
const WM_TOKEN_URL = 'https://developer.api.walmart.com/api/v1/token'

let cachedToken: { token: string; expiresAt: number } | null = null

async function getWmToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token
  const basic = Buffer.from(`${WM.client_id}:${WM.client_secret}`).toString('base64')
  const res = await fetch(WM_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Walmart token 获取失败（HTTP ${res.status}）。请检查 client_id / client_secret。`)
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Walmart token 响应缺少 access_token。')
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 900) - 60) * 1000 }
  return cachedToken.token
}

async function loadPrivateKey(): Promise<string> {
  if (WM.private_key_file) {
    const pem = await readFile(WM.private_key_file!, 'utf8')
    return pem.trim()
  }
  return (WM.private_key || '').replace(/\\n/g, '\n').trim()
}

// Walmart 网关签名：Base64(RSA-SHA256(consumerId \n url \n method \n timestamp \n))
async function signRequest(method: string, url: string, timestamp: string): Promise<string> {
  const pem = await loadPrivateKey()
  const payload = `${WM.consumer_id}\n${url}\n${method}\n${timestamp}\n`
  return crypto.createSign('RSA-SHA256').update(payload).sign(pem).toString('base64')
}

async function wmApi<T>(
  method: 'GET' | 'POST' | 'PUT',
  apiPath: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  const token = await getWmToken()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const url = `${WM_BASE}${apiPath}`
  const signature = await signRequest(method, url, timestamp)
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'WM_CONSUMER.ID': WM.consumer_id!,
        'WM_SEC.AUTH_SIGNATURE': signature,
        'WM_SEC.KEY_VERSION': WM.key_version || '1',
        'WM_CONSUMER.intimestamp': timestamp,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(`Walmart API 网络请求失败：${e instanceof Error ? e.message : '网络错误'}`)
  }
  if (res.status === 401) { cachedToken = null; throw new Error('Walmart API 鉴权失败（401）。请核对 consumer_id / private_key / key_version。') }
  if (res.status === 429) throw new Error('Walmart API 限流（429），请稍后重试。变更类操作按小时配额计费，请控制调用频率。')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Walmart API HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

// ── 演示模式（本地模拟引擎，状态持久化）──────────────
interface MockCampaign {
  campaignId: string
  name: string
  campaignType: 'sponsoredProducts' | 'sba' | 'video'
  targetingType: 'manual' | 'auto'
  status: string
  budgetType: 'daily' | 'both'
  dailyBudget: number
  totalBudget?: number
  startDate: string
  endDate: string
  biddingStrategy: { strategy: 'DYNAMIC' | 'FIXED' }
  advertiserId: string
  createdAt: string
}
interface MockKeyword {
  keywordId: string
  campaignId: string
  term: string
  matchType: 'exact' | 'phrase' | 'broad'
  bid: number
  state: 'enabled' | 'paused'
}
interface MockState {
  campaigns: MockCampaign[]
  keywords: MockKeyword[]
}

function seedState(): MockState {
  const today = new Date().toISOString().slice(0, 10)
  const adv = WM.advertiser_id || 'demo-advertiser-001'
  const campaigns: MockCampaign[] = [
    { campaignId: '1000001', name: 'SP-Cordless-Vacuum-Q4', campaignType: 'sponsoredProducts', targetingType: 'manual', status: 'enabled', budgetType: 'daily', dailyBudget: 50, startDate: today, endDate: '9999-12-30', biddingStrategy: { strategy: 'DYNAMIC' }, advertiserId: adv, createdAt: today },
    { campaignId: '1000002', name: 'SP-Kitchen-Storage-AlwaysOn', campaignType: 'sponsoredProducts', targetingType: 'auto', status: 'enabled', budgetType: 'daily', dailyBudget: 25, startDate: today, endDate: '9999-12-30', biddingStrategy: { strategy: 'FIXED' }, advertiserId: adv, createdAt: today },
    { campaignId: '1000003', name: 'SBA-Brand-Defense', campaignType: 'sba', targetingType: 'manual', status: 'paused', budgetType: 'daily', dailyBudget: 100, startDate: today, endDate: '9999-12-30', biddingStrategy: { strategy: 'FIXED' }, advertiserId: adv, createdAt: today },
    { campaignId: '1000004', name: 'VIDEO-Spring-Launch', campaignType: 'video', targetingType: 'manual', status: 'scheduled', budgetType: 'both', dailyBudget: 80, totalBudget: 3000, startDate: today, endDate: '9999-12-30', biddingStrategy: { strategy: 'FIXED' }, advertiserId: adv, createdAt: today },
  ]
  const keywords: MockKeyword[] = [
    { keywordId: '2000001', campaignId: '1000001', term: 'cordless vacuum for pet hair', matchType: 'exact', bid: 0.85, state: 'enabled' },
    { keywordId: '2000002', campaignId: '1000001', term: 'lightweight stick vacuum', matchType: 'phrase', bid: 0.62, state: 'enabled' },
    { keywordId: '2000003', campaignId: '1000001', term: 'cordless vacuum', matchType: 'broad', bid: 0.45, state: 'paused' },
    { keywordId: '2000004', campaignId: '1000003', term: 'shelf brand store', matchType: 'exact', bid: 1.20, state: 'enabled' },
  ]
  return { campaigns, keywords }
}

async function loadState(): Promise<MockState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as MockState
  } catch {
    const s = seedState()
    await saveState(s)
    return s
  }
}
async function saveState(s: MockState) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
}

// 演示数据按 campaignId+日期做稳定哈希，同一天内数字一致
function seededNum(seed: string, min: number, max: number): number {
  const h = crypto.createHash('md5').update(seed).digest()
  const v = h.readUInt32BE(0) / 0xffffffff
  return Math.round(min + v * (max - min))
}

function mockDailyMetrics(c: MockCampaign, d: string) {
  const live = c.status === 'enabled' || c.status === 'scheduled'
  if (!live) return { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0 }
  const impressions = seededNum(`${c.campaignId}${d}imp`, 400, 9000)
  const clicks = Math.round(impressions * (0.3 + seededNum(`${c.campaignId}${d}ctr`, 0, 70) / 1000))
  const cpc = 0.3 + seededNum(`${c.campaignId}${d}cpc`, 0, 90) / 100
  const spend = Math.min(c.dailyBudget, +(clicks * cpc).toFixed(2))
  const orders = Math.round(clicks * (0.5 + seededNum(`${c.campaignId}${d}cvr`, 0, 40) / 100))
  const sales = +(orders * (18 + seededNum(`${c.campaignId}${d}aov`, 0, 60))).toFixed(2)
  return { impressions, clicks, spend, orders, sales }
}

function dateRange(days: number): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// ── Reddit 情报引擎（规则引擎移植自 reddit-radar-workbench）──
const PAIN_RULES = [
  { re: /\b(struggling with|struggle to)\b/i, w: 3, tag: 'struggle' },
  { re: /\b(frustrat\w+|frustration)\b/i, w: 3, tag: 'frustration' },
  { re: /\b(hate|can't stand|fed up)\b/i, w: 3, tag: 'anger' },
  { re: /\b(worst|terrible|horrible|awful)\b/i, w: 2, tag: 'negative' },
  { re: /\b(why (is|does|do|are)|how come)\b/i, w: 1, tag: 'question' },
  { re: /\b(anyone else (have|experienc\w+)|same (issue|problem))\b/i, w: 2, tag: 'shared-pain' },
  { re: /\b(problem|issue|pain point) with\b/i, w: 2, tag: 'problem' },
  { re: /\b(not working|broke\w*|crash\w*|fail\w*)\b/i, w: 2, tag: 'defect' },
  { re: /\b(wasted? (money|time)|lost money|burned)\b/i, w: 3, tag: 'loss' },
  { re: /\b(overwhelm\w+|burnout|stressed)\b/i, w: 2, tag: 'burnout' },
]
const SIGNAL_RULES = [
  { re: /\b(looking for|searching for|in the market for)\b/i, w: 3, tag: 'active-search' },
  { re: /\b(can anyone recommend|any recommendations?|which (tool|app|service|platform|brand|product))\b/i, w: 3, tag: 'ask-reco' },
  { re: /\b(need (a|an) (tool|app|solution|service|alternative|vacuum|cleaner))\b/i, w: 3, tag: 'need' },
  { re: /\b(alternative to|instead of|switch(ing)? from)\b/i, w: 2, tag: 'switch-intent' },
  { re: /\b(worth (it|buying|paying)|should i (buy|get|pay))\b/i, w: 2, tag: 'evaluating' },
  { re: /\b(budget (of|is|around)|willing to pay|how much (does|would))\b/i, w: 3, tag: 'budget' },
  { re: /\b(thinking (of|about) (buying|getting|trying))\b/i, w: 2, tag: 'considering' },
  { re: /\b(where (to|can i) (buy|get|find))\b/i, w: 2, tag: 'where-to-buy' },
  { re: /\b(trial|demo|free tier|pricing|deal|discount)\b/i, w: 1, tag: 'pricing-interest' },
]

function scoreText(text: string, rules: typeof PAIN_RULES) {
  let score = 0
  const tags: string[] = []
  for (const r of rules) if (r.re.test(text)) { score += r.w; tags.push(r.tag) }
  return { score, tags }
}

const REDDIT_UA = 'walmart-ads-agent/1.0 (research)'

let redditTokenCache: { token: string; expiresAt: number } | null = null

async function getRedditToken(): Promise<string | null> {
  if (!REDDIT.client_id || !REDDIT.client_secret || !REDDIT.username || !REDDIT.password) return null
  if (redditTokenCache && Date.now() < redditTokenCache.expiresAt) return redditTokenCache.token
  const basic = Buffer.from(`${REDDIT.client_id}:${REDDIT.client_secret}`).toString('base64')
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': REDDIT_UA },
    body: `grant_type=password&username=${encodeURIComponent(REDDIT.username!)}&password=${encodeURIComponent(REDDIT.password!)}`,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Reddit 登录失败（HTTP ${res.status}）。请检查脚本类应用的 client_id / secret / 用户名密码。`)
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Reddit token 响应缺少 access_token。')
  redditTokenCache = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 }
  return redditTokenCache.token
}

async function redditFetch(url: string, token: string | null): Promise<unknown> {
  const finalUrl = token ? url.replace('https://www.reddit.com', 'https://oauth.reddit.com') : url
  const headers: Record<string, string> = { 'User-Agent': REDDIT_UA }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(finalUrl, { headers, signal: AbortSignal.timeout(30_000) })
  if (res.status === 429) throw new Error('Reddit 限流（429）。请降低查询频率，或在配置中填入 Reddit 脚本应用凭证以获得稳定额度。')
  if (!res.ok) throw new Error(`Reddit 请求失败（HTTP ${res.status}）。匿名访问易被限制，建议在 client-config.json 配置 reddit 凭证。`)
  return res.json()
}

// ── 系统提示词（广告优化师工作法则）──────────────────
const AGENT_RULES = `# Walmart 广告管理工作法则

你是 Walmart Connect 广告优化智能体（工作流对标 TikTok Ads Manager：概览诊断 → 推广系列管理 → 报表分析 → 优化建议）。遵守：

1. **写操作必须先确认**：创建/更新 Campaign、添加关键词、保存报告前，先向用户复述将要执行的变更（对象、字段、新值），明确同意后再调用工具。
2. **诊断优先**：用户问"今天怎么样"时，先 wc_stats 看实时指标，主动指出预算耗尽（cap-out）、零曝光、花费异常的 Campaign，并给出可执行的调整建议（参考"诊断建议"工作流）。
3. **Reddit 情报 → 广告动作**：用 reddit_insights 找用户痛点与购买信号后，必须落到具体广告动作——关键词建议（加入哪个 campaign、match type、出价区间）、素材/文案角度（针对哪类痛点）、否定词建议（低意向流量）。
4. **数据诚实**：工具返回"演示数据"时明确告知用户当前为演示模式；直连模式出错时如实说明现象，不编造数据。
5. **金额与日期格式**：金额带 $ 保留两位小数，日期用 YYYY-MM-DD。
6. 调整建议遵循保守原则：单次预算调整幅度建议不超过 ±50%，出价调整不超过 ±30%，并说明理由与预期影响。`

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'walmart-ads:rules',
    order: 10,
    interpolate: false,
    text: AGENT_RULES,
  })

  const modeLabel = LIVE ? `直连模式（advertiser: ${WM.advertiser_id || '未填'}）` : '演示模式（未配置 Walmart 凭证，写操作会持久保存）'
  console.log(`[walmart-ads] 插件已加载：wc_campaigns / wc_campaign_create / wc_campaign_update / wc_stats / wc_report / wc_keywords / reddit_insights / save_ads_report`)
  console.log(`[walmart-ads] Walmart: ${modeLabel}`)
  console.log(`[walmart-ads] Reddit: ${REDDIT.client_id ? '凭证模式（oauth.reddit.com）' : '匿名模式（公共端点，可能被限流）'}`)

  // ── 工具：Campaign 列表 ──
  ctx.tools.register(
    defineTool({
      name: 'wc_campaigns',
      description: '列出 Walmart Connect 广告 Campaign（支持按状态/类型/名称过滤）。返回预算、出价策略、起止日期等核心字段。',
      parameters: {
        status: { type: 'string', description: '按状态过滤：enabled / paused / scheduled / completed' },
        campaign_type: { type: 'string', description: '按类型过滤：sponsoredProducts / sba / video' },
        name_contains: { type: 'string', description: '按名称模糊过滤' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { mode: { type: 'string' }, count: { type: 'number' }, campaigns_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `当前模式：${v.mode}，共 ${v.count} 个 Campaign\n${v.campaigns_json}` }],
      },
      async execute(args) {
        let list: unknown[]
        let mode: string
        if (LIVE) {
          mode = 'live'
          const data = await wmApi<{ payload?: unknown[] } | unknown[]>('GET', `/campaigns?advertiserId=${encodeURIComponent(WM.advertiser_id || '')}`)
          list = Array.isArray(data) ? data : (data.payload ?? [])
        } else {
          mode = 'mock'
          const state = await loadState()
          list = state.campaigns
        }
        let filtered = list as MockCampaign[]
        if (args.status) filtered = filtered.filter((c) => c.status?.toLowerCase() === args.status!.toLowerCase())
        if (args.campaign_type) filtered = filtered.filter((c) => c.campaignType === args.campaign_type)
        if (args.name_contains) filtered = filtered.filter((c) => c.name?.toLowerCase().includes(args.name_contains!.toLowerCase()))
        const rows = filtered.map((c) => ({
          campaignId: c.campaignId, name: c.name, campaignType: c.campaignType,
          targetingType: c.targetingType, status: c.status, budgetType: c.budgetType,
          dailyBudget: c.dailyBudget, totalBudget: c.totalBudget, startDate: c.startDate, endDate: c.endDate,
          biddingStrategy: c.biddingStrategy?.strategy,
        }))
        return { mode, count: rows.length, campaigns_json: JSON.stringify(rows, null, 1) }
      },
    }),
  )

  // ── 工具：创建 Campaign ──
  ctx.tools.register(
    defineTool({
      name: 'wc_campaign_create',
      description: '创建 Walmart Connect 广告 Campaign（写操作，执行前必须获得用户确认）。预算下限：3P 卖家日预算 $10 起（1P $50 起）。',
      parameters: {
        name: { type: 'string', required: true, description: 'Campaign 名称（账户内唯一）' },
        campaign_type: { type: 'string', required: true, description: 'sponsoredProducts / sba / video' },
        targeting_type: { type: 'string', required: true, description: 'manual（手动关键词）/ auto（自动）' },
        daily_budget: { type: 'number', required: true, description: '日预算（美元）' },
        budget_type: { type: 'string', description: 'daily / both，默认 daily' },
        start_date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        end_date: { type: 'string', description: 'YYYY-MM-DD，不限期填 9999-12-30' },
        bidding_strategy: { type: 'string', description: 'DYNAMIC（动态出价，推荐）/ FIXED，默认 FIXED。sba 与 video 不适用' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { mode: { type: 'string' }, campaign_id: { type: 'string' }, name: { type: 'string' }, detail_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `Campaign 已创建（${v.mode}）：${v.name}（ID ${v.campaign_id}）\n${v.detail_json}` }],
      },
      async execute(args) {
        const campaignType = args.campaign_type as MockCampaign['campaignType']
        if (!['sponsoredProducts', 'sba', 'video'].includes(campaignType)) throw new Error('campaign_type 必须是 sponsoredProducts / sba / video')
        if (args.daily_budget < 10) throw new Error('日预算最低 $10（3P 卖家）。')
        const body = {
          name: args.name,
          campaignType,
          targetingType: (args.targeting_type === 'auto' ? 'auto' : 'manual') as MockCampaign['targetingType'],
          status: 'enabled',
          budgetType: (args.budget_type === 'both' ? 'both' : 'daily') as MockCampaign['budgetType'],
          dailyBudget: args.daily_budget,
          startDate: args.start_date || new Date().toISOString().slice(0, 10),
          endDate: args.end_date || '9999-12-30',
          rollover: true,
          ...(campaignType === 'sponsoredProducts' ? { biddingStrategy: { strategy: args.bidding_strategy === 'DYNAMIC' ? 'DYNAMIC' : 'FIXED' } } : {}),
          advertiserId: WM.advertiser_id || 'demo-advertiser-001',
        }
        if (LIVE) {
          const data = await wmApi<Record<string, unknown>>('POST', '/campaigns', body)
          return { mode: 'live', campaign_id: String((data as { campaignId?: number }).campaignId ?? ''), name: args.name, detail_json: JSON.stringify(data, null, 1) }
        }
        const state = await loadState()
        const newId = String(Math.max(0, ...state.campaigns.map((c) => Number(c.campaignId) || 0)) + 1)
        state.campaigns.push({ ...body, campaignId: newId, createdAt: new Date().toISOString().slice(0, 10) } as MockCampaign)
        await saveState(state)
        return { mode: 'mock', campaign_id: newId, name: args.name, detail_json: JSON.stringify(body, null, 1) }
      },
    }),
  )

  // ── 工具：更新 Campaign（预算/出价/状态）──
  ctx.tools.register(
    defineTool({
      name: 'wc_campaign_update',
      description: '更新 Campaign：调整日预算、出价策略、状态（暂停/启用）（写操作，执行前必须获得用户确认）。',
      parameters: {
        campaign_id: { type: 'string', required: true, description: 'Campaign ID' },
        daily_budget: { type: 'number', description: '新的日预算（美元）' },
        bidding_strategy: { type: 'string', description: 'DYNAMIC / FIXED（仅 sponsoredProducts）' },
        status: { type: 'string', description: 'enabled / paused' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { mode: { type: 'string' }, campaign_id: { type: 'string' }, updated_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `Campaign ${v.campaign_id} 已更新（${v.mode}）：\n${v.updated_json}` }],
      },
      async execute(args) {
        if (!args.daily_budget && !args.bidding_strategy && !args.status) throw new Error('至少提供一项要更新的字段：daily_budget / bidding_strategy / status')
        if (LIVE) {
          const update: Record<string, unknown> = { campaignId: Number(args.campaign_id), advertiserId: WM.advertiser_id }
          if (args.daily_budget) update.dailyBudget = args.daily_budget
          if (args.bidding_strategy) update.biddingStrategy = { strategy: args.bidding_strategy }
          if (args.status) update.status = args.status
          const data = await wmApi<Record<string, unknown>>('PUT', '/campaigns', update)
          return { mode: 'live', campaign_id: args.campaign_id, updated_json: JSON.stringify(data, null, 1) }
        }
        const state = await loadState()
        const c = state.campaigns.find((x) => x.campaignId === args.campaign_id)
        if (!c) throw new Error(`未找到 Campaign ${args.campaign_id}，请先用 wc_campaigns 查询。`)
        if (args.daily_budget) {
          if (args.daily_budget < 10) throw new Error('日预算最低 $10（3P 卖家）。')
          c.dailyBudget = args.daily_budget
        }
        if (args.bidding_strategy) c.biddingStrategy = { strategy: args.bidding_strategy === 'DYNAMIC' ? 'DYNAMIC' : 'FIXED' }
        if (args.status) c.status = args.status === 'paused' ? 'paused' : 'enabled'
        await saveState(state)
        return { mode: 'mock', campaign_id: args.campaign_id, updated_json: JSON.stringify({ name: c.name, dailyBudget: c.dailyBudget, biddingStrategy: c.biddingStrategy, status: c.status }, null, 1) }
      },
    }),
  )

  // ── 工具：近实时指标 ──
  ctx.tools.register(
    defineTool({
      name: 'wc_stats',
      description: '获取今日近实时指标（花费/曝光/点击/剩余预算/预算耗尽时间）。适合日常巡检与诊断。注意：该接口不建议 30 分钟内重复查询。',
      parameters: {
        campaign_id: { type: 'string', description: '只看单个 Campaign；不填则返回全部' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { mode: { type: 'string' }, stats_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `今日实时指标（${v.mode}）：\n${v.stats_json}` }],
      },
      async execute(args) {
        if (LIVE) {
          let apiPath = `/stats?advertiserId=${encodeURIComponent(WM.advertiser_id || '')}`
          if (args.campaign_id) apiPath += `&campaignId=${encodeURIComponent(args.campaign_id)}`
          const data = await wmApi<unknown>('GET', apiPath)
          return { mode: 'live', stats_json: JSON.stringify(data, null, 1) }
        }
        const state = await loadState()
        const today = new Date().toISOString().slice(0, 10)
        const targets = args.campaign_id ? state.campaigns.filter((c) => c.campaignId === args.campaign_id) : state.campaigns
        const rows = targets.map((c) => {
          const m = mockDailyMetrics(c, today)
          const spentPct = c.dailyBudget ? m.spend / c.dailyBudget : 0
          return {
            campaignId: c.campaignId, name: c.name, status: c.status,
            todaySpend: m.spend, todayImpressions: m.impressions, todayClicks: m.clicks,
            dailyBudget: c.dailyBudget, dailyRemainingBudget: +(c.dailyBudget - m.spend).toFixed(2),
            ...(spentPct > 0.95 ? { dailyOutOfBudgetDatetime: `${today}T18:30:00Z`, capOutAlert: '今日预算即将/已经耗尽' } : {}),
          }
        })
        return { mode: 'mock', stats_json: JSON.stringify(rows, null, 1) }
      },
    }),
  )

  // ── 工具：期间报表 ──
  ctx.tools.register(
    defineTool({
      name: 'wc_report',
      description: '生成期间广告报表（默认近 14 天，按 Campaign 汇总曝光/点击/花费/订单/ROAS 等）。用于周报与趋势分析。',
      parameters: {
        days: { type: 'number', description: '统计天数，默认 14（上限 90）' },
        campaign_id: { type: 'string', description: '只看单个 Campaign' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { mode: { type: 'string' }, date_range: { type: 'string' }, report_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `期间报表（${v.date_range}，${v.mode}）：\n${v.report_json}` }],
      },
      async execute(args) {
        const days = Math.min(Math.max(args.days ?? 14, 1), 90)
        if (LIVE) {
          const stats = await wmApi<unknown>('GET', `/stats?advertiserId=${encodeURIComponent(WM.advertiser_id || '')}`)
          return {
            mode: 'live',
            date_range: '今日',
            report_json: JSON.stringify({ note: '直连模式当前提供今日实时指标；历史期间报表请从 Walmart Connect 控制台导出，或等待后续版本接入快照报表接口。', todayStats: stats }, null, 1),
          }
        }
        const state = await loadState()
        const dates = dateRange(days)
        const targets = args.campaign_id ? state.campaigns.filter((c) => c.campaignId === args.campaign_id) : state.campaigns
        const rows = targets.map((c) => {
          let impressions = 0, clicks = 0, spend = 0, orders = 0, sales = 0
          for (const d of dates) {
            const m = mockDailyMetrics(c, d)
            impressions += m.impressions; clicks += m.clicks; spend += m.spend; orders += m.orders; sales += m.sales
          }
          return {
            campaignId: c.campaignId, name: c.name, campaignType: c.campaignType, status: c.status,
            impressions, clicks, spend: +spend.toFixed(2), orders, sales: +sales.toFixed(2),
            ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
            cpc: clicks ? +(spend / clicks).toFixed(2) : 0,
            cvr: clicks ? +((orders / clicks) * 100).toFixed(1) : 0,
            roas: spend ? +(sales / spend).toFixed(2) : 0,
            acos: sales ? +((spend / sales) * 100).toFixed(1) : 0,
          }
        })
        return {
          mode: 'mock',
          date_range: `${dates[0]} ~ ${dates[dates.length - 1]}`,
          report_json: JSON.stringify(rows, null, 1),
        }
      },
    }),
  )

  // ── 工具：关键词管理 ──
  ctx.tools.register(
    defineTool({
      name: 'wc_keywords',
      description: '关键词管理：列出 Campaign 的投放关键词（词、匹配类型、出价、状态），或添加新关键词（写操作需确认）。适合配合 Reddit 情报落地选词。',
      parameters: {
        action: { type: 'string', description: 'list（默认，列出）/ add（添加，写操作）' },
        campaign_id: { type: 'string', description: 'Campaign ID' },
        term: { type: 'string', description: 'add 时：关键词' },
        match_type: { type: 'string', description: 'add 时：exact / phrase / broad，默认 exact' },
        bid: { type: 'number', description: 'add 时：出价（美元），默认 0.5' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { mode: { type: 'string' }, action: { type: 'string' }, result_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `关键词${v.action === 'add' ? '已添加' : '列表'}（${v.mode}）：\n${v.result_json}` }],
      },
      async execute(args) {
        const action = args.action === 'add' ? 'add' : 'list'
        if (action === 'add') {
          if (!args.campaign_id || !args.term) throw new Error('添加关键词需要 campaign_id 与 term。')
          if (LIVE) {
            const data = await wmApi<Record<string, unknown>>('POST', '/keywords', {
              campaignId: Number(args.campaign_id),
              keywordList: [{ keywordText: args.term, matchType: args.match_type === 'phrase' ? 'phrase' : args.match_type === 'broad' ? 'broad' : 'exact', bid: args.bid ?? 0.5 }],
            })
            return { mode: 'live', action, result_json: JSON.stringify(data, null, 1) }
          }
          const state = await loadState()
          if (!state.campaigns.find((c) => c.campaignId === args.campaign_id)) throw new Error(`未找到 Campaign ${args.campaign_id}。`)
          const kid = String(Math.max(0, ...state.keywords.map((k) => Number(k.keywordId) || 0)) + 1)
          state.keywords.push({
            keywordId: kid, campaignId: args.campaign_id, term: args.term,
            matchType: (args.match_type === 'phrase' ? 'phrase' : args.match_type === 'broad' ? 'broad' : 'exact') as MockKeyword['matchType'],
            bid: args.bid ?? 0.5, state: 'enabled',
          })
          await saveState(state)
          return { mode: 'mock', action, result_json: JSON.stringify({ keywordId: kid, campaignId: args.campaign_id, term: args.term, matchType: args.match_type || 'exact', bid: args.bid ?? 0.5, state: 'enabled' }, null, 1) }
        }
        if (LIVE) {
          const data = await wmApi<unknown>('GET', `/keywords?advertiserId=${encodeURIComponent(WM.advertiser_id || '')}${args.campaign_id ? `&campaignId=${encodeURIComponent(args.campaign_id)}` : ''}`)
          return { mode: 'live', action, result_json: JSON.stringify(data, null, 1) }
        }
        const state = await loadState()
        const rows = args.campaign_id ? state.keywords.filter((k) => k.campaignId === args.campaign_id) : state.keywords
        return { mode: 'mock', action, result_json: JSON.stringify(rows, null, 1) }
      },
    }),
  )

  // ── 工具：Reddit 情报 ──
  ctx.tools.register(
    defineTool({
      name: 'reddit_insights',
      description: 'Reddit 市场情报：按关键词搜索 Reddit 帖子（含热门评论），用痛点/购买信号规则引擎评分，返回痛点帖、信号帖与广告行动建议素材（选词角度/文案角度/否定词方向）。',
      parameters: {
        query: { type: 'string', required: true, description: '产品/品类/场景关键词（英文效果最好）' },
        limit: { type: 'number', description: '帖子数量，默认 25，上限 50' },
        with_comments: { type: 'boolean', description: '是否抓取热帖评论（更准但更慢），默认 true' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            count: { type: 'number' },
            pain_count: { type: 'number' },
            signal_count: { type: 'number' },
            insights_json: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `Reddit 情报（${v.count} 帖，痛点 ${v.pain_count} / 信号 ${v.signal_count}）：\n${v.insights_json}` }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(args.limit ?? 25, 5), 50)
        const token = await getRedditToken().catch(() => null)
        const searchJson = (await redditFetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(args.query)}&sort=top&t=month&limit=${limit}&raw_json=1`, token)) as { data?: { children?: { data: Record<string, unknown> }[] } }
        const children = searchJson?.data?.children ?? []
        if (!children.length) throw new Error(`关键词 "${args.query}" 没有搜到帖子，建议换更通用的品类词重试。`)

        const posts: Record<string, unknown>[] = []
        let fetched = 0
        for (const { data: d } of children) {
          const numComments = Number(d.num_comments ?? 0)
          let comments: { body: string; score: number }[] = []
          if (args.with_comments !== false && numComments >= 10 && fetched < 5) {
            try {
              const cj = (await redditFetch(`https://www.reddit.com${d.permalink}.json?limit=5&depth=1&raw_json=1`, token)) as { [1]?: { data?: { children?: { kind: string; data: { body?: string; score?: number } }[] } } }
              comments = (cj?.[1]?.data?.children ?? [])
                .filter((c) => c.kind === 't1')
                .slice(0, 5)
                .map((c) => ({ body: (c.data.body || '').slice(0, 800), score: c.data.score ?? 0 }))
              fetched++
              await new Promise((r) => setTimeout(r, 1500))
            } catch { /* 评论失败不影响主帖分析 */ }
          }
          const text = `${d.title || ''}\n${d.selftext || ''}\n${comments.map((c) => c.body).join('\n')}`
          const pain = scoreText(text, PAIN_RULES)
          const signal = scoreText(text, SIGNAL_RULES)
          posts.push({
            subreddit: d.subreddit, title: d.title, score: d.score, num_comments: numComments,
            permalink: `https://www.reddit.com${d.permalink}`,
            pain_score: pain.score, pain_tags: pain.tags,
            signal_score: signal.score, signal_tags: signal.tags,
            top_comments: comments.slice(0, 3),
          })
        }
        const pains = posts.filter((p) => (p.pain_score as number) >= 3).sort((a, b) => (b.pain_score as number) - (a.pain_score as number))
        const signals = posts.filter((p) => (p.signal_score as number) >= 3).sort((a, b) => (b.signal_score as number) - (a.signal_score as number))
        const tagCount = (list: typeof posts, key: string) => {
          const m: Record<string, number> = {}
          for (const p of list) for (const t of (p[key] as string[]) ?? []) m[t] = (m[t] ?? 0) + 1
          return Object.entries(m).sort((a, b) => b[1] - a[1])
        }
        const result = {
          query: args.query, sample: posts.length,
          pain_summary: { count: pains.length, top_tags: tagCount(pains, 'pain_tags') },
          signal_summary: { count: signals.length, top_tags: tagCount(signals, 'signal_tags') },
          top_pain_posts: pains.slice(0, 8).map((p) => ({ subreddit: p.subreddit, title: p.title, pain_score: p.pain_score, pain_tags: p.pain_tags, permalink: p.permalink, comments: p.top_comments })),
          top_signal_posts: signals.slice(0, 8).map((p) => ({ subreddit: p.subreddit, title: p.title, signal_score: p.signal_score, signal_tags: p.signal_tags, permalink: p.permalink })),
          ad_action_hints: {
            keywords: signals.slice(0, 5).map((p) => (p.title as string).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(' ')).filter(Boolean),
            angles: tagCount(pains, 'pain_tags').slice(0, 3).map(([tag]) => `针对「${tag}」类痛点做文案切入`),
            negative: ['free', 'diy', 'how to make', 'homemade'].map((w) => `否定词建议：${w}（低购买意向流量）`),
          },
        }
        return {
          count: posts.length,
          pain_count: pains.length,
          signal_count: signals.length,
          insights_json: JSON.stringify(result, null, 1),
        }
      },
    }),
  )

  // ── 工具：保存报告 ──
  ctx.tools.register(
    defineTool({
      name: 'save_ads_report',
      description: '将广告分析/周报保存为 Markdown 文件（workspace/reports/ 目录，文件名含日期；同名自动递增 v2、v3）。保存前必须征得用户同意。',
      parameters: {
        title: { type: 'string', required: true, description: '报告标题（用于文件名）' },
        content: { type: 'string', required: true, description: '报告全文（Markdown）' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { path: { type: 'string' }, bytes: { type: 'number' } },
        },
        render: (_a, v) => [{ type: 'text', text: `报告已保存：${v.path}（${v.bytes} 字节）` }],
      },
      async execute(args) {
        const reportsDir = process.env.ADS_REPORTS_DIR || path.join(process.cwd(), 'workspace', 'reports')
        await mkdir(reportsDir, { recursive: true })
        const safe = args.title.replace(/[\\/:*?"<>|\r\n]/g, '').trim() || '未命名'
        const date = new Date().toISOString().slice(0, 10)
        const base = `广告报告_${safe}_${date}`
        let target = path.join(reportsDir, `${base}.md`)
        let version = 2
        while (await fileExists(target)) {
          target = path.join(reportsDir, `${base}-v${version}.md`)
          version += 1
        }
        const buf = Buffer.from(args.content, 'utf8')
        await writeFile(target, buf)
        return { path: target, bytes: buf.byteLength }
      },
    }),
  )

  // ── 写操作确认门 ──
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name === 'wc_campaign_create') {
      return { kind: 'ask', reason: '即将创建广告 Campaign（写操作），请确认名称、类型、预算等信息无误。' }
    }
    if (exec.name === 'wc_campaign_update') {
      return { kind: 'ask', reason: '即将修改 Campaign（预算/出价/状态），请确认调整幅度与理由。' }
    }
    if (exec.name === 'wc_keywords' && exec.args?.action === 'add') {
      return { kind: 'ask', reason: '即将添加投放关键词（写操作），请确认关键词、匹配类型与出价。' }
    }
    if (exec.name === 'save_ads_report') {
      return { kind: 'ask', reason: '即将保存广告报告（写操作），请确认报告标题与内容。' }
    }
    return next()
  })
}
