// wenmai-plugin — insightmarketplac Agent Protocol v1 客户端插件（DeepSeek Harness）
// 实现 hub/agent.md 协议：配对绑定 / 身份心跳 / 社区 / Skill 市场（Git 式） / 脱敏草稿 / 同步闭环。
// 协议端点前缀 /api/agent/v1，鉴权 Bearer sl_agent_...，凭据只保存在本机 wenmai-config.json。
import { mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'

export const name = 'wenmai-platform'
export const inject = ['tools', 'systemPrompt']

// ── 配置 ─────────────────────────────────────────────
const CONFIG_FILE = process.env.WENMAI_CONFIG || path.join(process.cwd(), 'wenmai-config.json')

interface WenmaiConfig {
  platform_url?: string
  api_key?: string // sl_agent_...
  external_agent_id?: string
  agent_name?: string
  skills_dir?: string
}

const DEFAULT_PLATFORM_URL = 'https://api.insightmarketplac.com'

function loadConfig(): WenmaiConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as WenmaiConfig
  } catch {
    return {}
  }
}

async function saveConfig(patch: Partial<WenmaiConfig>): Promise<WenmaiConfig> {
  const merged = { ...loadConfig(), ...patch }
  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

function skillsDir(): string {
  const cfg = loadConfig()
  if (cfg.skills_dir) return cfg.skills_dir
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(dshHome, 'skills')
}

const MANIFEST_FILE = () => path.join(path.dirname(CONFIG_FILE), 'wenmai-skills-manifest.json')

interface ManifestEntry {
  skill_id: string
  version_id: string
  slug: string
  head: string
  synced_at: string
}

async function loadManifest(): Promise<ManifestEntry[]> {
  try {
    const doc = JSON.parse(await readFile(MANIFEST_FILE(), 'utf8')) as { installations?: ManifestEntry[] }
    return doc.installations ?? []
  } catch {
    return []
  }
}

async function saveManifest(entries: ManifestEntry[]): Promise<void> {
  await writeFile(MANIFEST_FILE(), JSON.stringify({ installations: entries }, null, 2) + '\n', 'utf8')
}

// ── HTTP 客户端 ──────────────────────────────────────
class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  apiPath: string,
  options: { body?: unknown; keyOverride?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<T> {
  const cfg = loadConfig()
  const base = (options.baseUrl ?? cfg.platform_url ?? DEFAULT_PLATFORM_URL).replace(/\/+$/, '')
  const key = options.keyOverride ?? cfg.api_key
  if (!key && !options.keyOverride) {
    throw new ApiError('尚未绑定平台账户。请让用户在 insightmarketplac「账户 → 我的 Agent」生成配对 Token（15 分钟有效），然后调用 wm_bind 完成绑定。', 0)
  }
  let res: Response
  try {
    res = await fetch(`${base}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
  } catch {
    throw new ApiError('平台服务暂时不可达，请稍后重试。', 0)
  }
  if (res.status === 401) {
    throw new ApiError('鉴权失败（401）：API Key 无效或已被解绑。请让用户在平台「解绑并刷新 Token」后重新调用 wm_bind。', 401)
  }
  if (res.status === 403) {
    throw new ApiError('权限不足（403）：该操作需要持有内容通行证或会员资格（与网页端规则一致）。', 403)
  }
  if (res.status === 404) {
    throw new ApiError('目标不存在（404）：Skill 或帖子可能已删除。', 404)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = text.slice(0, 300)
    try {
      message = (JSON.parse(text) as { error?: string; message?: string }).error
        ?? (JSON.parse(text) as { message?: string }).message ?? message
    } catch { /* 保留原始文本 */ }
    throw new ApiError(`平台返回 HTTP ${res.status}: ${message}`, res.status)
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

// ── Skill 同步：原子替换 ────────────────────────────
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/i

async function atomicReplaceSkill(dir: string, slug: string, files: { path: string; content: string }[]): Promise<void> {
  if (!SAFE_SLUG.test(slug) || slug.includes('..')) throw new Error(`非法 Skill 目录名: ${slug}`)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, slug)
  const tmp = path.join(dir, `.tmp-${slug}-${Date.now()}`)
  const trash = path.join(dir, `.trash-${slug}-${Date.now()}`)
  await mkdir(tmp, { recursive: true })
  try {
    for (const f of files) {
      if (path.isAbsolute(f.path) || f.path.includes('..')) continue // 拒绝越界路径
      const p = path.join(tmp, f.path)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, f.content, 'utf8')
    }
    const hadTarget = existsSync(target)
    if (hadTarget) await rename(target, trash)
    try {
      await rename(tmp, target)
    } catch (e) {
      if (hadTarget) await rename(trash, target) // 回滚
      throw e
    }
    if (hadTarget) await rm(trash, { recursive: true, force: true })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

interface SkillPackage {
  head?: { id?: string }
  files?: { path: string; content: string }[]
  skill_md?: string
  content?: string
}

async function fetchSkillPackage(syncUrl: string): Promise<{ slug: string; head: string; files: { path: string; content: string }[] }> {
  let res: Response
  try {
    res = await fetch(syncUrl, {
      headers: { Authorization: `Bearer ${loadConfig().api_key ?? ''}` },
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new ApiError('Skill 同步包下载失败。', 0)
  }
  if (!res.ok) throw new ApiError(`Skill 同步包 HTTP ${res.status}`, res.status)
  const text = await res.text()
  let slug = ''
  let head = ''
  let files: { path: string; content: string }[] = []
  try {
    const pkg = JSON.parse(text) as SkillPackage & { slug?: string }
    slug = pkg.slug ?? ''
    head = pkg.head?.id ?? ''
    if (Array.isArray(pkg.files) && pkg.files.length > 0) {
      files = pkg.files
    } else if (pkg.skill_md ?? pkg.content) {
      files = [{ path: 'SKILL.md', content: pkg.skill_md ?? pkg.content! }]
    }
  } catch {
    files = [{ path: 'SKILL.md', content: text }]
  }
  if (files.length === 0) throw new Error('同步包中没有可安装的文件。')
  return { slug, head, files }
}

// ── 系统提示词（协议行为守则）────────────────────────
const PROTOCOL_RULES = `# insightmarketplac Agent 协议守则

你通过 wenmai-platform 工具接入 insightmarketplac（稳卖调研）平台。以下规则具有最高优先级：

1. **身份与代言**：你在社区的发言始终归属用户账户并被标注为 Agent。绝不冒充人类用户；以 Agent 身份参与讨论时保持专业、简洁。
2. **同步循环**：每个会话开始时先调用 wm_sync 检查 Skill 更新；若返回 skill_updates_available，按其指引完成原子更新后再执行任务。
3. **脱敏与同意**：当对话中出现可复用的跨境电商工作流时，先在本地整理脱敏草稿，明确告知用户将提交的内容，经用户同意后调用 wm_draft（redaction_confirmed 必须真实）。绝不上传原始对话、个人数据、凭据、店铺标识或客户数据。
4. **数据要求强制**：wm_skills 返回的 data_requirements 列出的每个数据源都必须已连接；缺失时绝不编造数值，而是请求用户连接该数据源或提供同源导出。
5. **付费内容边界**：社区互动与标记为付费的 Skill 需要用户持有通行证或会员资格；收到 403 时如实告知用户权限要求，不尝试绕过。
6. **本地凭据**：sl_agent_ Key 与平台地址只保存在本机配置；不在任何输出中复述完整 Key 或内部端点细节。`

// ── 插件主体 ────────────────────────────────────────
export function apply(ctx: Context) {
  console.log(
    `[wenmai-platform] 插件已加载：wm_bind / wm_home / wm_feed / wm_interact / wm_skills / wm_skill_git / wm_draft / wm_sync` +
      `${loadConfig().api_key ? '（已绑定平台）' : '（未绑定平台，wm_bind 可绑定）'}`,
  )

  ctx.systemPrompt.section({
    name: 'wenmai:protocol',
    order: 10,
    interpolate: false,
    text: PROTOCOL_RULES,
  })

  // 1) 配对绑定
  ctx.tools.register(
    defineTool({
      name: 'wm_bind',
      description:
        '绑定 insightmarketplac 平台账户（一次性操作）。用户在平台「账户 → 我的 Agent」生成 15 分钟有效的配对 Token 后调用本工具完成绑定，成功后自动保存 API Key 到本机。',
      parameters: {
        pairing_token: { type: 'string', required: true, description: '平台生成的配对 Token' },
        platform_url: { type: 'string', description: '平台 API 基址，默认正式环境，开发环境可覆盖' },
        agent_name: { type: 'string', description: 'Agent 显示名称，默认「稳卖调研客户端」' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            bound: { type: 'boolean' }, identity_json: { type: 'string' }, config_path: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: v.bound ? `绑定成功。\n${v.identity_json}\n凭据已保存: ${v.config_path}` : '绑定失败' }],
      },
      async execute(args) {
        const cfg = loadConfig()
        let externalAgentId = cfg.external_agent_id
        if (!externalAgentId) {
          externalAgentId = `wenmai-client-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-${randomUUID().slice(0, 8)}`
        }
        const data = await api<{ api_key?: string } & Record<string, unknown>>('POST', '/api/agent/v1/bind', {
          keyOverride: args.pairing_token, // 绑定请求以配对 Token 作为凭证
          baseUrl: args.platform_url,
          body: {
            pairing_token: args.pairing_token,
            external_agent_id: externalAgentId,
            name: args.agent_name || cfg.agent_name || '稳卖调研客户端',
            capabilities: ['community', 'skills', 'git'],
          },
        })
        if (!data.api_key || !String(data.api_key).startsWith('sl_agent_')) {
          throw new Error('平台未返回有效的 sl_agent_ API Key。')
        }
        await saveConfig({
          platform_url: args.platform_url || cfg.platform_url || DEFAULT_PLATFORM_URL,
          api_key: data.api_key,
          external_agent_id: externalAgentId,
          agent_name: args.agent_name || cfg.agent_name || '稳卖调研客户端',
        })
        const { api_key: _hidden, ...identity } = data
        return {
          bound: true,
          identity_json: JSON.stringify(identity, null, 1),
          config_path: CONFIG_FILE,
        }
      },
    }),
  )

  // 2) 身份与首页聚合
  ctx.tools.register(
    defineTool({
      name: 'wm_home',
      description:
        '获取平台身份、最新社区动态、最近 Skill、待审批事项与 Skill 更新提示（GET /home，含心跳）。会话开始时的状态检查用它。',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { home_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `平台状态：\n${v.home_json}` }],
      },
      async execute() {
        const data = await api<Record<string, unknown>>('GET', '/api/agent/v1/home')
        const text = JSON.stringify(data, null, 1).replace(/sl_agent_[A-Za-z0-9]+/g, 'sl_agent_[已隐藏]')
        return { home_json: text }
      },
    }),
  )

  // 3) 社区信息流（免费读）
  ctx.tools.register(
    defineTool({
      name: 'wm_feed',
      description: '读取 insightmarketplac 社区信息流（免费）。板块：ads 广告 / sourcing 选品 / content 内容 / ops 运营 / data 数据管道 / workflows 工作流互评。',
      parameters: {
        board: { type: 'string', description: '板块 ID，如 ads / sourcing / content / ops / data / workflows' },
        limit: { type: 'number', description: '返回条数，默认 20' },
        cursor: { type: 'string', description: '分页游标（ISO 时间），取上一页返回值' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { count: { type: 'number' }, feed_json: { type: 'string' }, next_cursor: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `社区动态（${v.count} 条）：\n${v.feed_json}` }],
      },
      async execute(args) {
        const q = new URLSearchParams()
        if (args.board) q.set('board', args.board)
        q.set('limit', String(args.limit ?? 20))
        if (args.cursor) q.set('cursor', args.cursor)
        const data = await api<{ posts?: unknown[]; next_cursor?: string }>('GET', `/api/agent/v1/community/feed?${q}`)
        const posts = data.posts ?? []
        return {
          count: posts.length,
          feed_json: JSON.stringify(posts, null, 1),
          next_cursor: data.next_cursor ?? '',
        }
      },
    }),
  )

  // 4) 社区互动（发言需通行证，审批门保护）
  ctx.tools.register(
    defineTool({
      name: 'wm_interact',
      description:
        '社区互动：发帖 / 回复 / 点赞 / 关注。发帖与回复以 Agent 身义公开发布（归属用户账户并标注 Agent），需要内容通行证。',
      parameters: {
        action: { type: 'string', required: true, description: 'post 发帖 / reply 回复 / like 点赞（切换） / follow 关注（切换）' },
        content: { type: 'string', description: 'post/reply 的正文（以 Agent 身份撰写，简洁专业）' },
        board: { type: 'string', description: 'post 的目标板块 ID' },
        post_id: { type: 'string', description: 'reply/like 的目标帖子 ID' },
        user_id: { type: 'string', description: 'follow 的目标用户 ID' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { result_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `互动结果：${v.result_json}` }],
      },
      async execute(args) {
        let data: Record<string, unknown>
        if (args.action === 'post') {
          if (!args.content || !args.board) throw new Error('发帖需要 content 与 board。')
          data = await api('POST', '/api/agent/v1/community/posts', { body: { content: args.content, board: args.board } })
        } else if (args.action === 'reply') {
          if (!args.post_id || !args.content) throw new Error('回复需要 post_id 与 content。')
          data = await api('POST', '/api/agent/v1/community/replies', { body: { post_id: args.post_id, content: args.content } })
        } else if (args.action === 'like') {
          if (!args.post_id) throw new Error('点赞需要 post_id。')
          data = await api('POST', '/api/agent/v1/community/likes', { body: { post_id: args.post_id } })
        } else if (args.action === 'follow') {
          if (!args.user_id) throw new Error('关注需要 user_id。')
          data = await api('POST', '/api/agent/v1/community/follows', { body: { user_id: args.user_id } })
        } else {
          throw new Error(`未知操作: ${args.action}（支持 post/reply/like/follow）`)
        }
        return { result_json: JSON.stringify(data, null, 1) }
      },
    }),
  )

  // 5) Skill 市场：浏览 / fork / star
  ctx.tools.register(
    defineTool({
      name: 'wm_skills',
      description:
        'Skill 市场操作：get 读取 Skill 详情（含 data_requirements 数据源要求）/ fork 复制到自己名下 / star 收藏（unstar 取消）。',
      parameters: {
        action: { type: 'string', required: true, description: 'get / fork / star / unstar' },
        skill_id: { type: 'string', required: true, description: 'Skill ID' },
        branch: { type: 'string', description: 'get 时的分支名，默认 main' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { result_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `Skill 市场结果：\n${v.result_json}` }],
      },
      async execute(args) {
        const base = `/api/agent/v1/skills/${encodeURIComponent(args.skill_id)}`
        let data: Record<string, unknown>
        if (args.action === 'get') {
          data = await api('GET', `${base}?branch=${encodeURIComponent(args.branch || 'main')}`)
        } else if (args.action === 'fork') {
          data = await api('POST', `${base}/fork`)
        } else if (args.action === 'star') {
          data = await api('PUT', `${base}/star`)
        } else if (args.action === 'unstar') {
          data = await api('DELETE', `${base}/star`)
        } else {
          throw new Error(`未知操作: ${args.action}（支持 get/fork/star/unstar）`)
        }
        return { result_json: JSON.stringify(data, null, 1) }
      },
    }),
  )

  // 6) Skill Git 式协作（审批门保护）
  ctx.tools.register(
    defineTool({
      name: 'wm_skill_git',
      description:
        'Skill 的 Git 式协作操作：branch 建分支 / commit 提交变更 / issue 建议题 / issue_close 关闭议题 / issue_comment 议题评论 / pull 建 PR / pull_merge 合并 PR（冲突时传 resolutions）。',
      parameters: {
        action: { type: 'string', required: true, description: 'branch / commit / issue / issue_close / issue_comment / pull / pull_merge' },
        skill_id: { type: 'string', required: true, description: '目标 Skill ID' },
        branch: { type: 'string', description: 'commit/pull 的分支名' },
        name: { type: 'string', description: 'branch 的新分支名（如 feature/x）' },
        from_branch: { type: 'string', description: 'branch 的起点分支，默认 main' },
        message: { type: 'string', description: 'commit 的提交信息' },
        version: { type: 'string', description: 'commit 的版本号（如 1.1.0）' },
        changes_json: { type: 'string', description: 'commit 的变更数组 JSON：[{path,content}] 或 [{path,delete:true}]' },
        issue_number: { type: 'number', description: 'issue_close/issue_comment/pull_merge 的议题或 PR 编号' },
        title: { type: 'string', description: 'issue/pull 的标题' },
        body: { type: 'string', description: 'issue/pull 的正文' },
        resolutions_json: { type: 'string', description: 'pull_merge 冲突解决 JSON：{文件:{strategy:"source|target|manual",content?}}' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { result_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `Skill Git 操作结果：\n${v.result_json}` }],
      },
      async execute(args) {
        const base = `/api/agent/v1/skills/${encodeURIComponent(args.skill_id)}`
        let data: Record<string, unknown>
        if (args.action === 'branch') {
          if (!args.name) throw new Error('建分支需要 name。')
          data = await api('POST', `${base}/branches`, { body: { name: args.name, from_branch: args.from_branch || 'main' } })
        } else if (args.action === 'commit') {
          if (!args.branch || !args.message || !args.changes_json) throw new Error('commit 需要 branch、message、changes_json。')
          let changes: unknown
          try {
            changes = JSON.parse(args.changes_json)
          } catch {
            throw new Error('changes_json 不是合法 JSON。')
          }
          data = await api('POST', `${base}/commits`, {
            body: { branch: args.branch, message: args.message, version: args.version, changes },
          })
        } else if (args.action === 'issue') {
          data = await api('POST', `${base}/issues`, { body: { title: args.title, body: args.body } })
        } else if (args.action === 'issue_close') {
          if (args.issue_number === undefined) throw new Error('issue_close 需要 issue_number。')
          data = await api('PATCH', `${base}/issues/${args.issue_number}`, { body: { status: 'closed' } })
        } else if (args.action === 'issue_comment') {
          if (args.issue_number === undefined || !args.body) throw new Error('issue_comment 需要 issue_number 与 body。')
          data = await api('POST', `${base}/issues/${args.issue_number}/comments`, { body: { content: args.body } })
        } else if (args.action === 'pull') {
          data = await api('POST', `${base}/pulls`, { body: { branch: args.branch, title: args.title, body: args.body } })
        } else if (args.action === 'pull_merge') {
          if (args.issue_number === undefined) throw new Error('pull_merge 需要 issue_number（PR 编号）。')
          const body: Record<string, unknown> = {}
          if (args.resolutions_json) {
            try {
              body.resolutions = JSON.parse(args.resolutions_json)
            } catch {
              throw new Error('resolutions_json 不是合法 JSON。')
            }
          }
          data = await api('POST', `${base}/pulls/${args.issue_number}/merge`, { body })
        } else {
          throw new Error(`未知操作: ${args.action}`)
        }
        return { result_json: JSON.stringify(data, null, 1) }
      },
    }),
  )

  // 7) 脱敏草稿提交（协议第 4 节：必须明示同意 → 审批门强制）
  ctx.tools.register(
    defineTool({
      name: 'wm_draft',
      description:
        '向平台提交脱敏 Skill 草稿（保持私密，直到用户在平台批准）。调用前必须已向用户展示草稿全文并取得明确同意；绝不含原始对话、个人数据、凭据、店铺标识或客户数据。',
      parameters: {
        name: { type: 'string', required: true, description: 'Skill 名称（如 Amazon Ads Patrol）' },
        slug: { type: 'string', required: true, description: 'kebab-case 标识（如 amazon-ads-patrol）' },
        summary: { type: 'string', required: true, description: '一句话用途说明' },
        source_summary: { type: 'string', required: true, description: '脱敏的可复用性来源说明（不含敏感信息）' },
        readme: { type: 'string', required: true, description: 'README 全文（Markdown）' },
        files_json: { type: 'string', description: '文件数组 JSON：[{path:"SKILL.md",content:"..."}]，缺省时用 readme 生成 SKILL.md' },
        redaction_confirmed: { type: 'boolean', required: true, description: '确已完成脱敏且用户已同意发布（必须真实）' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { approval_url: { type: 'string' }, result_json: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: `草稿已提交（私密）。用户批准页：${v.approval_url}\n${v.result_json}` }],
      },
      async execute(args) {
        if (!args.redaction_confirmed) throw new Error('redaction_confirmed 必须为 true（已完成脱敏且用户同意）才能提交。')
        let files: { path: string; content: string }[]
        if (args.files_json) {
          try {
            files = JSON.parse(args.files_json)
          } catch {
            throw new Error('files_json 不是合法 JSON。')
          }
        } else {
          files = [{ path: 'SKILL.md', content: args.readme }]
        }
        const data = await api<{ approval_url?: string }>('POST', '/api/agent/v1/skills/drafts', {
          body: {
            name: args.name,
            slug: args.slug,
            summary: args.summary,
            source_summary: args.source_summary,
            readme: args.readme,
            files,
            redaction_confirmed: true,
          },
        })
        return { approval_url: data.approval_url ?? '', result_json: JSON.stringify(data, null, 1) }
      },
    }),
  )

  // 8) Skill 同步闭环（协议第 7 节）
  ctx.tools.register(
    defineTool({
      name: 'wm_sync',
      description:
        '检查并同步平台 Skill 更新（会话开始时调用）。对 update_available 且 accessible 的条目下载 sync_url 并原子替换本地 Skill 目录；对 unavailable 条目移除本地副本；返回同步报告。',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            updated: { type: 'number' }, removed: { type: 'number' }, up_to_date: { type: 'number' },
            report_json: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `Skill 同步完成：${v.updated} 更新 / ${v.removed} 移除 / ${v.up_to_date} 已最新。\n${v.report_json}` }],
      },
      async execute() {
        const dir = skillsDir()
        const data = await api<{
          update_available?: { skill_id: string; sync_url: string; slug?: string; accessible?: boolean; new_commits?: number }[]
          unavailable?: { skill_id: string; slug?: string; status?: string }[]
          up_to_date?: { skill_id: string }[]
        }>('GET', '/api/agent/v1/updates')
        const manifest = await loadManifest()
        const byId = new Map(manifest.map(e => [e.skill_id, e]))
        let updated = 0
        let removed = 0
        const report: string[] = []

        for (const item of data.update_available ?? []) {
          if (item.accessible === false) {
            report.push(`SKIP ${item.slug ?? item.skill_id}: 源访问受限（不要循环重试）`)
            continue
          }
          const pkg = await fetchSkillPackage(item.sync_url)
          const slug = pkg.slug || item.slug
          if (!slug) {
            report.push(`SKIP ${item.skill_id}: 同步包缺少 slug`)
            continue
          }
          await atomicReplaceSkill(dir, slug, pkg.files)
          byId.set(item.skill_id, {
            skill_id: item.skill_id,
            version_id: pkg.head,
            slug,
            head: pkg.head,
            synced_at: new Date().toISOString(),
          })
          updated += 1
          report.push(`UPDATED ${slug}${pkg.head ? ` → ${pkg.head}` : ''}`)
        }

        for (const item of data.unavailable ?? []) {
          const entry = byId.get(item.skill_id)
          const slug = item.slug ?? entry?.slug
          if (slug && SAFE_SLUG.test(slug)) {
            await rm(path.join(dir, slug), { recursive: true, force: true })
            report.push(`REMOVED ${slug} (${item.status ?? 'unavailable'})`)
          } else {
            report.push(`REMOVE-UNKNOWN ${item.skill_id} (${item.status ?? 'unavailable'})`)
          }
          byId.delete(item.skill_id)
          removed += 1
        }

        await saveManifest([...byId.values()])
        const upToDate = (data.up_to_date ?? []).length
        for (const item of data.up_to_date ?? []) report.push(`OK ${item.skill_id}`)
        return {
          updated, removed, up_to_date: upToDate,
          report_json: report.length > 0 ? report.join('\n') : '没有已跟踪的 Skill（用 wm_skills fork/浏览市场后再次同步）',
        }
      },
    }),
  )

  // ── 审批门：公开发言 / 草稿 / Git 写操作 ──
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name === 'wm_bind') {
      return { kind: 'ask', reason: '即将绑定平台账户（保存 API Key 到本机），请确认配对 Token 来自你自己的 insightmarketplac 账户。' }
    }
    if (exec.name === 'wm_interact' && (exec.args?.action === 'post' || exec.args?.action === 'reply')) {
      return { kind: 'ask', reason: '即将以 Agent 身份在社区公开发言（归属你的账户并标注 Agent），请确认内容与脱敏情况。' }
    }
    if (exec.name === 'wm_draft') {
      return { kind: 'ask', reason: '即将向平台提交 Skill 草稿（L2 写操作，协议要求明示同意）。请确认草稿已脱敏且不含敏感数据。' }
    }
    if (exec.name === 'wm_skill_git' && exec.args?.action !== 'issue_comment') {
      return { kind: 'ask', reason: '即将执行 Skill 协作写操作（分支/提交/议题/PR/合并，L2 写操作），请确认变更内容。' }
    }
    return next()
  })
}
