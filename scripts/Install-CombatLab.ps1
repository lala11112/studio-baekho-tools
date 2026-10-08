[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$UnityProject,
    [ValidateSet('None', 'Example', 'FourTigerSword')][string]$Adapter = 'None',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $UnityProject).Path).TrimEnd([char[]]'\/')
foreach ($requiredPath in @('Assets', 'Packages', 'ProjectSettings/ProjectVersion.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $requiredPath))) {
        throw "UnityProject must be an existing Unity project root (missing $requiredPath)."
    }
}
$toolRoot = Split-Path -Parent $PSScriptRoot
$mappings = @(@{
    Source = Join-Path $toolRoot 'Packages/com.studiobaekho.combat-lab'
    Target = Join-Path $projectRoot 'Packages/com.studiobaekho.combat-lab'
})
if ($Adapter -eq 'Example') {
    $mappings += @{
        Source = Join-Path $toolRoot 'Integrations/Example'
        Target = Join-Path $projectRoot 'Assets/StudioBaekho/CombatLabExample'
    }
} elseif ($Adapter -eq 'FourTigerSword') {
    $mappings += @{
        Source = Join-Path $toolRoot 'Integrations/FourTigerSword/Editor'
        Target = Join-Path $projectRoot 'Assets/StudioBaekho/CombatLab/Editor'
    }
}

# Plan every copy before writing anything. Existing Unity metadata always wins.
$copies = @()
$conflicts = @()
foreach ($mapping in $mappings) {
    $sourceRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $mapping.Source).Path).TrimEnd([char[]]'\/')
    $targetRoot = [IO.Path]::GetFullPath($mapping.Target).TrimEnd([char[]]'\/')
    if (-not $targetRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Install destination must be inside the Unity project: $targetRoot"
    }
    foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse) {
        $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length + 1)
        $destination = Join-Path $targetRoot $relativePath
        if ($sourceFile.FullName.Equals($destination, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (Test-Path -LiteralPath $destination) {
            if ($sourceFile.Extension -eq '.meta') { continue }
            $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
            $targetHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
            if ($sourceHash -eq $targetHash) { continue }
            $conflicts += $destination
        }
        $copies += @{ Source = $sourceFile.FullName; Target = $destination }
    }
}
if ($conflicts.Count -gt 0 -and -not $Force) {
    throw ("Existing files differ; no files were changed. Review them or rerun with -Force to back up and replace them:`n" + ($conflicts -join "`n"))
}

if ($conflicts.Count -gt 0) {
    $backupRoot = Join-Path $projectRoot ('CombatLabInstallBackups/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    foreach ($conflict in $conflicts) {
        $backup = Join-Path $backupRoot $conflict.Substring($projectRoot.Length + 1)
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $conflict -Destination $backup
    }
    Write-Output "Previous files backed up: $backupRoot"
}
foreach ($copy in $copies) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $copy.Target) -Force | Out-Null
    Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Force
}
Write-Output "Combat Lab installed as an embedded package: $projectRoot/Packages/com.studiobaekho.combat-lab"
Write-Output "Adapter: $Adapter; copied files: $($copies.Count). Existing .meta GUIDs were preserved."
Write-Output 'This installation does not depend on the tools checkout location and does not edit Packages/manifest.json.'
if ($Adapter -eq 'Example') {
    Write-Output 'After Unity compiles, use Tools > Baekho > Combat Lab Example > Create Demo Scene. Select this Unity project in Baekho Studio and choose the Example adapter.'
} elseif ($Adapter -eq 'None') {
    Write-Output 'Install or implement an ICombatLabAdapter for this game before running experiments. See docs/reusing-combat-lab.md.'
}
Write-Output 'Keep Unity open with the saved test scene. The package currently targets Unity 6000.3 or newer.'
