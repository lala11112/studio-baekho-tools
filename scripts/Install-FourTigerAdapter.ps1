[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$UnityProject,
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
$adapterSource = Join-Path $toolRoot 'Integrations/FourTigerSword/Editor'
$adapterTarget = Join-Path $projectRoot 'Assets/StudioBaekho/CombatLab/Editor'
if (-not ([IO.Path]::GetFullPath($adapterTarget)).StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install destination must be inside the Unity project.'
}
# Preflight the whole update. Existing Unity GUIDs and differing user files win
# unless the caller explicitly chooses a backed-up replacement with -Force.
$copies = @()
$conflicts = @()
foreach ($sourceFile in Get-ChildItem -LiteralPath $adapterSource -File) {
    if ($sourceFile.Extension -notin @('.cs', '.meta')) { continue }
    $targetFile = Join-Path $adapterTarget $sourceFile.Name
    if ($sourceFile.FullName.Equals($targetFile, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (Test-Path -LiteralPath $targetFile) {
        if ($sourceFile.Extension -eq '.meta') { continue }
        if ((Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash) { continue }
        $conflicts += $targetFile
    }
    $copies += @{ Source = $sourceFile.FullName; Target = $targetFile }
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
New-Item -ItemType Directory -Path $adapterTarget -Force | Out-Null
foreach ($copy in $copies) {
    Copy-Item -LiteralPath $copy.Source -Destination $copy.Target
}
Write-Output "Adapter installed: $adapterTarget"
Write-Output "Copied files: $($copies.Count). Existing .meta GUIDs were preserved."
Write-Output 'Add Packages/com.studiobaekho.combat-lab/package.json from this tools repository with Unity Package Manager > Install package from disk.'
Write-Output 'FourTigerSword v2 also requires the game runtime camera, actor clock, and confirmed-hit changes. This installer does not modify game combat sources. Review Integrations/FourTigerSword/RuntimeIntegration and docs/combat-lab-v2.md before using another checkout.'
Write-Output 'Keep this Unity project open, then launch Baekho Studio and select the project root. No Unity tool window is required.'
