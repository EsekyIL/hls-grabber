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

if (-not $env:WEB_EXT_API_KEY) { $env:WEB_EXT_API_KEY = Read-Host "JWT issuer" }
if (-not $env:WEB_EXT_API_SECRET) { $env:WEB_EXT_API_SECRET = Read-Secret "JWT secret" }

$source = Join-Path $PSScriptRoot "browser-extension"
$output = Join-Path $PSScriptRoot "build\xpi"

# Ключі web-ext бере зі змінних WEB_EXT_*, тож у командному рядку (і в
# списку процесів) їх немає. Пакуються лише файли розширення: без Go,
# тестів і тестових даних — той самий набір, що вшитий у панель.
npx --yes web-ext@8 sign `
  --source-dir $source `
  --artifacts-dir $output `
  --channel unlisted `
  --ignore-files "*.go" "*.test.js" "testdata" "testdata/**" "README.md"

if ($LASTEXITCODE -ne 0) {
  Write-Host "Підпис не вдався, подробиці вище." -ForegroundColor Red
  exit $LASTEXITCODE
}

$xpi = Get-ChildItem $output -Filter *.xpi | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host "Готово: $($xpi.FullName)" -ForegroundColor Green
Write-Host "Перетягни цей файл у вікно Firefox і підтвердь встановлення."
Write-Host "Тимчасову копію в about:debugging перед цим краще вилучити."
