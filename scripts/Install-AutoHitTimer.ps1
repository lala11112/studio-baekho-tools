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
