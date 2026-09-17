#!/usr/bin/env node
// run-dsh.mjs — wenmai 客户端启动器：注册 wenmai-platform + platform-client + walmart-ads 三插件并启动 DSH
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const pluginsDir = path.join(ROOT, 'runtime', 'dsh', 'plugins')
const ymlPath = path.join(pluginsDir, 'cordis-wenmai.yml')

const pluginFile = (name) =>
  'file:///' + encodeURI(path.join(pluginsDir, name).replaceAll('\\', '/'))

await mkdir(pluginsDir, { recursive: true })
await writeFile(
  ymlPath,
  `- insert:\n` +
    `  - id: wenmai-platform\n    name: "${pluginFile('wenmai-plugin.mjs')}"\n` +
    `  - id: platform-client\n    name: "${pluginFile('platform-plugin.mjs')}"\n` +
    `  - id: walmart-ads\n    name: "${pluginFile('walmart-plugin.mjs')}"\n`,
  'utf8',
)

const port = process.env.DSH_PORT || '3220'
const args = ['web', '--patch', ymlPath, '--port', port]
if (process.env.DSH_NO_OPEN === '1') args.push('--no-open')
args.push(...process.argv.slice(2))

process.argv = [process.argv[0], 'dsh', ...args]
const { runCli } = await import('./runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
await runCli()
