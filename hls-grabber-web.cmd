@echo off
rem Local web panel for HLS Grabber.
setlocal
set "APP_DIR=%~dp0"
rem Ім'я мусить збігатися з тим, що в README:
rem   go build -o build/bin/hls-grabber-web.exe ./cmd/web
rem Тут стояв hls-grabber-web-extension-fix.exe — одна зі старих разових
rem збірок. Через це .cmd запускав тритижневий бінарник, і виглядало це
rem так, ніби свіжі зміни не діють узагалі.
set "APP_EXE=%APP_DIR%build\bin\hls-grabber-web.exe"

rem start /min відкриває панель в окремому згорнутому вікні консолі, а панель
rem одразу його ховає (hideOwnConsole). Термінал при цьому вільний.
rem Закривається панель у Діагностиці: «Вимкнути панель». Повторний запуск
rem просто відкриває вже запущену панель.
if exist "%APP_EXE%" (
  start "" /min "%APP_EXE%" --open %*
) else (
  pushd "%APP_DIR%"
  go run ./cmd/web --open %*
  popd
)
endlocal
