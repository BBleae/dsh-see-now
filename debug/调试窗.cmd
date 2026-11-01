@echo off
setlocal
title see-now 调试窗
cd /d "%~dp0.."

rem ---- 找 node：先看 PATH，再试本机固定安装位置 ----
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto :nodeOk
if exist "D:\Nodejs\node.exe" (
  set "NODE=D:\Nodejs\node.exe"
  goto :nodeOk
)
echo.
echo   没找到 node。请先装 Node.js，或者把它加到 PATH 里。
echo.
pause
exit /b 1

:nodeOk
rem ---- 直接把文件拖到这个图标上 = 看那个视频 ----
if not "%~1"=="" goto :fromArg

echo.
echo   ==================================================
echo     see-now 调试窗：看清插件抓了哪些帧、怎么排进图
echo   ==================================================
echo.
echo      [1] 看当前屏幕         直接回车就行
echo      [2] 看一个视频文件     把文件拖进来，再回车
echo.
set "PICK="
set /p PICK=     你的选择:

if not defined PICK goto :useScreen
if "%PICK%"=="1" goto :useScreen
if "%PICK%"=="2" goto :askFile
set "PICK=%PICK:"=%"
goto :useFile

:askFile
echo.
echo      把视频文件拖到下面，然后回车：
set "PICK="
set /p PICK=
if not defined PICK goto :useScreen
set "PICK=%PICK:"=%"
goto :useFile

:fromArg
set "PICK=%~1"
set "PICK=%PICK:"=%"

:useFile
if not exist "%PICK%" (
  echo.
  echo      找不到这个文件：%PICK%
  echo.
  pause
  exit /b 1
)
echo.
echo      正在打开：%PICK%
echo      这个黑窗口别关，关掉就等于停止采集。
echo.
"%NODE%" debug\live.mjs --source=file --file="%PICK%" --realtime=1 %2 %3 %4 %5 %6 %7
goto :done

:useScreen
echo.
echo      正在看屏幕。这个黑窗口别关，关掉就等于停止采集。
echo.
"%NODE%" debug\live.mjs --source=screen %2 %3 %4 %5 %6 %7

:done
echo.
echo      采集已经停了。按任意键关掉这个黑窗口。
pause >nul
endlocal
