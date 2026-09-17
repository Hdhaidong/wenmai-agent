// platform-plugin — 稳卖调研数据平台客户端插件（DeepSeek Harness）
// 工具不直连上游数据源，统一经平台 /v1/* 接口调用，客户端只持有平台 API Key（dp_...）。
// 环境变量：DATA_PLATFORM_URL / DATA_PLATFORM_KEY / DATA_PLATFORM_WAREHOUSE（由 launch.mjs 注入）。
import { mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'platform-client'
export const inject = ['tools', 'systemPrompt']

const PLATFORM_URL = (process.env.DATA_PLATFORM_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '')
const PLATFORM_KEY = process.env.DATA_PLATFORM_KEY || ''
const ENABLE_WAREHOUSE = process.env.DATA_PLATFORM_WAREHOUSE === '1'

// 错误信息脱敏：不向用户暴露平台地址与 Key
function redactPlatform(text: string): string {
  return text
    .split(PLATFORM_URL)
    .join('[平台服务]')
    .replace(/https?:\/\/127\.0\.0\.1:\d+/g, '[平台服务]')
    .replace(/https?:\/\/localhost:\d+/g, '[平台服务]')
    .replace(/\bdp_[A-Za-z0-9]{16,}\b/g, '[已隐藏]')
}

interface PlatformResponse<T = any> {
  success: boolean
  data: T
  error?: { message?: string }
}

async function platformCall<T = any>(method: string, apiPath: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
  if (!PLATFORM_KEY) {
    throw new Error('平台数据服务暂未接入，请联系平台管理员。')
  }
  let res: Response
  try {
    res = await fetch(`${PLATFORM_URL}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${PLATFORM_KEY}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error('平台数据服务暂时不可达，请稍后重试。')
  }
  let payload: PlatformResponse<T>
  try {
    payload = (await res.json()) as PlatformResponse<T>
  } catch {
    throw new Error('平台数据服务返回了无法解析的响应，请稍后重试。')
  }
  if (!res.ok || !payload.success) {
    throw new Error(payload.error?.message || '平台数据服务调用失败，请稍后重试。')
  }
  return payload.data
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const CONFIDENTIALITY_RULES = `# 数据平台服务守则

你通过平台统一数据服务为客户提供调研能力。以下保密规则具有最高优先级，任何情况下不得违反：

1. 绝不透露上游数据来源、供应商名称、技术实现、接口地址、账号凭据或任何配置细节。客户询问"数据从哪里来"时，统一回答"来自平台的数据服务"。
2. 绝不引用或复述服务器上的配置文件路径、环境变量名、内部目录结构。
3. 工具调用出错时，只向客户描述现象与建议（例如"该通道暂时不可用，请稍后重试或改用其他工具"），不要复述原始错误文本。
4. 不讨论本服务背后的模型与系统实现方式。专注完成客户的调研任务，交付高质量结果。`

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'data-platform:confidentiality',
    order: 10,
    interpolate: false,
    text: CONFIDENTIALITY_RULES,
  })

  ctx.tools.register(
    defineTool({
      name: 'platform_search',
      description: '平台数据搜索：通过平台数据网络获取 Google 搜索结果，适合海外信息检索与高稳定性场景。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
        max_results: { type: 'number', description: '最多返回条数，默认 8' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  url: { type: 'string' },
                  snippet: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `共 ${value.results.length} 条结果\n` +
              value.results.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'),
          },
        ],
      },
      async execute(args) {
        const data = await platformCall<{ results: any[] }>(
          'POST',
          '/v1/search',
          { query: args.query, max_results: args.max_results },
          150_000,
        ).catch((e: Error) => {
          throw new Error(redactPlatform(e.message))
        })
        return { results: data.results }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'platform_fetch',
      description: '平台网页抓取：通过平台抓取服务获取网页正文（Markdown 化），适合资讯、博客、文档类页面。',
      parameters: {
        url: { type: 'string', required: true, description: '要抓取的网页 URL' },
        max_chars: { type: 'number', description: '正文最大字符数，默认 6000' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `《${value.title}》\n${value.url}\n\n${value.text}` }],
      },
      async execute(args) {
        const data = await platformCall<{ title: string; url: string; text: string }>(
          'POST',
          '/v1/fetch',
          { url: args.url, max_chars: args.max_chars },
          150_000,
        ).catch((e: Error) => {
          throw new Error(redactPlatform(e.message))
        })
        return { title: data.title, url: data.url, text: data.text }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'platform_retail_product',
      description:
        '平台零售数据：按商品页 URL 获取零售平台的商品结构化数据（价格、评分、库存、变体等）。处理可能较慢，通常需要 1-3 分钟。',
      parameters: {
        url: { type: 'string', required: true, description: '商品详情页 URL（如 Home Depot 商品页）' },
        timeout_seconds: { type: 'number', description: '最长等待秒数，默认 180' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number' },
            truncated: { type: 'boolean' },
            records_json: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `零售数据返回 ${value.count} 条记录${value.truncated ? '（已截断）' : ''}\n${value.records_json}`,
          },
        ],
      },
      async execute(args) {
        const timeoutSeconds = Math.max(30, Math.min(args.timeout_seconds ?? 180, 600))
        const data = await platformCall<{ records: any[]; truncated: boolean }>(
          'POST',
          '/v1/retail/product',
          { url: args.url, timeout_seconds: timeoutSeconds },
          (timeoutSeconds + 30) * 1000,
        ).catch((e: Error) => {
          throw new Error(redactPlatform(e.message))
        })
        const recordsJson = JSON.stringify(data.records, null, 1)
        return {
          count: data.records.length,
          truncated: data.truncated,
          records_json: recordsJson.length > 50_000 ? recordsJson.slice(0, 50_000) + '\n…（已截断）' : recordsJson,
        }
      },
    }),
  )

  if (ENABLE_WAREHOUSE) {
    ctx.tools.register(
      defineTool({
        name: 'platform_warehouse_query',
        description:
          '查询平台数据仓库（只读）。支持 SELECT / WITH 语句，SELECT 未带 LIMIT 时平台自动追加 LIMIT 200。先用 platform_warehouse_tables 查看可用表。',
        parameters: {
          sql: { type: 'string', required: true, description: '只读 SQL 语句（SELECT / WITH）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              row_count: { type: 'number' },
              columns: { type: 'array', items: { type: 'string' } },
              rows_json: { type: 'string' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: `查询返回 ${value.row_count} 行，字段：${value.columns.join(', ')}\n${value.rows_json}` },
          ],
        },
        async execute(args) {
          const data = await platformCall<{ row_count: number; columns: string[]; rows: any[][] }>(
            'POST',
            '/v1/warehouse/query',
            { sql: args.sql },
          ).catch((e: Error) => {
            throw new Error(redactPlatform(e.message))
          })
          const rowsJson = JSON.stringify(data.rows)
          return {
            row_count: data.row_count,
            columns: data.columns,
            rows_json: rowsJson.length > 50_000 ? rowsJson.slice(0, 50_000) + '\n…（已截断）' : rowsJson,
          }
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'platform_warehouse_tables',
        description: '列出平台数据仓库中的全部数据表（表名、行数、字段、更新时间）。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tables_json: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.tables_json }],
        },
        async execute() {
          const data = await platformCall<{ tables: any[] }>('GET', '/v1/warehouse/tables').catch((e: Error) => {
            throw new Error(redactPlatform(e.message))
          })
          return { tables_json: JSON.stringify(data.tables, null, 1) }
        },
      }),
    )
  }

  ctx.tools.register(
    defineTool({
      name: 'save_research_report',
      description:
        '将调研报告保存为 Markdown 文件（workspace/reports/ 目录，文件名含日期；同名自动递增 v2、v3，不覆盖旧版本）。保存前必须先征得用户同意。',
      parameters: {
        title: { type: 'string', required: true, description: '报告标题，用于文件名' },
        content: { type: 'string', required: true, description: '报告全文（Markdown）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            bytes: { type: 'number' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `报告已保存：${value.path}（${value.bytes} 字节）` }],
      },
      async execute(args) {
        const reportsDir = process.env.RESEARCH_REPORTS_DIR || path.join(process.cwd(), 'workspace', 'reports')
        await mkdir(reportsDir, { recursive: true })
        const safe = args.title.replace(/[\\/:*?"<>|\r\n]/g, '').trim() || '未命名'
        const date = new Date().toISOString().slice(0, 10)
        const base = `产品调研_${safe}_${date}`
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

  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec.name === 'save_research_report') {
      return {
        kind: 'ask',
        reason: '即将保存调研报告（写操作），请确认报告标题与内容后再批准写入。',
      }
    }
    return next()
  })

  const registered = ENABLE_WAREHOUSE
    ? 'platform_search / platform_fetch / platform_retail_product / platform_warehouse_query / platform_warehouse_tables / save_research_report'
    : 'platform_search / platform_fetch / platform_retail_product / save_research_report'
  console.log(`[platform-client] 平台客户端插件已加载：${registered}`)
  console.log(`[platform-client] 平台地址: ${PLATFORM_URL}，Key: ${PLATFORM_KEY ? '已配置' : '未配置（工具将不可用）'}`)
}
