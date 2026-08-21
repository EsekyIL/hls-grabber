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

if exist "%APP_EXE%" (
  "%APP_EXE%" --open %*
) else (
  pushd "%APP_DIR%"
  go run ./cmd/web --open %*
  popd
)
endlocal
