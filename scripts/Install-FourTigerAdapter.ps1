param(
    [Parameter(Mandatory = $true)][string]$UnityProject
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $UnityProject).Path
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'ProjectSettings/ProjectVersion.txt'))) {
    throw 'UnityProject must be the Unity project root containing Assets and ProjectSettings.'
}
$toolRoot = Split-Path -Parent $PSScriptRoot
$adapterSource = Join-Path $toolRoot 'Integrations/FourTigerSword/Editor'
$adapterTarget = Join-Path $projectRoot 'Assets/StudioBaekho/CombatLab/Editor'
New-Item -ItemType Directory -Path $adapterTarget -Force | Out-Null
foreach ($sourceFile in Get-ChildItem -LiteralPath $adapterSource -Filter '*.cs' -File) {
    $targetFile = Join-Path $adapterTarget $sourceFile.Name
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetFile
}
Write-Output "Adapter installed: $adapterTarget"
Write-Output 'Add Packages/com.studiobaekho.combat-lab/package.json from this tools repository with Unity Package Manager > Install package from disk.'
Write-Output 'Keep this Unity project open, then launch Baekho Studio and select the project root. No Unity tool window is required.'
