# Nidum Local launcher for Windows.
# EXPERIMENTAL and UNVERIFIED: written for Windows PowerShell 5.1 and PowerShell 7, but never
# parsed or run on a real Windows machine (the build machine has no pwsh). Mirrors the macOS
# launcher in launchers/lib/nidum-launcher.sh; keep the two in step.
#
# This file is ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# so the glyphs are built from code points.
#
# Environment (all optional):
#   NIDUM_HOME           state and logs folder              default %USERPROFILE%\.nidum-local
#   NIDUM_APP_ROOT       folder containing src\server.js    default two levels above this file
#   NIDUM_SERVICE_TASK   Portless scheduled task name        default "Portless Proxy" (empty: skip)
#   NIDUM_DRY_RUN=1      print every action instead of doing it
#   NIDUM_START_TIMEOUT  seconds to wait for the dashboard  default 10 (1-300)
#   NIDUM_SERVICE_WAIT   seconds to wait for the startup task to answer  default 5 (1-60)
#
# Exit codes: 0 done; 3 failure already shown on the failure screen (the .cmd then doesn't pause
# again); anything else means PowerShell itself failed, and the .cmd pauses so it can be read.
#   PORTLESS_STATE_DIR   Portless state folder, read only   default %USERPROFILE%\.portless

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2

$MinNode = 18
$MinNodeForNpm = 24
$MinPortless = '0.15.6'
$DefaultPort = 47800

$Dry = $false
if ($env:NIDUM_DRY_RUN -and (@('0', 'false', 'no') -notcontains $env:NIDUM_DRY_RUN)) { $Dry = $true }

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$GlyphOk = [string][char]0x2713
$GlyphWait = [string][char]0x2026
$GlyphFail = [string][char]0x2717
$GlyphArrow = [string][char]0x2192
$Dash = [string][char]0x2014

$UseColor = $true
if ($env:NO_COLOR) { $UseColor = $false }

# ------------------------------------------------------------------ paths

$UserHome = $env:USERPROFILE
if (-not $UserHome) { $UserHome = $HOME }
$NidumHome = $env:NIDUM_HOME
if (-not $NidumHome) { $NidumHome = Join-Path $UserHome '.nidum-local' }
$env:NIDUM_HOME = $NidumHome

if ($env:NIDUM_APP_ROOT) {
    $Root = $env:NIDUM_APP_ROOT
} else {
    $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$SessionFile = Join-Path $NidumHome 'session.json'
$StateFile = Join-Path $NidumHome 'state.json'
$ServerLog = Join-Path $NidumHome 'server.log'
$LogFile = $null

$ServiceTask = 'Portless Proxy'
if (Test-Path Env:NIDUM_SERVICE_TASK) { $ServiceTask = $env:NIDUM_SERVICE_TASK }

if ($Dry) {
    if (Test-Path -LiteralPath $NidumHome -PathType Container) { $LogFile = Join-Path $NidumHome 'launcher.log' }
} else {
    try {
        New-Item -ItemType Directory -Force -Path $NidumHome | Out-Null
        $LogFile = Join-Path $NidumHome 'launcher.log'
    } catch { $LogFile = $null }
}

# ------------------------------------------------------------------ output

function Write-NidumLog([string]$Text) {
    if (-not $script:LogFile) { return }
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        Add-Content -LiteralPath $script:LogFile -Value "$stamp $Text" -Encoding UTF8
    } catch { }
}

function Write-Step([string]$Color, [string]$Glyph, [string]$Text) {
    Write-Host '  ' -NoNewline
    if ($script:UseColor -and $Color) { Write-Host $Glyph -ForegroundColor $Color -NoNewline } else { Write-Host $Glyph -NoNewline }
    Write-Host " $Text"
    Write-NidumLog "$Glyph $Text"
}
function Write-Ok([string]$Text) { Write-Step 'Green' $script:GlyphOk $Text }
function Write-Wait([string]$Text) { Write-Step 'Cyan' $script:GlyphWait $Text }
function Write-Warn([string]$Text) { Write-Step 'Yellow' '!' $Text }
function Write-Arrow([string]$Text) { Write-Step '' $script:GlyphArrow $Text }
function Write-Note([string]$Text) { Write-Host "    $Text"; Write-NidumLog "  $Text" }

function Get-PrettyPath([string]$Path) {
    if ($script:UserHome -and $Path.StartsWith($script:UserHome, [System.StringComparison]::OrdinalIgnoreCase)) {
        return '~' + $Path.Substring($script:UserHome.Length)
    }
    return $Path
}

# Consent prompt. Enter accepts the default (Yes). No input at all counts as No.
function Ask-Yes([string]$Question, [string]$Action) {
    Write-Host '  ' -NoNewline
    if ($script:UseColor) { Write-Host '?' -ForegroundColor Yellow -NoNewline } else { Write-Host '?' -NoNewline }
    Write-Host " $Question"
    Write-Host "    $Action " -NoNewline
    Write-NidumLog "? $Question $Action"
    if ($script:Dry) {
        Write-Host '(dry run: answering Y)'
        return $true
    }
    $answer = $null
    try { $answer = [Console]::In.ReadLine() } catch { $answer = $null }
    if ($null -eq $answer) { Write-Host ''; Write-NidumLog 'answer: none, treated as No'; return $false }
    $answer = $answer.Trim()
    if ($answer -eq '' -or $answer -match '^(?i)(y|yes)$') { Write-NidumLog 'answer: yes'; return $true }
    Write-NidumLog "answer: no ($answer)"
    return $false
}

# Failure screen: What happened / What to try / Details, then wait for a key.
function Stop-WithFailure([string]$Title, [string]$Happened, [string]$Try) {
    if ($script:LogFile) { $details = Get-PrettyPath $script:LogFile }
    elseif ($script:Dry) { $details = '(a dry run writes no log)' }
    else { $details = "(no log: $(Get-PrettyPath $script:NidumHome) could not be written)" }
    Write-Host ''
    Write-Host '  ' -NoNewline
    if ($script:UseColor) { Write-Host $script:GlyphFail -ForegroundColor Red -NoNewline } else { Write-Host $script:GlyphFail -NoNewline }
    Write-Host " $Title"
    Write-Host ''
    Write-Host "    What happened: $Happened"
    Write-Host "    What to try:   $Try"
    Write-Host "    Details:       $details"
    Write-Host ''
    Write-NidumLog "$($script:GlyphFail) $Title | What happened: $Happened | What to try: $Try"
    Write-Host '  Press any key to close.' -NoNewline
    if ($script:Dry) {
        Write-Host ' (dry run: not waiting)'
    } else {
        try { [void][Console]::ReadKey($true) } catch { try { [void][Console]::In.Read() } catch { } }
        Write-Host ''
    }
    exit 3
}

# Run an action the user can watch, or print it in a dry run. Returns $true on success.
$script:LastLine = ''
function Invoke-Action([string]$Exe, [string[]]$Arguments) {
    $shown = (@($Exe) + $Arguments) -join ' '
    Write-NidumLog "run: $shown"
    $script:LastLine = ''
    if ($script:Dry) {
        Write-Note "[dry run] would run: $shown"
        return $true
    }
    $lines = @()
    try {
        & $Exe @Arguments 2>&1 | ForEach-Object {
            $text = "$_"
            Write-Host $text
            $lines += $text
        }
        $code = $LASTEXITCODE
    } catch {
        $lines += "$_"
        $code = 1
    }
    foreach ($l in $lines) { Write-NidumLog $l }
    $nonEmpty = @($lines | Where-Object { $_ -and $_.Trim() })
    if ($nonEmpty.Count -gt 0) { $script:LastLine = $nonEmpty[-1] }
    Write-NidumLog "exit code: $code"
    return ($code -eq 0)
}

function Get-Version([string]$Text) {
    if ($Text -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
    return $null
}
function Test-VersionAtLeast([string]$Have, [string]$Need) {
    try { return ([version]$Have) -ge ([version]$Need) } catch { return $false }
}
function Test-ValidPort($Value) {
    $text = [string]$Value
    if ($text -notmatch '^[1-9][0-9]{0,4}$') { return $false }
    return ([int]$text -le 65535)
}
function Get-Seconds([string]$Value, [int]$Default, [int]$Min, [int]$Max) {
    if ($Value -notmatch '^[0-9]{1,6}$') { return $Default }
    $n = [int]$Value
    if ($n -lt $Min) { return $Min }
    if ($n -gt $Max) { return $Max }
    return $n
}
# Property of a parsed JSON object, or $null when absent (safe under Set-StrictMode).
function Get-JsonProp($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}
function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

# ------------------------------------------------------------------ HTTP probes (127.0.0.1 only, no proxy)

$script:TrustAllReady = $false
function Enable-TrustAll {
    if ($script:TrustAllReady) { return }
    try {
        Add-Type -TypeDefinition @'
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class NidumTrustAll {
    public static bool Accept(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { return true; }
    public static RemoteCertificateValidationCallback Callback { get { return new RemoteCertificateValidationCallback(Accept); } }
}
'@ -ErrorAction Stop
    } catch { }
    $script:TrustAllReady = $true
}

# Returns @{ Headers; Body } or $null when nothing answers.
function Invoke-LocalHttp([string]$Url, [string]$Method, [int]$TimeoutMs) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = $Method
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $req.Proxy = $null
        $req.AllowAutoRedirect = $false
        if ($Url.StartsWith('https:')) {
            Enable-TrustAll
            try { $req.ServerCertificateValidationCallback = [NidumTrustAll]::Callback } catch { }
        }
        $resp = $null
        try { $resp = $req.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response }
        if ($null -eq $resp) { return $null }
        $body = ''
        if ($Method -ne 'HEAD') {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Close()
        }
        $headers = $resp.Headers
        $resp.Close()
        return @{ Headers = $headers; Body = $body }
    } catch {
        return $null
    }
}

function Test-ProxyAlive([string]$Port) {
    if (-not $Port) { return $false }
    foreach ($scheme in @('http', 'https')) {
        $r = Invoke-LocalHttp "${scheme}://127.0.0.1:$Port/" 'HEAD' 3000
        if ($r -and $r.Headers -and $r.Headers['X-Portless'] -eq '1') { return $true }
    }
    return $false
}

# A session counts only when /api/health answers for nidum-local with the pid in session.json.
function Test-DashboardHealthy([string]$Port, [string]$SessionPid) {
    if (-not (Test-ValidPort $Port)) { return $false }
    $r = Invoke-LocalHttp "http://127.0.0.1:$Port/api/health" 'GET' 2000
    if (-not $r -or -not $r.Body) { return $false }
    try { $j = $r.Body | ConvertFrom-Json } catch { return $false }
    if ((Get-JsonProp $j 'app') -ne 'nidum-local') { return $false }
    $healthPid = [string](Get-JsonProp $j 'pid')
    if (-not $healthPid -or $healthPid -ne $SessionPid) {
        Write-NidumLog "health on port $Port answers for pid $healthPid, session.json says ${SessionPid}: not this session"
        return $false
    }
    return $true
}

# ------------------------------------------------------------------ steps

function Step-Node {
    $candidates = @()
    foreach ($c in @(Get-Command node -All -CommandType Application -ErrorAction SilentlyContinue)) { $candidates += $c.Source }
    $pf = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if ($env:ProgramFiles -and (Test-Path -LiteralPath $pf)) { $candidates += $pf }
    $old = $null
    foreach ($cand in $candidates) {
        $v = $null
        try { $v = Get-Version ((& $cand --version) 2>$null | Out-String) } catch { }
        if ($v -and (Test-VersionAtLeast $v "$($script:MinNode).0.0")) {
            $script:NodeBin = $cand
            $script:NodeVersion = $v
            return $true
        }
        if ($v -and -not $old) { $old = $v }
    }
    $script:NodeOld = $old
    return $false
}

function Ensure-Node {
    if (Step-Node) { Write-Ok "Node.js $($script:NodeVersion) found"; return }
    $have = 'You have none installed.'
    if ($script:NodeOld) { $have = "You have $($script:NodeOld)." }
    if (Test-Command winget) {
        if (Ask-Yes "Nidum Local needs Node.js $MinNode or newer. $have" 'Install it now with winget? [Y/n]') {
            Write-Wait 'Installing Node.js with winget'
            if (-not (Invoke-Action 'winget' @('install', '--id', 'OpenJS.NodeJS.LTS', '-e'))) {
                Stop-WithFailure "Couldn't install Node.js." "winget stopped with an error: $($script:LastLine)" 'Install Node.js from https://nodejs.org, then open Nidum Local again.'
            }
            if ($script:Dry) { Write-Ok 'Node.js would be installed (dry run)'; $script:NodeBin = 'node'; $script:NodeVersion = "$MinNode.0.0"; return }
            Update-SessionPath
            if (Step-Node) { Write-Ok "Node.js $($script:NodeVersion) installed"; return }
            Stop-WithFailure "Couldn't install Node.js." "The install finished, but Node.js $MinNode or newer still isn't available." 'Close this window, then open Nidum Local again.'
        }
        Stop-WithFailure "Nidum Local can't start without Node.js." "Node.js $MinNode or newer isn't installed. $have" 'Install it from https://nodejs.org (or answer Y next time), then open Nidum Local again.'
    }
    Stop-WithFailure "Nidum Local needs Node.js $MinNode or newer." $have 'Install Node.js from https://nodejs.org, then open Nidum Local again.'
}

# $null = not installed; '' = installed but broken (no version printed); else the version.
function Get-PortlessVersion {
    if (-not (Test-Command portless)) { return $null }
    $v = $null
    try { $v = Get-Version ((& portless --version) 2>&1 | Out-String) } catch { $v = $null }
    if (-not $v) { return '' }
    return $v
}

function Ensure-Portless {
    $v = Get-PortlessVersion
    if ($null -eq $v) {
        $major = 0
        try { $major = [int]($script:NodeVersion.Split('.')[0]) } catch { }
        if ($major -lt $MinNodeForNpm) {
            Stop-WithFailure 'Nidum Local needs Portless, which isn''t installed.' "Installing Portless with npm needs Node.js $MinNodeForNpm or newer. You have $($script:NodeVersion)." "Install Node.js $MinNodeForNpm from https://nodejs.org, then open Nidum Local again."
        }
        if (-not (Ask-Yes 'Nidum Local uses Portless to give your services addresses. It isn''t installed.' 'Install it now with npm? [Y/n]')) {
            Stop-WithFailure 'Nidum Local can''t start without Portless.' 'Portless isn''t installed.' 'Answer Y next time, or run: npm install -g portless'
        }
        Write-Wait 'Installing Portless with npm'
        if (-not (Invoke-Action 'npm' @('install', '-g', 'portless'))) {
            Stop-WithFailure 'Couldn''t install Portless.' "npm stopped with an error: $($script:LastLine)" 'Run: npm install -g portless, then open Nidum Local again.'
        }
        if ($script:Dry) { Write-Ok 'Portless would be installed (dry run)'; $script:PortlessVersion = $MinPortless; return }
        Update-SessionPath
        $v = Get-PortlessVersion
        if (-not $v) {
            Stop-WithFailure 'Couldn''t install Portless.' 'The install finished, but the portless command still can''t be found.' 'Close this window, then open Nidum Local again.'
        }
        $script:PortlessVersion = $v
        Write-Ok "Portless $v installed"
        return
    }
    if (-not $v) {
        Stop-WithFailure 'Portless is installed but doesn''t run.' '"portless --version" failed.' 'Run: npm install -g portless, then open Nidum Local again.'
    }
    if (-not (Test-VersionAtLeast $v $MinPortless)) {
        if (Ask-Yes "Nidum Local works best with Portless $MinPortless or newer. You have $v." 'Update it now with npm? [Y/n]') {
            Write-Wait 'Updating Portless with npm'
            if (Invoke-Action 'npm' @('install', '-g', 'portless@latest')) {
                if (-not $script:Dry) { $nv = Get-PortlessVersion; if ($nv) { $v = $nv } }
            } else {
                Write-Warn "Couldn't update Portless. Continuing with $v."
            }
        } else {
            Write-Warn "Continuing with Portless $v. Some features may not work."
        }
    }
    $script:PortlessVersion = $v
    Write-Ok "Portless $v found"
}

# Portless's Windows service: a "Portless Proxy" scheduled task that runs
# %ProgramData%\portless\service\portless-service.cmd (set "KEY=VALUE" lines + the proxy command).
function Get-ServiceScriptValue([string]$Key) {
    $svcScript = Join-Path $env:ProgramData 'portless\service\portless-service.cmd'
    if (-not $env:ProgramData -or -not (Test-Path -LiteralPath $svcScript)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $svcScript)) {
        $t = $line.Trim()
        if ($t -match ('^set "' + [regex]::Escape($Key) + '=(.*)"$')) { return $Matches[1].Replace('%%', '%') }
    }
    return $null
}
function Get-ServiceScriptPort {
    $svcScript = Join-Path $env:ProgramData 'portless\service\portless-service.cmd'
    if (-not $env:ProgramData -or -not (Test-Path -LiteralPath $svcScript)) { return $null }
    $v = Get-ServiceScriptValue 'PORTLESS_PORT'
    if (Test-ValidPort $v) { return $v }
    foreach ($line in (Get-Content -LiteralPath $svcScript)) {
        if ($line -match '(?:^|\s)(?:--port|-p)\s+"?([0-9]+)"?') { if (Test-ValidPort $Matches[1]) { return $Matches[1] } }
    }
    return $null
}

function Get-StateDir([bool]$Service) {
    if ($env:PORTLESS_STATE_DIR) { return $env:PORTLESS_STATE_DIR }
    if ($Service) { $d = Get-ServiceScriptValue 'PORTLESS_STATE_DIR'; if ($d) { return $d } }
    return (Join-Path $script:UserHome '.portless')
}
function Get-LanIp([string]$StateDir) {
    $f = Join-Path $StateDir 'proxy.lan'
    if (-not (Test-Path -LiteralPath $f)) { return '' }
    $ip = ((Get-Content -LiteralPath $f -TotalCount 1) | Out-String).Trim()
    if ($ip -match '^[0-9a-fA-F.:]+$') { return $ip }
    return ''
}
function Write-SharingOn([string]$StateDir, [string]$Suffix) {
    $ip = Get-LanIp $StateDir
    if ($ip) { Write-Ok "Network sharing is on$Suffix $($script:Dash) this computer is $ip" } else { Write-Ok "Network sharing is on$Suffix" }
}

# The one helper behind every proxy start (Contracts section 4, D20): flags from state.json
# settings. Absent fields fall back to the running proxy's TLS and port on a restart
# (-FallbackPort given), else to TLS on, port 443 (80 without TLS). A present field with a
# wrong type or range rejects the whole settings object (all fields fall back).
function Get-ProxyStart([bool]$FallbackTls = $true, [string]$FallbackPort = '') {
    $restart = [bool](Test-ValidPort $FallbackPort)
    $why = $null
    $settings = $null
    $tls = $null; $port = $null; $ip = $null; $wildcard = $false
    if (-not (Test-Path -LiteralPath $script:StateFile)) {
        $why = 'no state.json'
    } else {
        try {
            $doc = (Get-Content -LiteralPath $script:StateFile -Raw) | ConvertFrom-Json
            $settings = Get-JsonProp $doc 'settings'
            if ($null -eq $settings -or $settings -is [System.Array] -or $settings -isnot [System.Management.Automation.PSCustomObject]) { $why = 'state.json has no settings object' }
        } catch { $why = 'state.json is not readable JSON' }
    }
    if (-not $why) {
        $v = Get-JsonProp $settings 'tls'
        if ($null -ne $v) { if ($v -is [bool]) { $tls = $v } else { $why = 'settings.tls is invalid' } }
        $v = Get-JsonProp $settings 'port'
        if (-not $why -and $null -ne $v) {
            if (($v -is [int] -or $v -is [long]) -and (Test-ValidPort $v)) { $port = [string]$v } else { $why = 'settings.port is invalid' }
        }
        $v = Get-JsonProp $settings 'fixedIp'
        if (-not $why -and $null -ne $v) {
            $parsed = $null
            if ($v -is [string] -and $v -match '^[0-9a-fA-F.:]+$' -and [System.Net.IPAddress]::TryParse($v, [ref]$parsed)) { $ip = $v } else { $why = 'settings.fixedIp is invalid' }
        }
        $v = Get-JsonProp $settings 'wildcard'
        if (-not $why -and $null -ne $v) { if ($v -is [bool]) { $wildcard = $v } else { $why = 'settings.wildcard is invalid' } }
    }
    if ($why) { $tls = $null; $port = $null; $ip = $null; $wildcard = $false }
    if ($null -eq $tls) { if ($restart) { $tls = $FallbackTls } else { $tls = $true } }
    if (-not $port) {
        if ($restart) { $port = $FallbackPort } elseif ($tls) { $port = '443' } else { $port = '80' }
    }
    $flags = @('--lan')
    if ($tls) { $flags += '--https' } else { $flags += '--no-tls' }
    $flags += @('-p', $port)
    if ($ip) { $flags += @('--ip', $ip) }
    if ($wildcard) { $flags += '--wildcard' }
    if ($why) {
        Write-NidumLog "proxy flags: $($flags -join ' ') (fallback: $why)"
        if ($why -ne 'no state.json') {
            if ($restart) { Write-Warn "Your saved sharing settings couldn't be read, so Nidum Local keeps the current setup (port $port)." }
            else { Write-Warn 'Your saved sharing settings couldn''t be read, so Nidum Local uses the standard setup (port 443).' }
        }
    } else {
        Write-NidumLog "proxy flags: $($flags -join ' ') (from state.json)"
    }
    return @{ Tls = $tls; Port = $port; Flags = $flags }
}

function Start-Sharing($Start, [string]$StateDir) {
    if ($Start.Tls) { Write-Note 'Windows may ask you to allow Nidum Local to trust its local certificate.' }
    Write-Note 'Your computer may ask whether to allow incoming connections. Choose Allow, or other devices won''t be able to connect.'
    Write-Wait 'Starting network sharing (you may be asked for permission)'
    if (-not (Invoke-Action 'portless' (@('proxy', 'start') + $Start.Flags))) {
        $what = $script:LastLine
        if (-not $what) { $what = 'Portless stopped with an error.' }
        Stop-WithFailure 'Couldn''t start network sharing.' $what 'Open Nidum Local again. If it keeps failing, run: portless doctor'
    }
    if ($script:Dry) { Write-Ok 'Network sharing would be on (dry run)'; return }
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-ProxyAlive $Start.Port) { Write-SharingOn $StateDir ''; return }
        Start-Sleep -Milliseconds 500
    }
    Stop-WithFailure 'Couldn''t start network sharing.' "Portless started, but nothing answers on port $($Start.Port)." 'Open Nidum Local again. If it keeps failing, run: portless doctor'
}

function Ensure-Sharing {
    $service = $false
    if ($script:ServiceTask -and (Test-Command schtasks)) {
        try {
            & schtasks /Query /TN $script:ServiceTask *> $null
            if ($LASTEXITCODE -eq 0) { $service = $true }
        } catch { }
    }
    $stateDir = Get-StateDir $service
    $port = $null
    $portFile = Join-Path $stateDir 'proxy.port'
    if ($service) { $port = Get-ServiceScriptPort }
    if (-not $port -and (Test-Path -LiteralPath $portFile)) {
        $p = ((Get-Content -LiteralPath $portFile -TotalCount 1) | Out-String).Trim()
        if (Test-ValidPort $p) { $port = $p }
    }
    $tls = Test-Path -LiteralPath (Join-Path $stateDir 'proxy.tls')

    if ($service) {
        # F1: a startup task owns network sharing. Never start or stop it here; give it a few seconds.
        if (-not $port) {
            if ((Get-ServiceScriptValue 'PORTLESS_HTTPS') -eq '0' -or -not $tls) { $port = '80' } else { $port = '443' }
        }
        $tries = 2 * (Get-Seconds $env:NIDUM_SERVICE_WAIT 5 1 60)
        for ($i = 0; $i -le $tries; $i++) {
            if (Test-ProxyAlive $port) { Write-SharingOn $stateDir ' (kept on by the startup service)'; return }
            if ($i -eq 0) { Write-Wait 'Waiting for network sharing to answer' }
            if ($i -lt $tries) { Start-Sleep -Milliseconds 500 }
        }
        Stop-WithFailure 'The startup service isn''t responding.' "Network sharing is set to start with your computer, but nothing answers on port $port." "In an administrator window run: schtasks /Run /TN `"$($script:ServiceTask)`""
    }

    if ($port -and (Test-ProxyAlive $port)) {
        if (Get-LanIp $stateDir) { Write-SharingOn $stateDir ''; return }
        if (Ask-Yes 'Network sharing is already on, but only for this computer.' 'Restart it so other devices can connect? Open addresses will drop for a second. [Y/n]') {
            # D20: fields state.json lacks keep the running proxy's own TLS and port.
            $start = Get-ProxyStart $tls $port
            Write-Wait 'Stopping network sharing'
            if (-not (Invoke-Action 'portless' @('proxy', 'stop', '-p', $port))) {
                Stop-WithFailure 'Couldn''t restart network sharing.' $script:LastLine 'Open Nidum Local again. If it keeps failing, run: portless doctor'
            }
            Start-Sharing $start $stateDir
            return
        }
        Write-Warn 'Network sharing stays on for this computer only. Other devices can''t connect yet.'
        return
    }
    Start-Sharing (Get-ProxyStart) $stateDir
}

function Read-Session {
    $script:DashPort = $null
    $script:DashToken = $null
    $script:DashPid = $null
    if (-not (Test-Path -LiteralPath $script:SessionFile)) { return $false }
    try {
        $s = (Get-Content -LiteralPath $script:SessionFile -Raw) | ConvertFrom-Json
        $script:DashPort = [string](Get-JsonProp $s 'port')
        $script:DashToken = [string](Get-JsonProp $s 'token')
        $script:DashPid = [string](Get-JsonProp $s 'pid')
    } catch { return $false }
    return ((Test-ValidPort $script:DashPort) -and $script:DashToken -match '^[0-9a-f]{64}$' -and $script:DashPid -match '^[0-9]+$')
}
function Test-SessionOk { return ((Read-Session) -and (Test-DashboardHealthy $script:DashPort $script:DashPid)) }

function Ensure-Dashboard {
    if (Test-SessionOk) { Write-Ok 'Dashboard is already running'; return }
    if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'src\server.js'))) {
        Stop-WithFailure 'Nidum Local''s files are incomplete.' "src\server.js is missing from $(Get-PrettyPath $script:Root)." 'Download Nidum Local again, unzip it, and open it from the new folder.'
    }
    Write-Wait 'Starting the dashboard'
    if ($script:Dry) {
        Write-Note "[dry run] would run: $($script:NodeBin) src\server.js (in $($script:Root), output to $($script:ServerLog))"
        Write-Ok 'Dashboard would be started (dry run)'
        if (-not (Test-ValidPort $script:DashPort)) { $script:DashPort = "$DefaultPort" }
        $script:DashToken = '<token>'
        return
    }
    Write-NidumLog "start: $($script:NodeBin) src\server.js (cwd $($script:Root))"
    # Start-Process can't append, so keep the previous run's log as server.log.1.
    foreach ($f in @($script:ServerLog, "$($script:ServerLog).err")) {
        if (Test-Path -LiteralPath $f) { Move-Item -LiteralPath $f -Destination "$f.1" -Force -ErrorAction SilentlyContinue }
    }
    $proc = Start-Process -FilePath $script:NodeBin -ArgumentList 'src\server.js' -WorkingDirectory $script:Root `
        -WindowStyle Hidden -RedirectStandardOutput $script:ServerLog -RedirectStandardError "$($script:ServerLog).err" -PassThru
    $limit = Get-Seconds $env:NIDUM_START_TIMEOUT 10 1 300
    for ($i = 0; $i -lt ($limit * 2); $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-SessionOk) { Write-Ok 'Dashboard started'; return }
        if ($proc.HasExited) {
            if (Test-SessionOk) { Write-Ok 'Dashboard started'; return }
            $last = ''
            foreach ($f in @("$($script:ServerLog).err", $script:ServerLog)) {
                if (Test-Path -LiteralPath $f) {
                    $l = @(Get-Content -LiteralPath $f | Where-Object { $_.Trim() })
                    if ($l.Count -gt 0) { $last = $l[-1]; break }
                }
            }
            if (-not $last) { $last = 'The dashboard stopped right after starting.' }
            Stop-WithFailure 'Couldn''t start the dashboard.' $last "Open Nidum Local again. If it keeps failing, see $(Get-PrettyPath $script:ServerLog)"
        }
    }
    Stop-WithFailure 'Couldn''t start the dashboard.' "It didn't answer within $limit seconds." "Open Nidum Local again. If it keeps failing, see $(Get-PrettyPath $script:ServerLog)"
}

function Open-Dashboard {
    $base = "http://127.0.0.1:$($script:DashPort)"
    Write-Arrow "Opening $base in your browser"
    if ($script:Dry) { Write-Note "[dry run] would run: Start-Process $base/?t=<token>"; return }
    Write-NidumLog "run: Start-Process $base/?t=<redacted>"
    try { Start-Process "$base/?t=$($script:DashToken)" } catch {
        # The full address (with its token) goes to the screen only, never to the log.
        Write-Host "  ! Couldn't open your browser. Open this address: $base/?t=$($script:DashToken)"
        Write-NidumLog "! Couldn't open your browser. Open this address: $base/?t=<redacted>"
    }
}

# ------------------------------------------------------------------ main

Write-NidumLog "---- launcher start: platform=windows root=$Root dry_run=$Dry"
Write-Host ''
Write-Host '  Nidum Local'
Write-Host '  Share what''s running on this computer with your network.'
Write-Host ''
if ($Dry) { Write-Host '  (dry run: nothing will be installed, started or opened)'; Write-Host '' }

$NodeBin = $null; $NodeVersion = $null; $NodeOld = $null; $PortlessVersion = $null
$DashPort = $null; $DashToken = $null; $DashPid = $null

Ensure-Node
Ensure-Portless
Ensure-Sharing
Ensure-Dashboard
Open-Dashboard

Write-Host ''
Write-Host '  You can close this window. Nidum Local keeps running.'
Write-Host ''
Write-NidumLog 'done, exit 0'
exit 0
