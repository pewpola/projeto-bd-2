param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Erro: comando '$Name' nao encontrado no PATH."
    }
}

function Get-PythonInvocation {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return @{
            FilePath = $python.Source
            PrefixArgs = @()
        }
    }

    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return @{
            FilePath = $py.Source
            PrefixArgs = @("-3")
        }
    }

    throw "Erro: Python 3 nao encontrado no PATH."
}

function Test-SupportedNodeVersion {
    param([string]$Version)

    if ($Version -notmatch "^v(\d+)\.(\d+)\.(\d+)$") {
        return $false
    }

    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]

    if ($major -gt 22) {
        return $true
    }

    if ($major -eq 22) {
        if ($minor -gt 12) {
            return $true
        }

        if ($minor -eq 12 -and $patch -ge 0) {
            return $true
        }
    }

    if ($major -eq 20) {
        if ($minor -gt 19) {
            return $true
        }

        if ($minor -eq 19 -and $patch -ge 0) {
            return $true
        }
    }

    return $false
}

function Test-VenvPython {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return $false
    }

    try {
        & $Path --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

$RootDir = Split-Path -Parent $PSCommandPath
$BackendDir = Join-Path $RootDir "backend"
$FrontendDir = Join-Path $RootDir "frontend"
$RequirementsFile = Join-Path $BackendDir "requirements.txt"
$NodeModulesDir = Join-Path $FrontendDir "node_modules"

if (-not (Test-Path $RequirementsFile)) {
    throw "Erro: arquivo de requisitos nao encontrado em $RequirementsFile."
}

Require-Command node

$npmCommandInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommandInfo) {
    $npmCommandInfo = Get-Command npm -ErrorAction SilentlyContinue
}

if (-not $npmCommandInfo) {
    throw "Erro: comando 'npm' nao encontrado no PATH."
}

$nodeVersion = node --version
if (-not (Test-SupportedNodeVersion $nodeVersion)) {
    throw "Erro: Node.js $nodeVersion detectado. Este frontend precisa de Node 20.19+ ou 22.12+."
}

$npmCommand = $npmCommandInfo.Source
$pythonInvocation = Get-PythonInvocation

$venvCandidates = @(
    (Join-Path $BackendDir ".venv\Scripts\python.exe"),
    (Join-Path $BackendDir ".venv-windows\Scripts\python.exe"),
    (Join-Path $BackendDir "venv\Scripts\python.exe")
)

$venvPython = $null
foreach ($candidate in $venvCandidates) {
    if (Test-VenvPython $candidate) {
        $venvPython = $candidate
        break
    }
}

$createdNewVenv = $false
if (-not $venvPython) {
    $venvDir = Join-Path $BackendDir ".venv-windows"
    Write-Step "Criando ambiente virtual em backend/.venv-windows"
    & $pythonInvocation.FilePath @($pythonInvocation.PrefixArgs + @("-m", "venv", $venvDir))
    $venvPython = Join-Path $venvDir "Scripts\python.exe"
    $createdNewVenv = $true
}

$shouldInstallBackend = $createdNewVenv -or (-not $SkipInstall)
$shouldInstallFrontend = (-not $SkipInstall) -or (-not (Test-Path $NodeModulesDir))

if ($shouldInstallBackend) {
    Write-Step "Atualizando o pip do backend"
    & $venvPython -m pip install --upgrade pip

    Write-Step "Instalando dependencias do backend"
    & $venvPython -m pip install -r $RequirementsFile
}

if ($shouldInstallFrontend) {
    Write-Step "Instalando dependencias do frontend"
    Push-Location $FrontendDir
    try {
        & $npmCommand install
    } finally {
        Pop-Location
    }
}

$backendProcess = $null
$frontendProcess = $null

try {
    Write-Step "Subindo backend em http://localhost:8081"
    $backendProcess = Start-Process `
        -FilePath $venvPython `
        -ArgumentList @("-m", "uvicorn", "main:app", "--reload", "--port", "8081") `
        -WorkingDirectory $BackendDir `
        -PassThru

    Write-Step "Subindo frontend em http://localhost:3001"
    $frontendProcess = Start-Process `
        -FilePath $npmCommand `
        -ArgumentList @("run", "dev", "--", "--host", "0.0.0.0") `
        -WorkingDirectory $FrontendDir `
        -PassThru

    Write-Host ""
    Write-Host "Backend:  http://localhost:8081"
    Write-Host "Frontend: http://localhost:3001"
    Write-Host ""
    Write-Host "Para pular reinstalacoes futuras, use: .\run.ps1 -SkipInstall"
    Write-Host "Pressione Ctrl+C para encerrar os dois processos."

    while ($true) {
        Start-Sleep -Seconds 1

        $backendProcess.Refresh()
        $frontendProcess.Refresh()

        if ($backendProcess.HasExited -or $frontendProcess.HasExited) {
            break
        }
    }

    if ($backendProcess.HasExited -and -not $frontendProcess.HasExited) {
        throw "O backend encerrou antes do esperado."
    }

    if ($frontendProcess.HasExited -and -not $backendProcess.HasExited) {
        throw "O frontend encerrou antes do esperado."
    }
} finally {
    foreach ($process in @($backendProcess, $frontendProcess)) {
        if ($null -eq $process) {
            continue
        }

        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force
            }
        } catch {
        }
    }
}
