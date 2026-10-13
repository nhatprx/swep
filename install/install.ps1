# Swep One-liner Bootstrap Installer for Windows
# irm https://raw.githubusercontent.com/nhatprx/swep/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

# 1. Ham lam moi bien moi truong PATH
function Refresh-EnvPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

# 2. Kiem tra & Tu dong cai dat Node.js neu chua co
$nodeInstalled = $false
try {
    $nodeVer = & node --version 2>$null
    if ($nodeVer -match "^v(\d+)") {
        $major = [int]$matches[1]
        if ($major -ge 18) {
            $nodeInstalled = $true
        }
    }
} catch {
    $nodeInstalled = $false
}

if (-not $nodeInstalled) {
    Write-Host "[*] Dang cai dat Node.js LTS..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        Refresh-EnvPath
    } catch {
        Write-Error "Khong the cai dat Node.js tu dong. Vui long cai dat tu https://nodejs.org"
        exit 1
    }
}

# 3. Chuan bi thu muc Swep (%LOCALAPPDATA%\Swep)
$swepDir = Join-Path $env:LOCALAPPDATA "Swep"
$appDir = Join-Path $swepDir "app"
$binDir = Join-Path $swepDir "bin"
$zipPath = Join-Path $swepDir "swep.zip"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# 4. Tai ma nguon moi nhat tu GitHub
$entryPoint = Join-Path $appDir "bin\swep.js"
Write-Host "Dang tai va cai dat Swep..." -ForegroundColor Cyan
$repoZipUrl = "https://github.com/nhatprx/swep/archive/refs/heads/main.zip"

Invoke-WebRequest -Uri $repoZipUrl -OutFile $zipPath -UseBasicParsing

Expand-Archive -Path $zipPath -DestinationPath $swepDir -Force
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

$extractedFolder = Join-Path $swepDir "swep-main"
if (Test-Path $appDir) {
    Remove-Item -Path $appDir -Recurse -Force -ErrorAction SilentlyContinue
}
Move-Item -Path $extractedFolder -Destination $appDir -Force

Push-Location $appDir
try {
    npm install --omit=dev --no-audit --no-fund --silent
} finally {
    Pop-Location
}

# 5. Tao lenh 'swep' toan cuc tren may
$cmdPath = Join-Path $binDir "swep.cmd"
$cmdContent = "@echo off`r`nnode `"$entryPoint`" %*"
Set-Content -Path $cmdPath -Value $cmdContent -Force

# Them vao User PATH neu chua co
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    $env:Path = "$env:Path;$binDir"
}

Write-Host "Cai dat Swep hoan tat! Go 'swep' de bat dau." -ForegroundColor Green
