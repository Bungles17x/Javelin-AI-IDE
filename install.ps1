$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host 'Javelin AI — local setup' -ForegroundColor Cyan
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 18 or newer is required. Install it from https://nodejs.org/ and rerun this script.'
}

$nodeVersion = [version]((node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'18.0') {
    throw "Node.js 18 or newer is required; found $nodeVersion."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm was not found. Repair your Node.js installation and rerun this script.'
}

Write-Host '[1/3] Installing Javelin dependencies...'
npm install
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host '[2/3] Checking local Ollama...'
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Warning 'Ollama is not installed. Install it from https://ollama.com/download, then rerun this script.'
} else {
    $runtimeReady = $false
    try {
        $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
        $runtimeReady = $true
    } catch {
        Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            try {
                $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
                $runtimeReady = $true
                break
            } catch {
                # Wait briefly for the local runtime to start.
            }
        }
    }

    if (-not $runtimeReady) {
        Write-Warning 'Ollama is installed but did not respond at 127.0.0.1:11434. Start Ollama and retry.'
    } else {
        $models = (ollama list 2>$null | Select-Object -Skip 1) -join "`n"
        if ($models -match 'javelin-coder') {
            Write-Host 'Javelin Coder is installed locally.' -ForegroundColor Green
        } elseif ($models) {
            Write-Warning 'Ollama is running, but Javelin Coder was not found. Install the model supplied with your Javelin distribution.'
            Write-Host $models
        } else {
            Write-Warning 'Ollama is running, but no local models are installed.'
        }
    }
}

Write-Host ''
Write-Host '[3/3] Setup complete.'
Write-Host 'Start the web app with: npm run dev'
Write-Host 'Build the desktop IDE with: npm run desktop:build'
Write-Host 'Inference is local-only; the app does not use hosted AI APIs.'
