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
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# Ключі беремо по черзі: змінні середовища, потім файл .env у корені
# репозиторію, і лише тоді питаємо. Введені вручну можна зберегти в .env,
# щоб не вводити щоразу. .env у .gitignore: у git він не потрапляє.
#
# Ключі, які скрипт підставив сам (з .env чи введені), живуть лише до кінця
# скрипта (див. finally нижче). Раніше вони лишались у змінних вікна
# PowerShell, і наступний запуск мовчки брав їх звідти, навіть якщо їх уже
# анулювали на AMO.
$envFile = Join-Path $PSScriptRoot ".env"

function Read-DotEnv([string]$path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $path)) { return $values }
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    $text = $line.Trim()
    if (-not $text -or $text.StartsWith("#")) { continue }
    $split = $text.IndexOf("=")
    if ($split -lt 1) { continue }
    $name = $text.Substring(0, $split).Trim()
    $value = $text.Substring($split + 1).Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$name] = $value
  }
  return $values
}

$asked = $false
$fromFile = $false
$dotenv = Read-DotEnv $envFile
if (-not $env:WEB_EXT_API_KEY -and $dotenv["WEB_EXT_API_KEY"]) { $env:WEB_EXT_API_KEY = $dotenv["WEB_EXT_API_KEY"]; $fromFile = $true }
if (-not $env:WEB_EXT_API_SECRET -and $dotenv["WEB_EXT_API_SECRET"]) { $env:WEB_EXT_API_SECRET = $dotenv["WEB_EXT_API_SECRET"]; $fromFile = $true }
if ($fromFile) { Write-Host "Ключі взято з .env" -ForegroundColor DarkGray }
if (-not $env:WEB_EXT_API_KEY) { $env:WEB_EXT_API_KEY = Read-Host "JWT issuer (Видавець JWT)"; $asked = $true }
if (-not $env:WEB_EXT_API_SECRET) { $env:WEB_EXT_API_SECRET = Read-Secret "JWT secret (JWT таємниця)"; $asked = $true }

if ($asked -and $env:WEB_EXT_API_KEY -and $env:WEB_EXT_API_SECRET) {
  $answer = Read-Host "Зберегти ключі в .env, щоб не вводити наступного разу? [Т/н]"
  if ($answer -notmatch '^\s*(н|n)') {
    $lines = @(
      "# Ключі AMO для sign-extension.ps1. Файл у .gitignore, у git не потрапляє.",
      "WEB_EXT_API_KEY=$($env:WEB_EXT_API_KEY)",
      "WEB_EXT_API_SECRET=$($env:WEB_EXT_API_SECRET)"
    )
    # Решту рядків .env, якщо вони там є, не чіпаємо.
    if (Test-Path -LiteralPath $envFile) {
      $lines += Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*(WEB_EXT_API_KEY|WEB_EXT_API_SECRET)\s*=' -and $_ -notmatch '^# Ключі AMO' }
    }
    Set-Content -LiteralPath $envFile -Value $lines -Encoding UTF8
    Write-Host "Збережено в $envFile" -ForegroundColor DarkGray
  }
}
$asked = $asked -or $fromFile

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
    Write-Host "і запусти скрипт ще раз. Старі ключі спершу прибери:" -ForegroundColor Yellow
    Write-Host "  Remove-Item .env; Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue" -ForegroundColor Yellow
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
# Публікація для автооновлення: .xpi і updates.json у теці updates/.
# Firefox читає їх із гілки main (update_url у manifest.json) і раз на добу
# сам ставить новішу версію.
node (Join-Path $PSScriptRoot "tools\publish-update.js") $xpi.FullName $PSScriptRoot
if ($LASTEXITCODE -ne 0) {
  Write-Host "Не вдалося оновити updates/, подробиці вище." -ForegroundColor Red
  exit $LASTEXITCODE
}
git -C $PSScriptRoot add updates
git -C $PSScriptRoot commit -m "Розширення ${version}: оновлення для Firefox" --quiet
if ($LASTEXITCODE -eq 0) {
  git -C $PSScriptRoot push --quiet
  if ($LASTEXITCODE -ne 0) { Write-Host "Не вдалося запушити, зроби git push сам." -ForegroundColor Yellow }
}
$branch = git -C $PSScriptRoot rev-parse --abbrev-ref HEAD
if ($branch -ne "main") {
  Write-Host "Увага: ти на гілці $branch. Firefox бере оновлення з main, тож вони дійдуть після злиття в main." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Готово: $($xpi.FullName)" -ForegroundColor Green
Write-Host "Якщо у Firefox стоїть версія без автооновлення (до 1.13.0), перетягни цей файл у Firefox один раз."
Write-Host "Далі Firefox оновлюватиметься сам: about:addons → шестірня → «Перевірити наявність оновлень», щоб не чекати добу."
