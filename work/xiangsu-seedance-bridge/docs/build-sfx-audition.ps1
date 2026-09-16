param(
  [string]$OutputRoot = "$PSScriptRoot\sfx-audition"
)

$ErrorActionPreference = 'Stop'
$repoRaw = 'https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main'
$items = @(
  [pscustomobject]@{Id='SFX-001';Group='01人物出场';Name='硬地面稳步';Scene='男主或权势人物近距离入场';Path='kenney_impactsounds/Audio/footstep_concrete_000.ogg'},
  [pscustomobject]@{Id='SFX-002';Group='01人物出场';Name='地毯闷脚步';Scene='酒店、会场、办公室地毯';Path='kenney_impactsounds/Audio/footstep_carpet_000.ogg'},
  [pscustomobject]@{Id='SFX-003';Group='01人物出场';Name='木地板脚步';Scene='老宅、卧室、木质舞厅';Path='kenney_impactsounds/Audio/footstep_wood_000.ogg'},
  [pscustomobject]@{Id='SFX-004';Group='01人物出场';Name='湿地脚步';Scene='雨夜、湿地、室外追赶';Path='100-cc0-sfx-2/sfx100v2_footstep_wet_01.ogg'},
  [pscustomobject]@{Id='SFX-005';Group='01人物出场';Name='草地脚步';Scene='庭院、公园、乡村外景';Path='kenney_impactsounds/Audio/footstep_grass_000.ogg'},
  [pscustomobject]@{Id='SFX-006';Group='01人物出场';Name='衣料转身';Scene='快速转身、起身、拥抱';Path='kenney_rpgaudio/Audio/cloth1.ogg'},
  [pscustomobject]@{Id='SFX-007';Group='01人物出场';Name='衣料拉扯';Scene='抓衣领、推搡、拉开包袋';Path='kenney_rpgaudio/Audio/clothBelt.ogg'},
  [pscustomobject]@{Id='SFX-008';Group='01人物出场';Name='钥匙晃动';Scene='开锁、车钥匙、回家动作铺垫';Path='100-CC0-wood-metal-SFX/keys_01.ogg'},

  [pscustomobject]@{Id='SFX-011';Group='02门与物件';Name='室内门打开';Scene='正常进入卧室或办公室';Path='100-CC0-SFX/door_open.ogg'},
  [pscustomobject]@{Id='SFX-012';Group='02门与物件';Name='室内门关闭';Scene='关门密谈、人物离开';Path='100-CC0-SFX/door_close_01.ogg'},
  [pscustomobject]@{Id='SFX-013';Group='02门与物件';Name='愤怒摔门';Scene='决裂、捉奸、愤怒离场';Path='100-CC0-SFX/slam_01.ogg'},
  [pscustomobject]@{Id='SFX-014';Group='02门与物件';Name='开关咔哒';Scene='开灯、机械开关、门锁动作';Path='100-CC0-SFX/switch_01.ogg'},
  [pscustomobject]@{Id='SFX-015';Group='02门与物件';Name='纸张翻动';Scene='合同、检测报告、名单';Path='100-CC0-SFX/paper_01.ogg'},
  [pscustomobject]@{Id='SFX-016';Group='02门与物件';Name='文件甩桌';Scene='证据曝光、解除合同';Path='100-CC0-SFX/paper_02.ogg'},
  [pscustomobject]@{Id='SFX-017';Group='02门与物件';Name='椅子移动';Scene='落座、突然起身、离席';Path='Micro Pack - Chairmat/Chair Roll 1.wav'},
  [pscustomobject]@{Id='SFX-018';Group='02门与物件';Name='杯碟轻放';Scene='茶桌、酒吧、宴会谈话';Path='100-CC0-SFX/dishes_01.ogg'},
  [pscustomobject]@{Id='SFX-019';Group='02门与物件';Name='玻璃轻碰';Scene='酒杯轻放、轻微碰杯';Path='kenney_impactsounds/Audio/impactGlass_light_000.ogg'},
  [pscustomobject]@{Id='SFX-020';Group='02门与物件';Name='玻璃重撞';Scene='酒杯重放、玻璃物件碰撞';Path='kenney_impactsounds/Audio/impactGlass_heavy_000.ogg'},

  [pscustomobject]@{Id='SFX-026';Group='03冲突动作';Name='木桌轻拍';Scene='轻拍桌面、物件落在木桌';Path='kenney_impactsounds/Audio/impactWood_light_000.ogg'},
  [pscustomobject]@{Id='SFX-027';Group='03冲突动作';Name='木桌重拍';Scene='愤怒拍桌、重物砸桌';Path='kenney_impactsounds/Audio/impactWood_heavy_000.ogg'},
  [pscustomobject]@{Id='SFX-028';Group='03冲突动作';Name='身体中等冲击';Scene='推搡、轻拳、身体碰撞';Path='kenney_impactsounds/Audio/impactPunch_medium_000.ogg'},
  [pscustomobject]@{Id='SFX-029';Group='03冲突动作';Name='身体重冲击';Scene='重拳、踹开、激烈冲突';Path='kenney_impactsounds/Audio/impactPunch_heavy_000.ogg'},
  [pscustomobject]@{Id='SFX-030';Group='03冲突动作';Name='下跪轻触地';Scene='双膝接触地面、轻摔软物';Path='kenney_impactsounds/Audio/impactSoft_medium_000.ogg'},
  [pscustomobject]@{Id='SFX-031';Group='03冲突动作';Name='人体倒地闷响';Scene='人物摔倒或被推倒';Path='kenney_impactsounds/Audio/impactSoft_heavy_000.ogg'},
  [pscustomobject]@{Id='SFX-032';Group='03冲突动作';Name='木质物件跌落';Scene='椅子、木盒、木棍倒地';Path='100-CC0-wood-metal-SFX/wood_falling_01.ogg'},
  [pscustomobject]@{Id='SFX-033';Group='03冲突动作';Name='玻璃破碎';Scene='杯子、镜子明确破裂';Path='75-cc0-breaking-falling-hit-sfx/bfh1_glass_breaking_01.ogg'},

  [pscustomobject]@{Id='SFX-036';Group='04反转强调';Name='轻柔呼啸';Scene='轻微转头、转身、小幅甩镜';Path='Micro Pack - Organic Wooshes/Gentle Swish.wav'},
  [pscustomobject]@{Id='SFX-037';Group='04反转强调';Name='快速呼啸';Scene='证据甩出、快速推进、人物登场';Path='Micro Pack - Organic Wooshes/Classic Swish 1.wav'},
  [pscustomobject]@{Id='SFX-038';Group='04反转强调';Name='重型揭晓落点';Scene='身份揭晓、大佬现身、强反转';Path='kenney_impactsounds/Audio/impactBell_heavy_000.ogg'},
  [pscustomobject]@{Id='SFX-039';Group='04反转强调';Name='轻型强调落点';Scene='眼神变化、证据特写、小反转';Path='kenney_impactsounds/Audio/impactGeneric_light_000.ogg'},
  [pscustomobject]@{Id='SFX-040';Group='04反转强调';Name='低沉钟击';Scene='坏消息、压迫、全场安静';Path='kenney_interfacesounds/Audio/bong_001.ogg'},
  [pscustomobject]@{Id='SFX-041';Group='04反转强调';Name='电子故障停顿';Scene='信息异常、设备画面、谎言穿帮';Path='kenney_interfacesounds/Audio/glitch_002.ogg'},
  [pscustomobject]@{Id='SFX-042';Group='04反转强调';Name='确认清亮音';Scene='真相确认、名单通过、成功信息';Path='kenney_interfacesounds/Audio/confirmation_001.ogg'},
  [pscustomobject]@{Id='SFX-043';Group='04反转强调';Name='失败警示音';Scene='合作中断、资格取消、拒绝提示';Path='kenney_interfacesounds/Audio/error_001.ogg'},

  [pscustomobject]@{Id='SFX-050';Group='05通讯与产品';Name='手机电磁振动候选';Scene='手机震动或来电前提示';Path='Micro Pack - NazdyNate - Electromagnetic Sounds/NazdyNate - Cell Phone 1.wav'},
  [pscustomobject]@{Id='SFX-051';Group='05通讯与产品';Name='消息轻提示';Scene='收到邀请函、转账或通知';Path='kenney_interfacesounds/Audio/click_001.ogg'},
  [pscustomobject]@{Id='SFX-052';Group='05通讯与产品';Name='电梯到达提示';Scene='电梯门打开、人物抵达会场';Path='100-CC0-SFX/bell_01.ogg'},
  [pscustomobject]@{Id='SFX-053';Group='05通讯与产品';Name='钱币与付款候选';Scene='付款、交易、资金到账的画面动作';Path='kenney_rpgaudio/Audio/handleCoins.ogg'},
  [pscustomobject]@{Id='SFX-054';Group='05通讯与产品';Name='小物件轻落';Scene='产品盒、瓶盖、小物件放桌';Path='kenney_interfacesounds/Audio/drop_001.ogg'},
  [pscustomobject]@{Id='SFX-055';Group='05通讯与产品';Name='软物挤出候选';Scene='牙膏、膏体、软管产品操作';Path='100-CC0-SFX/plop_01.ogg'},
  [pscustomobject]@{Id='SFX-056';Group='05通讯与产品';Name='产品清亮闪现';Scene='产品稳定近景、卖点揭晓';Path='kenney_interfacesounds/Audio/glass_001.ogg'},
  [pscustomobject]@{Id='SFX-057';Group='05通讯与产品';Name='包装关闭轻响';Scene='盒盖、包装盖合、物件收起';Path='kenney_interfacesounds/Audio/close_001.ogg'},

  [pscustomobject]@{Id='SFX-061';Group='06环境场面';Name='雨声';Scene='雨夜、车内雨景、门外风雨';Path='30-cc0-sfx-loops/rain.ogg'},
  [pscustomobject]@{Id='SFX-062';Group='06环境场面';Name='雷声';Scene='画面中真实暴雨天气';Path='100-cc0-sfx-2/sfx100v2_thunder_01.ogg'},
  [pscustomobject]@{Id='SFX-063';Group='06环境场面';Name='流水环境';Scene='倒茶、流水、庭院水景';Path='30-cc0-sfx-loops/water_flowing.ogg'},
  [pscustomobject]@{Id='SFX-064';Group='06环境场面';Name='金属碰撞';Scene='金属门、器具、托盘碰撞';Path='kenney_impactsounds/Audio/impactMetal_medium_000.ogg'},
  [pscustomobject]@{Id='SFX-065';Group='06环境场面';Name='锣声候选';Scene='极少量喜剧揭晓或舞台落点';Path='100-CC0-SFX/gong_01.ogg'},
  [pscustomobject]@{Id='SFX-066';Group='06环境场面';Name='小罐跌落';Scene='罐装产品、小金属物件落地';Path='Micro Pack - Small Can/Small Crushed Can - Dropping.wav'},
  [pscustomobject]@{Id='SFX-067';Group='06环境场面';Name='唱片落针候选';Scene='复古场景、唱片停顿、特殊转场';Path='Micro Pack - Record Fuzzies/Needle Drop.wav'},
  [pscustomobject]@{Id='SFX-068';Group='06环境场面';Name='返回收束音';Scene='段落结束、决定撤回、轻收尾';Path='kenney_interfacesounds/Audio/back_001.ogg'}
)

$ffmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpegCommand) {
  $ffmpeg = $ffmpegCommand.Source
} else {
  $ffmpegCandidates = @(
    (Join-Path $PSScriptRoot '..\media-tools\ffmpeg.exe'),
    'C:\Users\Administrator\AppData\Local\Programs\xiangsu-seedance-bridge\resources\media-tools\ffmpeg.exe',
    'C:\Users\Administrator\AppData\Local\Programs\@pureamdesktop\resources\media-tools\ffmpeg.exe',
    'C:\Program Files\@pureamdesktop\resources\media-tools\ffmpeg.exe'
  )
  $ffmpeg = $ffmpegCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $ffmpeg) { throw 'ffmpeg.exe was not found' }
}
$sourceDir = Join-Path $OutputRoot 'individual-originals'
$normalizedDir = Join-Path $OutputRoot 'individual-preview'
$tempDir = Join-Path $OutputRoot '_concat-temp'
New-Item -ItemType Directory -Path $sourceDir,$normalizedDir,$tempDir -Force | Out-Null

foreach ($item in $items) {
  $escapedPath = (($item.Path -split '/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
  $extension = [IO.Path]::GetExtension($item.Path)
  $safeName = ($item.Name -replace '[\\/:*?"<>|]', '_')
  $sourceFile = Join-Path $sourceDir ("{0}_{1}{2}" -f $item.Id,$safeName,$extension)
  if (-not (Test-Path -LiteralPath $sourceFile)) {
    Invoke-WebRequest -Uri "$repoRaw/$escapedPath" -OutFile $sourceFile -UseBasicParsing
  }
  $previewFile = Join-Path $normalizedDir ("{0}_{1}.mp3" -f $item.Id,$safeName)
  & $ffmpeg -hide_banner -loglevel error -y -i $sourceFile -af 'atrim=0:4,loudnorm=I=-18:TP=-2:LRA=7,apad=pad_dur=0.7' -ar 48000 -ac 2 -b:a 192k $previewFile
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg preview failed: $($item.Id)" }
  $item | Add-Member -NotePropertyName OriginalFile -NotePropertyValue $sourceFile
  $item | Add-Member -NotePropertyName PreviewFile -NotePropertyValue $previewFile
}

$items | Select-Object Id,Group,Name,Scene,PreviewFile,Path | Export-Csv -LiteralPath (Join-Path $OutputRoot '试听清单.csv') -NoTypeInformation -Encoding UTF8
$items | ForEach-Object { $_.PreviewFile } | Set-Content -LiteralPath (Join-Path $OutputRoot '逐条试听.m3u8') -Encoding UTF8

$groupNumber = 0
foreach ($group in ($items.Group | Select-Object -Unique)) {
  $groupNumber++
  $groupItems = @($items | Where-Object Group -eq $group)
  $listFile = Join-Path $tempDir ("group-{0:D2}.txt" -f $groupNumber)
  $itemNumber = 0
  $lines = foreach ($entry in $groupItems) {
    $itemNumber++
    $asciiName = "group-{0:D2}-item-{1:D2}.mp3" -f $groupNumber,$itemNumber
    Copy-Item -LiteralPath $entry.PreviewFile -Destination (Join-Path $tempDir $asciiName) -Force
    "file '$asciiName'"
  }
  $lines | Set-Content -LiteralPath $listFile -Encoding ASCII
  $groupFile = Join-Path $OutputRoot ("$group`_连续试听.mp3")
  & $ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i $listFile -c:a libmp3lame -b:a 192k $groupFile
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg group concat failed: $group" }
}

$allList = Join-Path $tempDir 'all.txt'
$allNumber = 0
($items | ForEach-Object {
  $allNumber++
  $asciiName = "all-item-{0:D3}.mp3" -f $allNumber
  Copy-Item -LiteralPath $_.PreviewFile -Destination (Join-Path $tempDir $asciiName) -Force
  "file '$asciiName'"
}) | Set-Content -LiteralPath $allList -Encoding ASCII
& $ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i $allList -c:a libmp3lame -b:a 192k (Join-Path $OutputRoot '00_全部连续试听.mp3')
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg all concat failed' }

$decodeFailures = @()
Get-ChildItem -LiteralPath $normalizedDir -Filter '*.mp3' | ForEach-Object {
  & $ffmpeg -v error -i $_.FullName -f null - 2>$null
  if ($LASTEXITCODE -ne 0) { $decodeFailures += $_.FullName }
}
if ($decodeFailures.Count -gt 0) { throw "decode failures: $($decodeFailures -join ', ')" }

[pscustomobject]@{
  OutputRoot = $OutputRoot
  ItemCount = $items.Count
  GroupCount = @($items.Group | Select-Object -Unique).Count
  DecodeFailures = $decodeFailures.Count
  FullAudition = (Join-Path $OutputRoot '00_全部连续试听.mp3')
}
