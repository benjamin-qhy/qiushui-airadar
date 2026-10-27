$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $IsWindows) {
  throw 'Windows Service acceptance must run on Windows'
}

$acceptRoot = Join-Path $env:ProgramData "QiushuiAI/AIRadarAcceptance-$env:GITHUB_RUN_ID"
$packRoot = Join-Path $acceptRoot 'pack'
$installRoot = Join-Path $acceptRoot 'program'
$dataRoot = Join-Path $acceptRoot 'data'
$secretFile = Join-Path $acceptRoot 'secrets.env'
$previousSource = Join-Path $acceptRoot 'previous-release'
New-Item -ItemType Directory -Force -Path $packRoot, $dataRoot, $previousSource | Out-Null
Set-Content -Path $secretFile -Value '' -NoNewline

$env:QIUSHUI_AIRADAR_DATA_ROOT = $dataRoot
$env:QIUSHUI_AIRADAR_SECRET_FILE = $secretFile
$serviceName = 'QiushuiAIAIRadar'
$port = 43110

function Wait-Health {
  param([int]$Attempts = 40)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      if ($response.status -eq 'ready') { return }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw 'Windows service health endpoint did not become ready'
}

function Find-AiradarNodeProcess {
  param([int]$ExceptPid = 0)
  return Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -like '*service run*' -and
      $_.ProcessId -ne $ExceptPid
    } |
    Select-Object -First 1
}

$previousReleaseCommit = 'ae6d470c04f1b8e509ed40bfe155d6718c4414a9'
$archive = Join-Path $acceptRoot 'previous-release.tar'
git archive --format=tar "--output=$archive" $previousReleaseCommit
tar -xf $archive -C $previousSource
Push-Location $previousSource
try {
  pnpm install --frozen-lockfile | Out-Host
  pnpm build | Out-Host
} finally {
  Pop-Location
}
$previousCli = Join-Path $previousSource 'apps/cli/dist/cli.js'
$previousProcess = Start-Process -FilePath 'node' -ArgumentList @(
  $previousCli, 'service', '--host', '127.0.0.1', '--port', $port
) -PassThru -NoNewWindow
try {
  Wait-Health
} finally {
  if (-not $previousProcess.HasExited) {
    Stop-Process -Id $previousProcess.Id -Force
  }
  $previousProcess.WaitForExit()
}
if ((Get-ChildItem -Path (Join-Path $dataRoot 'sources') -File).Count -lt 36) {
  throw 'Previous release did not create real authority records'
}
$marker = Join-Path $dataRoot 'upgrade-preservation.md'
Set-Content -Path $marker -Value '# must survive program upgrade'

pnpm --filter '@qiushui-airadar/cli' pack --pack-destination $packRoot | Out-Host
$tarball = Get-ChildItem -Path $packRoot -Filter '*-0.1.0.tgz' | Select-Object -First 1
if (-not $tarball) { throw 'CLI package tarball was not produced' }
npm install --prefix $installRoot --ignore-scripts $tarball.FullName | Out-Host
if ((Get-Content -Raw $marker).Trim() -ne '# must survive program upgrade') {
  throw 'Old-to-new program upgrade changed business data'
}
$cliPath = Join-Path $installRoot 'node_modules/@qiushui-airadar/cli/dist/cli.js'

try {
  node $cliPath service install --host 127.0.0.1 --port $port | Out-Host
  Wait-Health
  $service = Get-Service -Name $serviceName
  if ($service.Status -ne 'Running' -or $service.StartType -ne 'Automatic') {
    throw "Unexpected installed service state: $($service.Status) / $($service.StartType)"
  }

  $before = Find-AiradarNodeProcess
  if (-not $before) { throw 'Unable to find managed Node process' }
  Stop-Process -Id $before.ProcessId -Force
  $after = $null
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    $after = Find-AiradarNodeProcess -ExceptPid $before.ProcessId
    if ($after) { break }
  }
  if (-not $after) { throw 'Windows service did not restart after a crash' }
  Wait-Health

  node $cliPath service stop | Out-Host
  $stopped = node $cliPath service status | ConvertFrom-Json
  if ($stopped.status -ne 'stopped') { throw 'Windows service did not stop' }
  node $cliPath service start | Out-Host
  Wait-Health

  node $cliPath service restart | Out-Host
  Wait-Health
  if ((Get-Content -Raw $marker).Trim() -ne '# must survive program upgrade') {
    throw 'Program upgrade changed business data'
  }

  Write-Host "Windows service acceptance passed; crash PID $($before.ProcessId) -> $($after.ProcessId)"
} finally {
  node $cliPath service uninstall | Out-Host
}
