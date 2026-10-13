# Swep One-liner Bootstrap Installer for Windows
# Chạy một lệnh trên máy mượn:
# irm https://raw.githubusercontent.com/nhatprx/swep/main/install.ps1 | iex

[CmdletBinding()]
param(
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ⚡ Swep - Khởi tạo môi trường làm việc tạm thời        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Hàm làm mới biến môi trường PATH
function Refresh-EnvPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

# 2. Kiểm tra & Tự động cài đặt Node.js nếu máy chưa có
$nodeInstalled = $false
try {
    $nodeVer = & node --version 2>$null
    if ($nodeVer -match "^v(\d+)") {
        $major = [int]$matches[1]
        if ($major -ge 18) {
            $nodeInstalled = $true
            Write-Host "✔ Đã tìm thấy Node.js ($nodeVer)" -ForegroundColor Green
        }
    }
} catch {
    $nodeInstalled = $false
}

if (-not $nodeInstalled) {
    Write-Host "⏳ Chưa có Node.js trên máy (yêu cầu >= 18). Đang tự động cài qua winget..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        Refresh-EnvPath
        Write-Host "✔ Đã cài đặt Node.js thành công!" -ForegroundColor Green
    } catch {
        Write-Error "Không thể cài đặt Node.js tự động. Vui lòng tải Node.js từ https://nodejs.org"
        exit 1
    }
}

# 3. Chuẩn bị thư mục Swep (%LOCALAPPDATA%\Swep)
$swepDir = Join-Path $env:LOCALAPPDATA "Swep"
$appDir = Join-Path $swepDir "app"
$binDir = Join-Path $swepDir "bin"
$zipPath = Join-Path $swepDir "swep.zip"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# 4. Tải mã nguồn mới nhất từ GitHub nếu chưa có
$entryPoint = Join-Path $appDir "bin\swep.js"
if (-not (Test-Path $entryPoint)) {
    Write-Host "⏳ Đang tải Swep từ GitHub..." -ForegroundColor Cyan
    $repoZipUrl = "https://github.com/nhatprx/swep/archive/refs/heads/main.zip"
    
    Invoke-WebRequest -Uri $repoZipUrl -OutFile $zipPath -UseBasicParsing
    
    Write-Host "⏳ Đang giải nén Swep..." -ForegroundColor Cyan
    Expand-Archive -Path $zipPath -DestinationPath $swepDir -Force
    Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

    $extractedFolder = Join-Path $swepDir "swep-main"
    if (Test-Path $appDir) {
        Remove-Item -Path $appDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Move-Item -Path $extractedFolder -Destination $appDir -Force

    Write-Host "⏳ Đang cài đặt thư viện phụ thuộc..." -ForegroundColor Cyan
    Push-Location $appDir
    try {
        npm install --omit=dev --no-audit --no-fund --silent
    } finally {
        Pop-Location
    }
    Write-Host "✔ Tải và cài đặt Swep hoàn tất!" -ForegroundColor Green
}

# 5. Tạo lệnh 'swep' toàn cục trên máy
$cmdPath = Join-Path $binDir "swep.cmd"
$cmdContent = "@echo off`r`nnode `"$entryPoint`" %*"
Set-Content -Path $cmdPath -Value $cmdContent -Force

# Thêm vào User PATH nếu chưa có
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    $env:Path = "$env:Path;$binDir"
    Write-Host "✔ Đã đăng ký lệnh 'swep' vào hệ thống." -ForegroundColor Green
}

Write-Host "`n🚀 Đang khởi động Swep...`n" -ForegroundColor Green

# 6. Chạy Swep ngay lập tức
& node $entryPoint
