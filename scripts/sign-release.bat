@echo off
setlocal
rem Use the same release pipeline as CI. Requires Git Bash on PATH.
rem Provide SDK paths, an existing keystore and its protected signing inputs
rem in the environment; see build-and-sign-apk.sh.
cd /d "%~dp0.." || exit /b 1
bash scripts/build-and-sign-apk.sh
exit /b %ERRORLEVEL%
