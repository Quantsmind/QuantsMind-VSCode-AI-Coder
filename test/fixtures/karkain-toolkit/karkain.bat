@echo off
if /I "%~1"=="--version" goto ver
if /I "%~1"=="build" goto build
if /I "%~1"=="check" goto fail
if /I "%~1"=="test" goto test
if /I "%~1"=="lint" goto lint
echo unsupported command 1>&2
exit /b 2
:ver
echo karkain 1.1.0 windows/amd64
exit /b 0
:build
if /I "%~2"=="broken.kark" goto fail
echo OK built %~2
exit /b 0
:fail
echo main.kark:5:9: error: unexpected token 1>&2
exit /b 3
:test
echo PASS test_square
echo FAIL test_cube
echo PASS test_main
exit /b 4
:lint
echo main.kark:12:3: warning: unused variable n 1>&2
exit /b 0
