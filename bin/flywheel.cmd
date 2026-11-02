@echo off
rem Windows has no exec. cmd.exe leaves only this shell above the CLI, so no
rem bootstrap child is started and the CLI's own exit status is passed back.
bun --conditions=browser "%~dp0\..\scripts\dev.ts" %*
exit /b %ERRORLEVEL%