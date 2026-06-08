@echo off
setlocal

set "EXT_ROOT=%USERPROFILE%\.vscode\extensions"
set "RG_EXE="

for /f "delims=" %%F in ('dir /b /ad /o-n "%EXT_ROOT%\openai.chatgpt-*-win32-x64" 2^>nul') do (
  if exist "%EXT_ROOT%\%%F\bin\windows-x86_64\rg.exe" (
    set "RG_EXE=%EXT_ROOT%\%%F\bin\windows-x86_64\rg.exe"
    goto :found
  )
)

:found
if not defined RG_EXE (
  echo rg.exe not found under %EXT_ROOT%\openai.chatgpt-*-win32-x64\bin\windows-x86_64 1>&2
  exit /b 9009
)

"%RG_EXE%" %*
exit /b %ERRORLEVEL%
