import { readFileSync, writeFileSync } from 'node:fs'
const src = readFileSync('D:/Temp/client-demo/runtime/dsh/plugins/platform-plugin.mjs', 'utf8')
const out = src.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
writeFileSync('D:/Projects/wenmai-client/plugin/dist/platform-plugin.mjs', out, 'utf8')
console.log('in:', src.length, 'out:', out.length, 'changed:', out !== src)
