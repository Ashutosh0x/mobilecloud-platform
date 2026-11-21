@echo off
rem Sign + verify the MobileCloud release APK (v1-v4 schemes).
rem Calls lib\apksigner.jar directly - the .bat wrapper loses JAVA_HOME
rem between invocations under Git Bash.
setlocal
set JAVA=C:\Program Files\Microsoft\jdk-21.0.9.10-hotspot\bin\java.exe
set BT=C:\Android\sdk\build-tools\35.0.0
set ROOT=C:\Users\ashut\Downloads\Mobile cloud
set PLATFORM=%ROOT%\mobilecloud-platform
set LOG=%PLATFORM%\dist\sign-release.log

(
echo === sign v1+v2+v3+v4 ===
"%JAVA%" -jar "%BT%\lib\apksigner.jar" sign --ks "%ROOT%\mobilecloud-release.jks" --ks-key-alias mobilecloud-key --ks-pass pass:MobileCloud2026Secure! --key-pass pass:MobileCloud2026Secure! --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled true --min-sdk-version 24 --max-sdk-version 36 --out "%PLATFORM%\dist\mobilecloud-release-signed.apk" "%PLATFORM%\android-app\app\build\outputs\apk\release\app-release.apk"
echo sign exit code: %errorlevel%
echo === verify ===
"%JAVA%" -jar "%BT%\lib\apksigner.jar" verify --verbose "%PLATFORM%\dist\mobilecloud-release-signed.apk"
echo verify exit code: %errorlevel%
) > "%LOG%" 2>&1
endlocal
