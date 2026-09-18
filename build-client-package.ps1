# build-client-package.ps1 — 组装可分发的稳卖调研 Agent 安装包
# 产出: dist\wenmai-agent\ (staging) + dist\wenmai-agent-Setup-<版本>.zip
# 打包内容不含 home/ 与 wenmai-config.json（用户本机配置与凭证）。
param(
  [string]$Version = '1.0.0',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $base 'client'
$dist = Join-Path $base 'dist'
$stage = Join-Path $dist 'wenmai-agent'
$zip = Join-Path $dist "wenmai-agent-Setup-$Version.zip"

if (-not (Test-Path $NodeExe)) { throw "node.exe not found: $NodeExe" }
if (-not (Test-Path "$src\runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js")) {
  throw "DSH runtime missing: client\runtime\dsh（先复制 DSH 运行时，见 README 从源码构建）"
}

# 0) 编译两个插件
Push-Location (Join-Path $base 'plugin')
try {
  foreach ($p in @('wenmai-plugin', 'platform-plugin')) {
    & npx esbuild "src\$p.ts" --bundle --platform=node --format=esm --charset=utf8 --outfile="dist\$p.mjs" --external:@deepseek-ai/cordis --external:@deepseek-ai/dsh-tools --log-level=warning
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed for $p`: $LASTEXITCODE" }
  }
} finally { Pop-Location }

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage, "$stage\runtime\node", "$stage\runtime\dsh" -Force | Out-Null

# 1) 顶层文件
foreach ($f in @('启动.bat', 'launch.mjs', 'bootstrap.mjs', 'run-dsh.mjs', '使用说明.md')) {
  Copy-Item (Join-Path $src $f) (Join-Path $stage $f) -Force
}

# 2) 工作区模板（AGENTS.md + 23 个任务 Skill + tasks 说明）
New-Item -ItemType Directory -Path "$stage\workspace\tasks" -Force | Out-Null
Copy-Item (Join-Path $base 'workspace\AGENTS.md') "$stage\workspace\AGENTS.md" -Force
Copy-Item "$src\workspace\tasks\README.md" "$stage\workspace\tasks\README.md" -Force
Copy-Item (Join-Path $base 'workspace\.dsh\skills') "$stage\workspace\.dsh\skills" -Recurse -Force
$skillCount = (Get-ChildItem "$stage\workspace\.dsh\skills" -Directory).Count
if ($skillCount -ne 23) { throw "skill count is $skillCount, expected 23" }

# 3) 便携 Node 运行时
Copy-Item $NodeExe "$stage\runtime\node\node.exe" -Force

# 4) DSH 运行时（裁掉非 win32-x64 原生预编译）
Copy-Item "$src\runtime\dsh\package.json" "$stage\runtime\dsh\package.json" -Force
New-Item -ItemType Directory -Path "$stage\runtime\dsh\plugins" -Force | Out-Null
foreach ($p in @('wenmai-plugin', 'platform-plugin')) {
  Copy-Item "$base\plugin\dist\$p.mjs" "$stage\runtime\dsh\plugins\$p.mjs" -Force
}
$excluded = @('darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'sharp-wasm32')
robocopy "$src\runtime\dsh\node_modules" "$stage\runtime\dsh\node_modules" /E /NFL /NDL /NJH /NJS /NP /XD @excluded | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

# 5) 自检：不含用户数据与密钥；关键文件就位
if (Test-Path "$stage\home") { throw 'staging contains home/ — abort' }
if (Test-Path "$stage\wenmai-config.json") { throw 'staging contains wenmai-config.json — abort' }
if (Test-Path "$stage\wenmai-skills-manifest.json") { throw 'staging contains wenmai-skills-manifest.json — abort' }
$secretHit = Get-ChildItem $stage -Recurse -File -Include *.json,*.yaml,*.yml,*.bat,*.mjs |
  Select-String -Pattern 'dp_[A-Za-z0-9]{16,}|sl_agent_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}' -List
if ($secretHit) { throw "possible secret leak in staging: $($secretHit.Path -join ', ')" }
foreach ($must in @(
    "$stage\runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js",
    "$stage\runtime\dsh\plugins\wenmai-plugin.mjs",
    "$stage\runtime\dsh\plugins\platform-plugin.mjs",
    "$stage\runtime\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js",
    "$stage\runtime\dsh\node_modules\node-pty\prebuilds\win32-x64\conpty.node",
    "$stage\runtime\node\node.exe",
    "$stage\workspace\AGENTS.md"
  )) {
  if (-not (Test-Path $must)) { throw "missing required file: $must" }
}

# 6) 检查 bat 换行符（必须 CRLF）
$batRaw = [System.IO.File]::ReadAllBytes("$stage\启动.bat")
$lfOnly = $false
for ($i = 0; $i -lt $batRaw.Length; $i++) {
  if ($batRaw[$i] -eq 10 -and ($i -eq 0 -or $batRaw[$i - 1] -ne 13)) { $lfOnly = $true; break }
}
if ($lfOnly) { throw '启动.bat contains LF-only line endings — must be CRLF for cmd' }

# 7) 压缩
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal

$unpacked = [math]::Round(((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
$zipped = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "[build] staging : $stage  ($unpacked MB unpacked)"
Write-Host "[build] package : $zip  ($zipped MB)"
Write-Host "[build] skills  : $skillCount 个任务模板；插件：wenmai-platform / platform-client"
Write-Host "[build] 用户需要：安装包 + 平台邀请码（注册自动下发模型与数据服务）"
