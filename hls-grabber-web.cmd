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

rem Панель запускається в окремому згорнутому вікні класичної консолі
rem (conhost.exe), а потім сама його ховає (hideOwnConsole). Саме conhost, а не
rem просто start: у Windows 11 консольні програми за замовчуванням
rem відкриваються вкладкою Windows Terminal, а таку вкладку програма сховати
rem не може. Термінал, з якого запустили .cmd, лишається вільним.
rem Закривається панель у Діагностиці: «Вимкнути панель». Повторний запуск
rem просто відкриває вже запущену панель.
if exist "%APP_EXE%" (
  start "" /min "%SystemRoot%\System32\conhost.exe" "%APP_EXE%" --open %*
) else (
  pushd "%APP_DIR%"
  go run ./cmd/web --open %*
  popd
)
endlocal
