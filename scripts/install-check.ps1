# Verify a fresh native Windows install; no profile, PATH, or repository edits.
param(
    [Parameter(Mandatory = $true)][ValidateSet('mise', 'archive')][string]$Method,
    [Parameter(Mandatory = $true)][ValidateSet('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')][string]$Target,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$ReleaseDirectory
)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') { throw "Invalid release tag: $Tag" }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$expectedArchitecture = if ($Target -eq 'aarch64-pc-windows-msvc') { 'Arm64' } else { 'X64' }
if ($architecture -ne $expectedArchitecture) { throw "Expected native $expectedArchitecture runner; got $architecture" }
# The runner empties RUNNER_TEMP after the job, so nothing here deletes the installed binary: on
# windows-11-arm, the runner's agent briefly opens running executables without delete sharing.
if (-not $env:RUNNER_TEMP) { throw 'Run this on a GitHub Actions runner, which empties RUNNER_TEMP' }
$work = Join-Path $env:RUNNER_TEMP ('quest install ' + [guid]::NewGuid())
$originalDirectory = Get-Location
$originalMise = @{}
foreach ($name in @('MISE_CONFIG_DIR', 'MISE_DATA_DIR', 'MISE_CACHE_DIR')) { $originalMise[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    New-Item -ItemType Directory -Path $work | Out-Null
    if ($Method -eq 'mise') {
        $env:MISE_CONFIG_DIR = Join-Path $work 'config'
        $env:MISE_DATA_DIR = Join-Path $work 'data'
        $env:MISE_CACHE_DIR = Join-Path $work 'cache'
        $project = New-Item -ItemType Directory -Path (Join-Path $work 'project')
        Set-Location $project.FullName
        mise use --pin "github:moq-dev/quest@$Tag"
        if ($LASTEXITCODE -ne 0) { throw 'mise installation failed' }
        $binary = mise which quest
        if ($LASTEXITCODE -ne 0) { throw 'mise could not find the installed Quest' }
        $binary = [System.IO.Path]::GetFullPath($binary.Trim())
        if (-not $binary.StartsWith($env:MISE_DATA_DIR + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw "mise selected an existing installation: $binary" }
    } else {
        $archive = "quest-$Target.zip"
        foreach ($file in @($archive, 'SHA256SUMS')) {
            $destination = Join-Path $work $file
            if ($ReleaseDirectory) { Copy-Item -LiteralPath (Join-Path $ReleaseDirectory $file) -Destination $destination }
            else { Invoke-WebRequest -Uri "https://github.com/moq-dev/quest/releases/download/$Tag/$file" -OutFile $destination }
        }
        $entries = @(Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS') | ForEach-Object {
            $fields = $_ -split '\s+', 2
            if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq $archive) { $fields[0] }
        })
        if ($entries.Count -ne 1 -or $entries[0] -notmatch '^[a-fA-F0-9]{64}$') { throw "Missing or duplicate checksum for $archive" }
        $hash = (Get-FileHash -LiteralPath (Join-Path $work $archive) -Algorithm SHA256).Hash
        if ($hash -ne $entries[0]) { throw "Checksum mismatch for $archive" }
        Expand-Archive -LiteralPath (Join-Path $work $archive) -DestinationPath (Join-Path $work 'archive')
        $binary = Join-Path $work 'archive/quest.exe'
    }
    bun (Join-Path $PSScriptRoot 'windows-architecture.mjs') $binary $Target
    if ($LASTEXITCODE -ne 0) { throw 'Wrong Windows binary architecture' }
    bun (Join-Path $PSScriptRoot 'lifecycle-check.mjs') $binary ($Tag.Substring(1))
    if ($LASTEXITCODE -ne 0) { throw 'Native Windows lifecycle failed' }
    Write-Output "$Method ($Target): quest $($Tag.Substring(1))"
} finally {
    Set-Location $originalDirectory
    foreach ($name in $originalMise.Keys) { [Environment]::SetEnvironmentVariable($name, $originalMise[$name], 'Process') }
}
