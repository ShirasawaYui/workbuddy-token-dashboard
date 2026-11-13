@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title WorkBuddy Token Dashboard

rem ==================================================================
rem  ONE-CLICK LAUNCHER  (double-click this file)
rem
rem  Node is injected into PATH ONLY inside a WorkBuddy agent session.
rem  It is NOT in your normal user PATH, so this script never calls
rem  "node" or "npm" by name -- it calls node.exe by absolute path.
rem
rem  >>> THE ONLY TWO LINES YOU MAY NEED TO EDIT <<<
rem  If WorkBuddy upgrades Node, edit NODE_EXE. Even if you forget,
rem  the script auto-detects another version under %USERPROFILE%\.workbuddy
rem  and prints the path it actually uses.
rem
rem  Usage:
rem    start-dashboard.bat          start + auto-open browser
rem    start-dashboard.bat build    rebuild web/dist first, then start
rem    start-dashboard.bat check    print config only, do NOT start
rem ==================================================================
rem Do not hardcode the account name: %USERPROFILE% expands per user/machine; the auto-detect below is the fallback.
set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "PORT=5178"

rem Optional: force the old full-load path (troubleshooting only)
rem set "FORCE_FULL_LOAD=1"
rem Optional: do not auto-open the browser (scripted / headless runs)
rem set "DASHBOARD_NO_BROWSER=1"

set "APP_DIR=%~dp0"
set "NODE_VERSIONS_DIR=%USERPROFILE%\.workbuddy\binaries\node\versions"
set "PINNED_NODE=%NODE_EXE%"

echo.
echo ================================================================
echo   WorkBuddy Token Dashboard  /  one-click launcher
echo ================================================================

if exist "%PINNED_NODE%" (
  echo   Node runtime : PINNED absolute path ^(NOT from your user PATH^)
  echo                 %PINNED_NODE%
) else (
  echo   [warn] Pinned node.exe not found:
  echo          %PINNED_NODE%
  echo          WorkBuddy may have upgraded Node; auto-detecting ...
  set "NODE_EXE="
  for /f "delims=" %%d in ('dir /b /ad /o-n "%NODE_VERSIONS_DIR%" 2^>nul') do (
    if not defined NODE_EXE if exist "%NODE_VERSIONS_DIR%\%%d\node.exe" set "NODE_EXE=%NODE_VERSIONS_DIR%\%%d\node.exe"
  )
  if not defined NODE_EXE (
    for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
  )
  if not defined NODE_EXE (
    echo.
    echo   [error] No usable node.exe found.
    echo           Fix NODE_EXE at the top of this file, or install Node.js ^>= 20.
    echo.
    pause
    exit /b 1
  )
  echo   Node runtime : AUTO-DETECTED fallback
  echo                 !NODE_EXE!
)

for /f "delims=" %%v in ('"%NODE_EXE%" -v 2^>nul') do echo   Version      : %%v
echo   App folder   : %APP_DIR%
echo   URL          : http://127.0.0.1:%PORT%/
if defined WORKBUDDY_HOME (
  echo   Data source  : !WORKBUDDY_HOME! ^(env override^)
) else (
  echo   Data source  : %USERPROFILE%\.workbuddy ^(default^)
)
echo ================================================================
echo.

cd /d "%APP_DIR%"
if errorlevel 1 (
  echo   [error] Cannot enter the app folder.
  pause
  exit /b 1
)

if /i "%~1"=="check" (
  if exist "web\dist\index.html" (
    echo   [check] web/dist    : ready
  ) else (
    echo   [check] web/dist    : MISSING - run with the "build" argument
  )
  echo   [check] Configuration OK. No server was started.
  exit /b 0
)

rem --- Build the page if web/dist is missing, using the SAME node -----
set "NEED_BUILD="
if not exist "web\dist\index.html" set "NEED_BUILD=dist is missing"
if /i "%~1"=="build" set "NEED_BUILD=forced by the build argument"
if defined NEED_BUILD (
  echo   [info] Building web/dist ^(reason: !NEED_BUILD!^) ...
  if not exist "node_modules\vite\bin\vite.js" (
    echo   [error] vite is missing. Run "npm ci" once inside a WorkBuddy session.
    pause
    exit /b 1
  )
  pushd web
  "%NODE_EXE%" "%APP_DIR%node_modules\vite\bin\vite.js" build
  if errorlevel 1 (
    popd
    echo   [error] Build failed. Fix the error above before starting.
    pause
    exit /b 1
  )
  popd
)

netstat -ano | findstr /r /c:":%PORT%.*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   [warn] Port %PORT% is already listening. If another dashboard is running,
  echo          close it first, or change PORT at the top of this file.
  echo.
)

if not "%DASHBOARD_NO_BROWSER%"=="1" (
  echo   [info] The browser opens automatically once the API is ready.
  start "" /B powershell.exe -NoProfile -Command "$u='http://127.0.0.1:%PORT%/'; for($i=0;$i -lt 40;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri ($u+'api/meta') -TimeoutSec 1; if($r.StatusCode -eq 200){break} } catch {}; Start-Sleep -Milliseconds 400 }; Start-Process $u"
)

echo.
echo   [run]  "%NODE_EXE%" server\src\index.js
echo   [tip]  Press Ctrl+C or close this window to stop the server.
echo.
"%NODE_EXE%" "server\src\index.js"
set "RC=%ERRORLEVEL%"
echo.
echo   [stop] Server exited with code %RC%.
pause
endlocal
