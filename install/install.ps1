# Swep Bootstrap Installer for Windows
# Usage: irm https://raw.githubusercontent.com/nhatprx/swep/v0.1.0/install.ps1 | iex

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ⚡ Cài đặt Swep - Disposable Workplace & Chrome Profile  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiểm tra Hệ điều hành
if ($PSVersionTable.PSEdition -ne "Desktop" -and $PSVersionTable.PSEdition -ne "Core") {
    Write-Warning "Khuyến nghị chạy trên Windows PowerShell 5.1+ hoặc PowerShell 7+."
}

# 2. Kiểm tra Node.js
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
    Write-Host "Chưa có Node.js (yêu cầu >= 18). Đang tiến hành cài đặt qua winget..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        Write-Host "✔ Đã cài đặt Node.js thành công. Vui lòng mở lại PowerShell để nhận biến môi trường." -ForegroundColor Green
    } catch {
        Write-Error "Không thể tự động cài Node.js. Vui lòng tải từ https://nodejs.org và thử lại."
        exit 1
    }
}

# 3. Thư mục cài đặt Swep (%LOCALAPPDATA%\Swep\bin)
$installDir = Join-Path $env:LOCALAPPDATA "Swep"
$binDir = Join-Path $installDir "bin"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# Tạo wrapper bat/ps1 để gọi swep từ bất kỳ đâu
$batPath = Join-Path $binDir "swep.cmd"
$currentDir = (Get-Location).Path
$entryPoint = Join-Path $currentDir "bin\swep.js"

if (Test-Path $entryPoint) {
    Set-Content -Path $batPath -Value "@echo off`r`nnode `"$entryPoint`" %*" -Force
} else {
    # Nếu cài từ npm global
    npm install -g swep
}

# 4. Thêm vào PATH nếu chưa có
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    $env:Path = "$env:Path;$binDir"
    Write-Host "✔ Đã thêm $binDir vào User PATH" -ForegroundColor Green
}

Write-Host "`n🎉 Cài đặt Swep hoàn tất!" -ForegroundColor Green
Write-Host "Bây giờ bạn có thể gõ lệnh bên dưới để kiểm tra:" -ForegroundColor Cyan
Write-Host "   swep doctor" -ForegroundColor White
Write-Host "Hoặc đăng nhập vào môi trường:" -ForegroundColor Cyan
Write-Host "   swep" -ForegroundColor White
