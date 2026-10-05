# Перепаковує в MP4 файли, які мають розширення .mp4, а всередині MPEG-TS.
#
# Такі файли лишали старі збірки панелі з увімкненим «HLS MPEG-TS»: yt-dlp
# писав транспортний потік, а розширення ставив .mp4. Нові збірки
# перепаковують самі, а цей скрипт — для вже скачаного.
#
# Без перекодування (-c copy): якість і тривалість ті самі, на серію —
# секунди. Справжні MP4 скрипт пропускає.
#
#   .\remux-ts.ps1 "D:\Серіали\Баскетбол Куроко"
#
# Теку обходить разом із підтеками.

param([Parameter(Mandatory = $true)][string]$Folder)

$ErrorActionPreference = "Stop"

$ffmpeg = Get-ChildItem (Join-Path $env:LOCALAPPDATA "hls-grabber\tools") -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $ffmpeg) {
  $command = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $command) {
    Write-Host "ffmpeg не знайдено. Встанови його в панелі: Діагностика → FFmpeg." -ForegroundColor Red
    exit 1
  }
  $ffmpegPath = $command.Source
} else {
  $ffmpegPath = $ffmpeg.FullName
}

# MPEG-TS упізнаємо за байтом 0x47 на початку кожного 188-байтного пакета.
function Test-TransportStream([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $buffer = New-Object byte[] 377
    if ($stream.Read($buffer, 0, 377) -lt 377) { return $false }
    return $buffer[0] -eq 0x47 -and $buffer[188] -eq 0x47 -and $buffer[376] -eq 0x47
  } finally {
    $stream.Dispose()
  }
}

$fixed = 0; $skipped = 0; $failed = 0
foreach ($file in Get-ChildItem -LiteralPath $Folder -Recurse -File -Include *.mp4, *.m4v) {
  if (-not (Test-TransportStream $file.FullName)) { $skipped++; continue }

  $temp = Join-Path $file.DirectoryName ($file.BaseName + ".remux" + $file.Extension)
  & $ffmpegPath -hide_banner -loglevel error -y -i $file.FullName -map "0:v?" -map "0:a?" -c copy -movflags +faststart $temp
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temp)) {
    Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
    Write-Host "Не вдалось: $($file.Name)" -ForegroundColor Red
    $failed++
    continue
  }
  Move-Item -LiteralPath $temp -Destination $file.FullName -Force
  Write-Host "Перепаковано: $($file.Name)" -ForegroundColor Green
  $fixed++
}

Write-Host ""
Write-Host "Перепаковано: $fixed, уже були MP4: $skipped, помилок: $failed"
