# Підписує розширення на addons.mozilla.org, щоб Firefox ставив його назавжди.
#
# Тимчасове розширення з about:debugging зникає після кожного перезапуску
# браузера. Підписане непубліковане (unlisted) ставиться як звичайне: у
# каталозі його не видно, а живе воно, доки його не видалиш.
#
# Ключі: https://addons.mozilla.org/developers/addon/api/key/
#   $env:WEB_EXT_API_KEY    — «JWT issuer» (user:12345:67)
#   $env:WEB_EXT_API_SECRET — «JWT secret»
# Якщо змінних немає, скрипт спитає ключі й тримає їх лише в цьому процесі.
# У файли й у git вони не потрапляють.
#
# AMO не підписує ту саму версію двічі: після змін у розширенні підніми
# version у manifest.json і Version у assets.go.

$ErrorActionPreference = "Stop"

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Host "Не знайдено npx. Постав Node.js: https://nodejs.org" -ForegroundColor Red
  exit 1
}

function Read-Secret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# Введені тут ключі живуть лише до кінця скрипта (див. finally нижче).
# Раніше вони лишались у змінних вікна PowerShell, і наступний запуск мовчки
# брав їх звідти, навіть якщо їх уже анулювали на AMO, і падав з 401.
$asked = $false
if (-not $env:WEB_EXT_API_KEY) { $env:WEB_EXT_API_KEY = Read-Host "JWT issuer"; $asked = $true }
if (-not $env:WEB_EXT_API_SECRET) { $env:WEB_EXT_API_SECRET = Read-Secret "JWT secret"; $asked = $true }

# Порожній Enter не має доходити до AMO: інакше скрипт мовчки завершувався,
# і незрозуміло було, підписалось щось чи ні.
if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) {
  Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
  Write-Host "Ключі не введено. Візьми їх тут: https://addons.mozilla.org/developers/addon/api/key/" -ForegroundColor Red
  exit 1
}

Write-Host "Завантажую web-ext і надсилаю розширення в Mozilla. Перевірка може тривати до ~15 хвилин." -ForegroundColor Cyan

$source = Join-Path $PSScriptRoot "browser-extension"
$output = Join-Path $PSScriptRoot "build\xpi"

# Ключі web-ext бере зі змінних WEB_EXT_*, тож у командному рядку (і в
# списку процесів) їх немає. Пакуються лише файли розширення: без Go,
# тестів і тестових даних — той самий набір, що вшитий у панель.
try {
  npx --yes web-ext@8 sign `
    --source-dir $source `
    --artifacts-dir $output `
    --channel unlisted `
    --ignore-files "*.go" "*.test.js" "testdata" "testdata/**" "README.md" 2>&1 | Tee-Object -Variable signOutput
  $code = $LASTEXITCODE
} finally {
  if ($asked) { Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue }
}

if ($code -ne 0) {
  Write-Host "Підпис не вдався, подробиці вище." -ForegroundColor Red
  if (($signOutput | Out-String) -match "401|JWT") {
    Write-Host "Mozilla не прийняла ключі. Створи нові на https://addons.mozilla.org/developers/addon/api/key/" -ForegroundColor Yellow
    Write-Host "і запусти скрипт ще раз. Якщо ключі задані в змінних середовища, спершу:" -ForegroundColor Yellow
    Write-Host "  Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET" -ForegroundColor Yellow
  }
  exit $code
}

# Шукаємо файл саме поточної версії. Раніше бралось найсвіжіше .xpi в теці,
# і коли новий не скачався, скрипт показував «Готово» зі старою версією.
$version = (Get-Content (Join-Path $source "manifest.json") -Raw | ConvertFrom-Json).version
$xpi = Get-ChildItem $output -Filter "*-$version.xpi" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $xpi) {
  Write-Host "web-ext завершився, але файлу версії $version у $output немає." -ForegroundColor Red
  Write-Host "Перевір вивід вище. Якщо Mozilla ще перевіряє, підписаний файл буде на https://addons.mozilla.org/developers/addons" -ForegroundColor Yellow
  exit 1
}
Write-Host ""
Write-Host "Готово: $($xpi.FullName)" -ForegroundColor Green
Write-Host "Перетягни цей файл у вікно Firefox і підтвердь встановлення."
Write-Host "Тимчасову копію в about:debugging перед цим краще вилучити."
