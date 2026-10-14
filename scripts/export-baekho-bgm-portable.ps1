param(
  [Parameter(Mandatory=$true)][string]$TargetRoot,
  [Parameter(Mandatory=$true)][string]$SourceBgm,
  [string]$SourceItems,
  [string]$ShortcutName = '백호툴 - 3D·BGM 통합',
  [string]$SourcePackage = (Join-Path $PSScriptRoot '..\release\win-unpacked'),
  [string]$SourceData = (Join-Path $env:APPDATA 'partsmith'),
  [switch]$CreateDesktopShortcut
)
$ErrorActionPreference = 'Stop'
$packagePath = (Resolve-Path -LiteralPath $SourcePackage).Path
$dataPath = (Resolve-Path -LiteralPath $SourceData).Path
$bgmPath = (Resolve-Path -LiteralPath $SourceBgm).Path
$destination = [IO.Path]::GetFullPath($TargetRoot)
$desktopPath = [Environment]::GetFolderPath('Desktop')
if ($ShortcutName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Invalid shortcut name.' }
$shortcutPath = Join-Path $desktopPath ($ShortcutName + '.lnk')
if (Test-Path -LiteralPath $destination) { throw "Target already exists; nothing was overwritten: $destination" }
if ($CreateDesktopShortcut -and (Test-Path -LiteralPath $shortcutPath)) { throw "Shortcut already exists; nothing was overwritten: $shortcutPath" }
if (!(Test-Path -LiteralPath (Join-Path $packagePath 'Baekho Tools.exe'))) { throw 'Packaged Baekho Tools.exe is missing.' }
if (Test-Path -LiteralPath (Join-Path $dataPath 'bgm')) { throw 'Source profile already contains BGM. Review and merge explicitly; this exporter never overwrites it.' }
$ledger = Get-Content -LiteralPath (Join-Path $bgmPath 'ledger.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ledger.candidates.Count -ne 3 -or @($ledger.candidates | Where-Object status -ne 'ready').Count -gt 0) { throw 'Expected exactly three completed existing BGM tracks.' }
function Get-TreeManifest([string]$Folder) {
  $entries = @(Get-ChildItem -LiteralPath $Folder -Recurse -Force)
  if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw "Links require manual review before copying: $Folder" }
  @($entries | Where-Object { !$_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
    [PSCustomObject]@{ file=$_.FullName.Substring($Folder.TrimEnd('\').Length+1); bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  })
}
$originalData = Get-TreeManifest $dataPath
$originalBgm = Get-TreeManifest $bgmPath
$originalPackage = Get-TreeManifest $packagePath
$itemsPath = $null
$originalItems = @()
if ($SourceItems) {
  $itemsPath = (Resolve-Path -LiteralPath $SourceItems).Path
  if (Test-Path -LiteralPath (Join-Path $dataPath 'four-tiger-items')) { throw 'Source profile already has item data; explicit merge is required.' }
  $originalItems = Get-TreeManifest $itemsPath
}
New-Item -ItemType Directory -Path $destination | Out-Null
Copy-Item -LiteralPath $packagePath -Destination (Join-Path $destination 'App') -Recurse
Copy-Item -LiteralPath $dataPath -Destination (Join-Path $destination 'OriginalDataSnapshot') -Recurse
Copy-Item -LiteralPath (Join-Path $destination 'OriginalDataSnapshot') -Destination (Join-Path $destination 'Data') -Recurse
Copy-Item -LiteralPath $bgmPath -Destination (Join-Path $destination 'Data\bgm') -Recurse
if ($itemsPath) { Copy-Item -LiteralPath $itemsPath -Destination (Join-Path $destination 'Data\four-tiger-items') -Recurse }
$verificationPath = Join-Path $destination 'Verification'
New-Item -ItemType Directory -Path $verificationPath | Out-Null
foreach ($check in @(@($originalData,(Get-TreeManifest $dataPath)), @($originalData,(Get-TreeManifest (Join-Path $destination 'OriginalDataSnapshot'))), @($originalBgm,(Get-TreeManifest $bgmPath)), @($originalBgm,(Get-TreeManifest (Join-Path $destination 'Data\bgm'))), @($originalPackage,(Get-TreeManifest (Join-Path $destination 'App'))))) {
  if (($check[0] | ConvertTo-Json -Depth 4 -Compress) -cne ($check[1] | ConvertTo-Json -Depth 4 -Compress)) { throw 'Copied file integrity changed. Original folders were not modified; inspect this new folder before launch.' }
}
$originalData | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $verificationPath 'original-data-manifest.json') -Encoding UTF8
$originalBgm | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $verificationPath 'original-bgm-manifest.json') -Encoding UTF8
$originalPackage | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $verificationPath 'package-manifest.json') -Encoding UTF8
if ($itemsPath) {
  foreach ($itemCopy in @($itemsPath,(Join-Path $destination 'Data\four-tiger-items'))) {
    if (($originalItems | ConvertTo-Json -Depth 4 -Compress) -cne ((Get-TreeManifest $itemCopy) | ConvertTo-Json -Depth 4 -Compress)) { throw 'Item data changed during copy. Original files were not modified; inspect this new folder before launch.' }
  }
  $originalItems | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $verificationPath 'original-items-manifest.json') -Encoding UTF8
}
$launcher = @'
Option Explicit
Dim shell, fso, root, processEnv, userEnv
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set processEnv = shell.Environment("Process")
Set userEnv = shell.Environment("User")
processEnv("BAEKHO_DATA") = root & "\Data"
processEnv("PARTSMITH_DATA") = root & "\Data"
If Len(processEnv("FAL_KEY")) = 0 Then processEnv("FAL_KEY") = userEnv("FAL_KEY")
shell.CurrentDirectory = root & "\App"
shell.Run Chr(34) & root & "\App\Baekho Tools.exe" & Chr(34), 1, False
'@
$launcherPath = Join-Path $destination 'Launch-Baekho.vbs'
$launcher | Set-Content -LiteralPath $launcherPath -Encoding Unicode
@'
# 백호툴 · 3D/아이템/BGM 통합

바탕화면의 통합 작업실 바로가기 또는 Launch-Baekho.vbs로 실행하세요.
App 안의 실행 파일을 직접 열면 기존 공용 데이터 경로를 사용하므로 위 실행기를 사용하세요.

홈의 '3D 모델링'은 최신 Unity 그래픽 제작 공간을 엽니다. 기존 타격감·타격 타이밍 도구도 유지합니다.
'사인검 아이템'에서 기존 아이템 초안 20개와 아이콘을 검토·편집하고 Unity용 JSON·PNG 묶음을 내보낼 수 있습니다.
아이템 초안은 자동 채택하지 않습니다. 게임 전투 효과나 ScriptableObject 연동은 별도 구현 범위입니다.
'BGM 만들기'에서 장르·감정과 설명을 정해 후보 3곡을 생성하고, 듣고 선택해 MP3로 내보낼 수 있습니다.
기존에 생성한 약 30초 MP3 세 곡이 들어 있습니다. 재생·선택·내보내기는 과금하지 않습니다.
새 생성은 fal.ai Google Lyria 3 사용량으로 청구되며 표시된 비용을 확인한 뒤 눌러주세요.

Data: 이 통합본 전용 작업 기록과 BGM. 기존 앱과 자동 동기화하지 않습니다.
OriginalDataSnapshot: 설치 전 기존 공용 데이터의 변경하지 않은 복사본입니다.
Verification: 복사 무결성 및 추가 과금 없는 검증 기록입니다.
기존 앱, 공용 데이터와 사인검 도구는 이 폴더 생성 과정에서 변경하지 않았습니다. 원래 앱에 저장하지 않은 입력은 원래 창에 유지되므로 원래 창을 강제로 닫지 않았습니다.
FAL_KEY는 기존 Windows 환경 변수만 사용합니다. 이 폴더에 새 비밀키를 저장하지 않습니다.
App과 Data를 포함한 폴더 전체를 유지하세요. 원래 앱으로 돌아가려면 원래 실행 파일을 여세요.
'@ | Set-Content -LiteralPath (Join-Path $destination '사용법.md') -Encoding UTF8
if ($CreateDesktopShortcut) {
  $shellObject = New-Object -ComObject WScript.Shell
  $shortcut = $shellObject.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $shortcut.Arguments = '"' + $launcherPath + '"'
  $shortcut.WorkingDirectory = $destination
  $shortcut.IconLocation = (Join-Path $destination 'App\Baekho Tools.exe') + ',0'
  $shortcut.Description = '최신 3D·사인검 아이템·BGM 및 타격감 도구 · 기존 실행본과 데이터 보존'
  $shortcut.Save()
}
[PSCustomObject]@{ target=$destination; executable=(Join-Path $destination 'App\Baekho Tools.exe'); launcher=$launcherPath; shortcut=$(if($CreateDesktopShortcut){$shortcutPath}else{$null}); originalDataFiles=$originalData.Count; originalBgmFiles=$originalBgm.Count; originalItemFiles=$originalItems.Count; packageFiles=$originalPackage.Count; originalDataPreserved=$true; existingMusicOnly=$true } | ConvertTo-Json | Tee-Object -FilePath (Join-Path $verificationPath 'portable-export.json')
