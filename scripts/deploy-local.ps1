#requires -Version 5.1
<#
.SYNOPSIS
    One-shot, repeatable local deployment for AGENT HQ.

.DESCRIPTION
    Aligns with DEPLOY.md:
      1. clone (or fetch + checkout main)
      2. npm ci
      3. node scripts\real-snapshot.js
      4. npm run build
      5. start a temporary static server for <TargetDir>\dist
      6. run scripts\smoke-8901.js against the chosen port

    Safe defaults:
      - never stops a running service unless -Stop is passed
      - refuses to take over a port owned by an unknown process
      - reuses its own already-running service on repeat runs
      - -DryRun prints commands only

.PARAMETER TargetDir
    Deployment directory. Relative paths are resolved from the repository root.
    Default: ..\agent-hq-local

.PARAMETER Port
    Static server port. Default: 8905

.PARAMETER RepoUrl
    Git repository to clone. Default: https://github.com/az20313/agent-hq.git

.PARAMETER SkipInstall
    Skip npm ci.

.PARAMETER SkipSnapshot
    Skip node scripts\real-snapshot.js.

.PARAMETER SkipBuild
    Skip npm run build.

.PARAMETER DryRun
    Print the commands that would run, then exit. Nothing is cloned, installed,
    built, written, or started.

.PARAMETER Stop
    Stop the service previously started by this script for -Port, then exit.

.EXAMPLE
    .\scripts\deploy-local.ps1 -TargetDir ..\agent-hq-local -Port 8905

.EXAMPLE
    .\scripts\deploy-local.ps1 -TargetDir D:\tmp\agent-hq-deploytest -Port 8906 -DryRun

.EXAMPLE
    .\scripts\deploy-local.ps1 -Port 8906 -Stop
#>
[CmdletBinding()]
param(
    [string]$TargetDir = '..\agent-hq-local',
    [ValidateRange(1, 65535)]
    [int]$Port = 8905,
    [string]$RepoUrl = 'https://github.com/az20313/agent-hq.git',
    [switch]$SkipInstall,
    [switch]$SkipSnapshot,
    [switch]$SkipBuild,
    [switch]$DryRun,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not [IO.Path]::IsPathRooted($TargetDir)) {
    $TargetDir = Join-Path $RepoRoot $TargetDir
}
$TargetDir = [IO.Path]::GetFullPath($TargetDir)
$DistDir = Join-Path $TargetDir 'dist'
$StateDir = Join-Path $env:LOCALAPPDATA 'agent-hq-deploy'
$StateFile = Join-Path $StateDir ("state-{0}.json" -f $Port)
$ServerScript = Join-Path $env:TEMP ("agent-hq-static-{0}.mjs" -f $Port)
$ServerOut = Join-Path $env:TEMP ("agent-hq-static-{0}.out.log" -f $Port)
$ServerErr = Join-Path $env:TEMP ("agent-hq-static-{0}.err.log" -f $Port)
$BaseUrl = "http://127.0.0.1:$Port"

$script:StepTimes = New-Object System.Collections.Generic.List[object]

# ---------------------------------------------------------------- output
function Write-Info([string]$Message) {
    Write-Host "[deploy] $Message" -ForegroundColor Cyan
}
function Write-Warn([string]$Message) {
    Write-Host "[deploy][WARN] $Message" -ForegroundColor Yellow
}
function Write-Err([string]$Message) {
    Write-Host "[deploy][ERROR] $Message" -ForegroundColor Red
}
function Format-Command([string]$Exe, [string[]]$Arguments) {
    $quoted = foreach ($a in $Arguments) {
        if ($a -match '[\s"]') { '"' + ($a -replace '"', '\"') + '"' } else { $a }
    }
    "{0} {1}" -f $Exe, ($quoted -join ' ')
}
function Add-Timing([string]$Step, [double]$Seconds) {
    $script:StepTimes.Add([pscustomobject]@{ Step = $Step; Seconds = [math]::Round($Seconds, 2) })
}

# ---------------------------------------------------------------- tools
function Resolve-Tool([string]$Name, [string]$Fallback) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if ($Fallback) {
        $cmd = Get-Command $Fallback -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

$nodeExe = Resolve-Tool 'node' 'node.exe'
$gitExe = Resolve-Tool 'git' 'git.exe'
$npmExe = Resolve-Tool 'npm.cmd' 'npm'

if (-not $nodeExe) { Write-Err 'node not found in PATH'; exit 1 }
if (-not $gitExe) { Write-Err 'git not found in PATH'; exit 1 }
if (-not $npmExe -and -not ($SkipInstall -and $SkipBuild)) {
    Write-Err 'npm not found in PATH (required unless -SkipInstall and -SkipBuild are both used)'
    exit 1
}

if (-not $DryRun) {
    $nodeVersion = (& $nodeExe -p 'process.versions.node').Trim()
    $v = $nodeVersion.Split('.')
    $major = [int]$v[0]
    $minor = [int]$v[1]
    if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 11)) {
        Write-Err "Node.js >= 20.11 is required (found $nodeVersion)"
        exit 1
    }
    Write-Info "Node $nodeVersion"
}

# ---------------------------------------------------------------- helpers
function Invoke-Native {
    param(
        [string]$Label,
        [string]$Exe,
        [string[]]$Arguments,
        [string]$WorkDir = $RepoRoot
    )
    Write-Host ''
    Write-Host "== $Label ==" -ForegroundColor Magenta
    Write-Host "  $(Format-Command $Exe $Arguments)" -ForegroundColor DarkGray
    if ($DryRun) {
        Write-Host '  (dry-run: not executed)' -ForegroundColor DarkGray
        return
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $WorkDir
    try {
        & $Exe @Arguments
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
        $sw.Stop()
    }
    Add-Timing $Label $sw.Elapsed.TotalSeconds
    if ($null -ne $code -and $code -ne 0) {
        throw "$Label failed with exit code $code"
    }
}

function Test-PortOpen {
    param([int]$PortNumber)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($iar)
        return $true
    }
    catch { return $false }
    finally { $client.Close() }
}

function Get-PortOwner {
    param([int]$PortNumber)
    $conn = Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return $null
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if (-not $ProcessId) { return $false }
    try {
        Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
        return $true
    }
    catch { return $false }
}

function Read-ServiceState {
    if (-not (Test-Path $StateFile)) { return $null }
    try { return Get-Content -Path $StateFile -Raw | ConvertFrom-Json }
    catch { return $null }
}

function Save-ServiceState {
    param($State)
    if (-not (Test-Path $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }
    $State | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding UTF8
}

function Stop-OwnedService {
    param($State)
    if (-not $State) { return $false }
    if (Test-ProcessAlive ([int]$State.pid)) {
        Stop-Process -Id ([int]$State.pid) -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20; $i++) {
            if (-not (Test-PortOpen $Port)) { break }
            Start-Sleep -Milliseconds 250
        }
        Write-Info ("Stopped PID {0}" -f $State.pid)
        return $true
    }
    return $false
}

# ---------------------------------------------------------------- -Stop
if ($Stop) {
    $state = Read-ServiceState
    if (-not $state) {
        Write-Err "No service state found for port $Port ($StateFile)"
        exit 1
    }
    if (Test-PortOpen $Port) {
        $owner = Get-PortOwner $Port
        if ($owner -and $owner -ne [int]$state.pid) {
            Write-Err "Port $Port is owned by PID $owner, not the PID $($state.pid) recorded for this deployment"
            exit 1
        }
    }
    $stopped = Stop-OwnedService $state
    if (-not $stopped) {
        Write-Info "Process $($state.pid) was not running"
    }
    Remove-Item -Path $StateFile -Force -ErrorAction SilentlyContinue
    if (Test-PortOpen $Port) {
        Write-Warn "Port $Port is still accepting connections"
        exit 1
    }
    Write-Info "Port $Port is free"
    exit 0
}

# ---------------------------------------------------------------- header
Write-Host ''
Write-Host 'AGENT HQ - local deployment' -ForegroundColor White
Write-Host "  target : $TargetDir"
Write-Host "  port   : $Port ($BaseUrl)"
Write-Host "  repo   : $RepoUrl"
Write-Host ("  flags  : install={0} snapshot={1} build={2} dryrun={3}" -f `
        (-not $SkipInstall), (-not $SkipSnapshot), (-not $SkipBuild), [bool]$DryRun)
if ($DryRun) {
    Write-Host '  mode   : DRY RUN (commands only, no side effects)' -ForegroundColor Yellow
}

try {
    # ------------------------------------------------------------ port preflight
    if (-not $DryRun -and (Test-PortOpen $Port)) {
        $preState = Read-ServiceState
        $preOwned = $preState -and
            (Test-ProcessAlive ([int]$preState.pid)) -and
            ([int]$preState.port -eq $Port) -and
            (([string]$preState.targetDir).TrimEnd('\') -eq $TargetDir.TrimEnd('\'))
        if (-not $preOwned) {
            $preOwner = Get-PortOwner $Port
            $ownerText = if ($preOwner) { "PID $preOwner" } else { 'unknown PID' }
            throw "Port $Port is already in use ($ownerText). Use a different -Port or stop the process first."
        }
        Write-Info "Port $Port is already owned by this deployment (PID $($preState.pid)); it will be reused"
    }

    # ------------------------------------------------------------ 1. repo
    $cloneOrUpdateLabel = '1/6 clone/fetch repository'
    if (-not (Test-Path $TargetDir)) {
        Invoke-Native $cloneOrUpdateLabel $gitExe @('clone', $RepoUrl, $TargetDir) $RepoRoot
        Invoke-Native '1b/6 checkout main' $gitExe @('-C', $TargetDir, 'checkout', 'main') $RepoRoot
    }
    else {
        if (-not (Test-Path (Join-Path $TargetDir '.git'))) {
            throw "Target directory exists but is not a git repository: $TargetDir"
        }
        Invoke-Native $cloneOrUpdateLabel $gitExe @('-C', $TargetDir, 'fetch', 'origin', 'main') $RepoRoot
        Invoke-Native '1b/6 checkout main' $gitExe @('-C', $TargetDir, 'checkout', 'main') $RepoRoot

        $dirty = @()
        if (-not $DryRun) {
            $dirty = @(& $gitExe -C $TargetDir status --porcelain --untracked-files=no)
            if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
        }
        if ($dirty.Count -eq 0) {
            Invoke-Native '1c/6 fast-forward main' $gitExe @('-C', $TargetDir, 'merge', '--ff-only', 'origin/main') $RepoRoot
        }
        elseif ($dirty.Count -eq 1 -and $dirty[0] -match 'public/snapshot\.json$' -and -not $SkipSnapshot) {
            Write-Warn 'public/snapshot.json is modified (generated); restoring it before fast-forward'
            Invoke-Native '1c/6 restore generated snapshot' $gitExe @('-C', $TargetDir, 'checkout', '--', 'public/snapshot.json') $RepoRoot
            Invoke-Native '1d/6 fast-forward main' $gitExe @('-C', $TargetDir, 'merge', '--ff-only', 'origin/main') $RepoRoot
        }
        else {
            Write-Warn 'Working tree has local changes; skipping fast-forward and deploying the current HEAD'
            Write-Warn ('Changed paths: ' + ($dirty -join ', '))
        }
    }

    # ------------------------------------------------------------ 2. install
    if (-not $SkipInstall) {
        Invoke-Native '2/6 npm ci' $npmExe @('ci') $TargetDir
    }
    else {
        Write-Info 'Skipping npm ci (-SkipInstall)'
    }

    # ------------------------------------------------------------ 3. snapshot
    if (-not $SkipSnapshot) {
        Invoke-Native '3/6 generate snapshot' $nodeExe @('scripts\real-snapshot.js') $TargetDir
    }
    else {
        Write-Info 'Skipping snapshot generation (-SkipSnapshot)'
    }

    # ------------------------------------------------------------ 4. build
    if (-not $SkipBuild) {
        Invoke-Native '4/6 build' $npmExe @('run', 'build') $TargetDir
    }
    else {
        Write-Info 'Skipping build (-SkipBuild)'
    }

    # ------------------------------------------------------------ 5. serve
    Write-Host ''
    Write-Host '== 5/6 static server ==' -ForegroundColor Magenta

    $state = Read-ServiceState
    $servicePid = $null
    $startedNew = $false

    if (-not $DryRun -and (Test-PortOpen $Port)) {
        $owner = Get-PortOwner $Port
        if ($state -and (Test-ProcessAlive ([int]$state.pid)) -and
            [int]$state.port -eq $Port -and
            (([string]$state.targetDir).TrimEnd('\') -eq $TargetDir.TrimEnd('\'))) {
            $servicePid = [int]$state.pid
            Write-Info "Port $Port already served by this deployment (PID $servicePid); reusing it"
        }
        else {
            $ownerText = if ($owner) { "PID $owner" } else { 'unknown PID' }
            throw "Port $Port is already in use ($ownerText). Use a different -Port or stop the process first."
        }
    }
    else {
        if (-not $DryRun -and $state) {
            if (Test-ProcessAlive ([int]$state.pid)) {
                Write-Warn "Recorded service PID $($state.pid) is alive but not listening; stopping it"
                Stop-OwnedService $state | Out-Null
            }
            Remove-Item -Path $StateFile -Force -ErrorAction SilentlyContinue
        }

        $rootJson = (Join-Path $TargetDir 'dist') | ConvertTo-Json -Compress
        $serverSource = @'
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = __ROOT__;
const HOST = "127.0.0.1";
const PORT = __PORT__;
const BASE = `http://${HOST}:${PORT}`;

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8"
};

function send(req, res, code, type, body) {
  const headers = { "Content-Type": type, ...SEC_HEADERS };
  if (body) headers["Content-Length"] = Buffer.byteLength(body);
  res.writeHead(code, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

const server = http.createServer((req, res) => {
  try {
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) {
      send(req, res, 403, "text/plain; charset=utf-8", "Forbidden host");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(req, res, 405, "text/plain; charset=utf-8", "Method Not Allowed");
      return;
    }

    const url = new URL(req.url, BASE);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      send(req, res, 400, "text/plain; charset=utf-8", "Bad Request");
      return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";
    const filePath = path.normalize(path.join(ROOT, pathname));
    const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) {
      send(req, res, 403, "text/plain; charset=utf-8", "Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        const hasExt = path.extname(pathname) !== "";
        if (hasExt) {
          send(req, res, 404, "text/plain; charset=utf-8", "Not Found");
          return;
        }
        fs.readFile(path.join(ROOT, "index.html"), (e2, html) => {
          if (e2) return send(req, res, 404, "text/plain; charset=utf-8", "Not Found");
          send(req, res, 200, MIME[".html"], html);
        });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      send(req, res, 200, MIME[ext] || "application/octet-stream", data);
    });
  } catch {
    send(req, res, 500, "text/plain; charset=utf-8", "Internal Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`static server listening on ${BASE} serving ${ROOT} (pid ${process.pid})`);
});
'@
        $serverSource = $serverSource.Replace('__ROOT__', $rootJson).Replace('__PORT__', [string]$Port)

        Write-Host "  write server: $ServerScript" -ForegroundColor DarkGray
        Write-Host "  node `"$ServerScript`"" -ForegroundColor DarkGray
        if ($DryRun) {
            Write-Host '  (dry-run: not started)' -ForegroundColor DarkGray
        }
        else {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            Set-Content -Path $ServerScript -Value $serverSource -Encoding UTF8
            $proc = Start-Process -FilePath $nodeExe `
                -ArgumentList @('"' + $ServerScript + '"') `
                -WorkingDirectory $TargetDir `
                -WindowStyle Hidden `
                -RedirectStandardOutput $ServerOut `
                -RedirectStandardError $ServerErr `
                -PassThru

            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline) {
                if (Test-PortOpen $Port) { break }
                $proc.Refresh()
                if ($proc.HasExited) { break }
                Start-Sleep -Milliseconds 250
            }
            $sw.Stop()
            Add-Timing '5/6 start server' $sw.Elapsed.TotalSeconds

            if (-not (Test-PortOpen $Port)) {
                $errText = ''
                if (Test-Path $ServerErr) { $errText = (Get-Content -Path $ServerErr -Raw).Trim() }
                throw "Static server did not start on port $Port. $errText"
            }
            $servicePid = $proc.Id
            $startedNew = $true
            Write-Info "Static server started (PID $servicePid)"

            Save-ServiceState ([pscustomobject]@{
                    pid          = $servicePid
                    port         = $Port
                    targetDir    = $TargetDir
                    serverScript = $ServerScript
                    url          = $BaseUrl
                    startedAt    = (Get-Date).ToString('o')
                })
        }
    }

    # ------------------------------------------------------------ 6. smoke
    if ($DryRun) {
        Write-Host ''
        Write-Host '== 6/6 smoke test ==' -ForegroundColor Magenta
        Write-Host "  $(Format-Command $nodeExe @('scripts\smoke-8901.js', '--url', $BaseUrl))" -ForegroundColor DarkGray
        Write-Host '  (dry-run: not executed)' -ForegroundColor DarkGray
    }
    else {
        Write-Host ''
        Write-Host '== 6/6 smoke test ==' -ForegroundColor Magenta
        Write-Host "  $(Format-Command $nodeExe @('scripts\smoke-8901.js', '--url', $BaseUrl))" -ForegroundColor DarkGray
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Push-Location $TargetDir
        try {
            & $nodeExe 'scripts\smoke-8901.js' '--url' $BaseUrl
            $smokeCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
            $sw.Stop()
        }
        Add-Timing '6/6 smoke' $sw.Elapsed.TotalSeconds
        if ($smokeCode -ne 0) {
            throw "Smoke test failed with exit code $smokeCode (service left running on $BaseUrl)"
        }
    }

    # ------------------------------------------------------------ verify
    if (-not $DryRun) {
        Write-Host ''
        Write-Host '== HTTP verification ==' -ForegroundColor Magenta
        $homeResp = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 15
        $snapResp = Invoke-WebRequest -Uri "$BaseUrl/snapshot.json" -UseBasicParsing -TimeoutSec 15
        $homeType = [string]$homeResp.Headers['Content-Type']
        $snapType = [string]$snapResp.Headers['Content-Type']
        $snapJson = $snapResp.Content | ConvertFrom-Json

        Write-Host ("  /              {0}  {1}  {2} B" -f $homeResp.StatusCode, $homeType, $homeResp.RawContentLength)
        Write-Host ("  /snapshot.json {0}  {1}  {2} B" -f $snapResp.StatusCode, $snapType, $snapResp.RawContentLength)

        if ($homeResp.StatusCode -ne 200 -or $homeType -notmatch '^text/html') {
            throw "Home page check failed: HTTP $($homeResp.StatusCode) $homeType"
        }
        if ($snapResp.StatusCode -ne 200 -or $snapType -notmatch '^application/json') {
            throw "Snapshot check failed: HTTP $($snapResp.StatusCode) $snapType (expected application/json)"
        }
        Write-Info ("Snapshot: {0} agents / {1} tasks" -f @($snapJson.agents).Count, @($snapJson.tasks).Count)
    }

    # ------------------------------------------------------------ summary
    Write-Host ''
    Write-Host '==== deployment summary ====' -ForegroundColor Green
    Write-Host "  target : $TargetDir"
    Write-Host "  port   : $Port ($BaseUrl)"
    if (-not $DryRun) {
        $headSha = (& $gitExe -C $TargetDir rev-parse --short HEAD).Trim()
        $headSubject = (& $gitExe -C $TargetDir log -1 --format=%s).Trim()
        Write-Host "  HEAD   : $headSha $headSubject"
    }
    Write-Host '  steps  :'
    foreach ($t in $script:StepTimes) {
        Write-Host ("    {0,-24} {1,7:N2} s" -f $t.Step, $t.Seconds)
    }
    if ($DryRun) {
        Write-Host '  artifacts : (dry-run)'
        Write-Host '  service   : (dry-run)'
        Write-Host ''
        Write-Info 'Dry run complete; nothing was executed.'
        exit 0
    }

    $indexPath = Join-Path $DistDir 'index.html'
    $snapPath = Join-Path $DistDir 'snapshot.json'
    Write-Host '  artifacts :'
    if (Test-Path $indexPath) {
        Write-Host ("    dist\index.html    {0,12:N0} B" -f (Get-Item $indexPath).Length)
    }
    if (Test-Path $snapPath) {
        Write-Host ("    dist\snapshot.json {0,12:N0} B" -f (Get-Item $snapPath).Length)
    }
    Write-Host "  service   : PID $servicePid  $BaseUrl/  ($(if ($startedNew) { 'started now' } else { 'reused' }))"
    Write-Host "  stop with : .\scripts\deploy-local.ps1 -Port $Port -Stop"
    Write-Host ''
    Write-Info 'Deployment OK.'
    exit 0
}
catch {
    Write-Host ''
    Write-Err $_.Exception.Message
    if ($script:StepTimes.Count -gt 0) {
        Write-Host '  completed steps:' -ForegroundColor DarkGray
        foreach ($t in $script:StepTimes) {
            Write-Host ("    {0,-24} {1,7:N2} s" -f $t.Step, $t.Seconds) -ForegroundColor DarkGray
        }
    }
    exit 1
}
