param([Parameter(Mandatory = $true)][string]$UnityProject)
$ErrorActionPreference = 'Stop'
$kitRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = (Resolve-Path -LiteralPath $UnityProject).Path
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'ProjectSettings\ProjectVersion.txt'))) { throw 'Unity 프로젝트 루트를 지정하세요.' }
if (-not (Get-ChildItem -LiteralPath (Join-Path $projectRoot 'Assets') -Filter 'WeaponActionDataSO.cs' -Recurse -File | Select-Object -First 1)) { throw '사인검 WeaponActionDataSO 소스가 있는 프로젝트가 필요합니다.' }
$copies = @(
    @{ Source = 'Packages\com.studiobaekho.auto-hit-timer'; Target = 'AutoHitTimerIntegration\Package' },
    @{ Source = 'Integrations\FourTigerSword\AutoHitTimer\Editor'; Target = 'AutoHitTimerIntegration\Adapter' },
    @{ Source = 'Installer\Editor'; Target = 'Assets\StudioBaekho\AutoHitTimerBootstrap\Editor' }
)
$liveEditor = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'Assets\StudioBaekho\AutoHitTimer\Editor'))
$rollbackLiveAdapter = (Test-Path -LiteralPath (Join-Path $liveEditor 'FourTigerAutoHitTimerAdapter.cs') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $liveEditor 'FourTigerSlashMapping.cs') -PathType Leaf)
if ($rollbackLiveAdapter) {
    if (-not $liveEditor.StartsWith($projectRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw '설치 경로가 프로젝트 밖입니다.' }
    $current = $liveEditor
    while ($current) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "연결된 경로에 설치할 수 없습니다: $current" }
        if ($current -eq $projectRoot) { break }
        $current = Split-Path -Parent $current
    }
    # Restore the compiled adapter before retiring its package dependencies. A
    # compile error in the previous adapter could otherwise block the bootstrap.
    Get-ChildItem -LiteralPath (Join-Path $kitRoot 'Integrations\FourTigerSword\AutoHitTimer\Editor') -File -Force | ForEach-Object {
        $target = Join-Path $liveEditor $_.Name
        if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "연결된 파일에 설치할 수 없습니다: $target" }
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
}
# Older kits copied these files into the project. Remove only these retired files;
# copying the restored kit does not otherwise remove files from an installation.
$obsoletePackageFiles = @(
    'Editor\AutoHitTimerEffectScene.cs', 'Editor\AutoHitTimerEffectScene.cs.meta',
    'Editor\AutoHitTimerEffects.cs', 'Editor\AutoHitTimerEffects.cs.meta',
    'Editor\AutoHitTimerPreviewRendering.cs', 'Editor\AutoHitTimerPreviewRendering.cs.meta',
    'Editor\AutoHitTimerViewport.cs', 'Editor\AutoHitTimerViewport.cs.meta',
    'Editor\AutoHitTimerViewportPipe.cs', 'Editor\AutoHitTimerViewportPipe.cs.meta',
    'Editor\URP.meta',
    'Editor\URP\AutoHitTimerUrpPreviewRendering.cs', 'Editor\URP\AutoHitTimerUrpPreviewRendering.cs.meta',
    'Editor\URP\StudioBaekho.AutoHitTimer.Editor.URP.asmdef', 'Editor\URP\StudioBaekho.AutoHitTimer.Editor.URP.asmdef.meta',
    'Tests\Editor\AutoHitTimerEffectTests.cs', 'Tests\Editor\AutoHitTimerEffectTests.cs.meta'
)
$obsoleteFiles = @($obsoletePackageFiles | ForEach-Object { 'AutoHitTimerIntegration\Package\' + $_ })
$obsoleteFiles += @(
    'AutoHitTimerIntegration\Adapter\FourTigerSlashMapping.cs',
    'AutoHitTimerIntegration\Adapter\FourTigerSlashMapping.cs.meta',
    'Assets\StudioBaekho\AutoHitTimer\Editor\FourTigerSlashMapping.cs',
    'Assets\StudioBaekho\AutoHitTimer\Editor\FourTigerSlashMapping.cs.meta'
)
foreach ($relativeFile in $obsoleteFiles) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $relativeFile))
    if (-not $target.StartsWith($projectRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw '정리 경로가 프로젝트 밖입니다.' }
    $current = $target
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "연결된 경로의 파일을 정리할 수 없습니다: $current" }
        }
        if ($current -eq $projectRoot) { break }
        $current = Split-Path -Parent $current
    }
    if (Test-Path -LiteralPath $target -PathType Container) { throw "정리 대상이 파일이 아닙니다: $target" }
    if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target }
}
foreach ($item in $copies) {
    $source = Join-Path $kitRoot $item.Source
    $destination = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $item.Target))
    if (-not $destination.StartsWith($projectRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw '설치 경로가 프로젝트 밖입니다.' }
    $current = $destination
    while ($current -and $current -ne $projectRoot) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "연결된 경로에 설치할 수 없습니다: $current" }
        }
        $current = Split-Path -Parent $current
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Where-Object Name -NotMatch '^Tests~?$' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
}
$library = Join-Path $projectRoot 'Library'
if ((Test-Path -LiteralPath $library) -and ((Get-Item -LiteralPath $library).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw '연결된 Library 경로는 사용할 수 없습니다.' }
New-Item -ItemType Directory -Path $library -Force | Out-Null
@{ schemaVersion = 1; requestedUtc = [DateTime]::UtcNow.ToString('O'); adapter = 'four-tiger-sword' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $library 'AutoHitTimerInstall.json') -Encoding utf8
Write-Output 'Unity에서 파일을 새로고침하세요. Package Manager가 AutoHitTimer와 Newtonsoft JSON 의존성을 설치하고 컴파일합니다.'
