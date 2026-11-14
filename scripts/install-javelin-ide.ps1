$ErrorActionPreference = 'Stop'

function Find-VSCode {
    $command = Get-Command code.cmd -ErrorAction SilentlyContinue
    if ($command) {
        return [PSCustomObject]@{ Cli = $command.Source; App = (Join-Path (Split-Path (Split-Path $command.Source -Parent) -Parent) 'Code.exe') }
    }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code')
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'Code.exe')) }

    foreach ($directory in $candidates) {
        $cli = Join-Path $directory 'bin\code.cmd'
        if (Test-Path $cli) {
            return [PSCustomObject]@{ Cli = $cli; App = (Join-Path $directory 'Code.exe') }
        }
    }

    return $null
}

try {
    $username = $env:USERNAME.ToLowerInvariant()
    if ($username -notin @('lildc', 'bungles17x')) {
        throw "This private Javelin IDE build is not licensed for Windows account '$username'."
    }

    $vsix = Join-Path $PSScriptRoot 'javelin-fixed.vsix'
    if (-not (Test-Path $vsix)) {
        throw 'The packaged Javelin extension was not found. Rebuild the installer package.'
    }

    Write-Host 'Javelin AI IDE Setup' -ForegroundColor Cyan
    Write-Host 'Checking for Visual Studio Code...'
    $vscode = Find-VSCode

    if (-not $vscode) {
        Write-Host 'Downloading the current-user Visual Studio Code installer...'
        $installer = Join-Path $env:TEMP 'Javelin-VSCodeSetup.exe'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri 'https://update.code.visualstudio.com/latest/win32-x64-user/stable' -OutFile $installer
        $signature = Get-AuthenticodeSignature -FilePath $installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
            throw 'The downloaded Visual Studio Code installer did not have a valid Microsoft signature.'
        }
        $installProcess = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode') -Wait -PassThru
        if ($installProcess.ExitCode -ne 0) {
            throw "Visual Studio Code setup failed with exit code $($installProcess.ExitCode)."
        }
        $vscode = Find-VSCode
        if (-not $vscode) {
            throw 'Visual Studio Code finished installing, but its command-line tools could not be located.'
        }
    }

    Write-Host 'Installing Javelin AI Assistant into Visual Studio Code...'
    & $vscode.Cli --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) {
        throw "VS Code could not install the Javelin extension (exit code $LASTEXITCODE)."
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcutPath in @(
        (Join-Path $desktop 'Javelin AI IDE.lnk'),
        (Join-Path $startMenu 'Javelin AI IDE.lnk')
    )) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $vscode.App
        $shortcut.Arguments = '--new-window'
        $shortcut.WorkingDirectory = [Environment]::GetFolderPath('MyDocuments')
        $shortcut.Description = 'Open Visual Studio Code with Javelin AI installed'
        $shortcut.Save()
    }

    Write-Host ''
    Write-Host 'Javelin AI IDE is installed.' -ForegroundColor Green
    Write-Host 'Use the Javelin AI icon in the Activity Bar or run "Javelin AI: Open Javelin IDE" from the Command Palette.'
    Write-Host 'Local model runtime and model weights are separate downloads.'
    Start-Process -FilePath $vscode.App -ArgumentList '--new-window'
} catch {
    Write-Error $_
    exit 1
}