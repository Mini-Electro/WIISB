; WIISBROWSING installer (NSIS). Build with scripts\build.ps1 — it passes VERSION, SRC and OUT.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user          ; per-user install: no administrator prompt, nothing outside the user's profile
ManifestDPIAware true

!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef SRC
  !error "Pass /DSRC=<published folder>"
!endif
!ifndef OUT
  !define OUT "WIISBROWSING_${VERSION}_x64-setup.exe"
!endif

!define APPNAME "WIISBROWSING"
!define EXENAME "WIISBROWSING.exe"
!define PUBLISHER "WIISB"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
!define CAPKEY "Software\Clients\StartMenuInternet\${APPNAME}"
!define WV2KEY "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APPNAME}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
BrandingText "${APPNAME} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APPNAME} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${SRCICON}"
!define MUI_UNICON "${SRCICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "Your internet. Reimagined.$\r$\n$\r$\nThis installs ${APPNAME} ${VERSION} for your Windows account. It does not need administrator rights and it will not change your default browser — you stay in control of that in Windows Settings."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME}"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!define MUI_FINISHPAGE_LINK "Choose ${APPNAME} as your default browser in Windows Settings"
!define MUI_FINISHPAGE_LINK_LOCATION "ms-settings:defaultapps"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ---- helpers ------------------------------------------------------------------------------------------------------

!macro CheckNotRunning
  ${Do}
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${EXENAME}" /NH | find /I "${EXENAME}"'
    Pop $0
    ${If} $0 != 0
      ${Break}
    ${EndIf}
    ${If} ${Silent}
      Abort "${APPNAME} is running. Close it and run the installer again."
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APPNAME} is running.$\r$\n$\r$\nClose all ${APPNAME} windows, then choose Retry." IDRETRY +2
    Abort
  ${Loop}
!macroend

Function .onInit
  !insertmacro CheckNotRunning
FunctionEnd

Function un.onInit
  !insertmacro CheckNotRunning
FunctionEnd

Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}" "" "$INSTDIR\${EXENAME}" 0
FunctionEnd

Function CheckWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "${WV2KEY}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONINFORMATION "${APPNAME} uses the Microsoft Edge WebView2 Runtime as its web engine, and it isn't installed on this PC (it is included with Windows 11 and with Microsoft Edge).$\r$\n$\r$\nOpen the download page now? You can install it after this setup finishes." IDNO +2
      ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---- install --------------------------------------------------------------------------------------------------------

Section "Install"
  SetShellVarContext current
  Call CheckWebView2
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXENAME}" "" "$INSTDIR\${EXENAME}" 0
  ${If} ${Silent}
    ${GetParameters} $1
    ${GetOptions} $1 "/DESKTOP" $2
    ${IfNot} ${Errors}
      Call CreateDesktopShortcut
    ${EndIf}
  ${EndIf}

  ; Add/Remove Programs
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  ; Make WIISBROWSING appear in Windows' "Default apps" list. This only REGISTERS it; Windows asks the user to choose.
  WriteRegStr HKCU "${CAPKEY}" "" "${APPNAME}"
  WriteRegStr HKCU "${CAPKEY}\DefaultIcon" "" "$INSTDIR\${EXENAME},0"
  WriteRegStr HKCU "${CAPKEY}\shell\open\command" "" '"$INSTDIR\${EXENAME}"'
  WriteRegStr HKCU "${CAPKEY}\Capabilities" "ApplicationName" "${APPNAME}"
  WriteRegStr HKCU "${CAPKEY}\Capabilities" "ApplicationDescription" "A fast, beautiful Chromium-based browser with vertical tabs, workspaces and clusters."
  WriteRegStr HKCU "${CAPKEY}\Capabilities" "ApplicationIcon" "$INSTDIR\${EXENAME},0"
  WriteRegStr HKCU "${CAPKEY}\Capabilities\URLAssociations" "http" "WIISBROWSINGURL"
  WriteRegStr HKCU "${CAPKEY}\Capabilities\URLAssociations" "https" "WIISBROWSINGURL"
  WriteRegStr HKCU "${CAPKEY}\Capabilities\FileAssociations" ".htm" "WIISBROWSINGHTML"
  WriteRegStr HKCU "${CAPKEY}\Capabilities\FileAssociations" ".html" "WIISBROWSINGHTML"
  WriteRegStr HKCU "${CAPKEY}\Capabilities\FileAssociations" ".xhtml" "WIISBROWSINGHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "${APPNAME}" "${CAPKEY}\Capabilities"
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGURL" "" "${APPNAME} URL"
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGURL\DefaultIcon" "" "$INSTDIR\${EXENAME},0"
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGURL\shell\open\command" "" '"$INSTDIR\${EXENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGHTML" "" "${APPNAME} HTML Document"
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGHTML\DefaultIcon" "" "$INSTDIR\${EXENAME},0"
  WriteRegStr HKCU "Software\Classes\WIISBROWSINGHTML\shell\open\command" "" '"$INSTDIR\${EXENAME}" "%1"'
SectionEnd

; ---- uninstall --------------------------------------------------------------------------------------------------------

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${CAPKEY}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${APPNAME}"
  DeleteRegKey HKCU "Software\Classes\WIISBROWSINGURL"
  DeleteRegKey HKCU "Software\Classes\WIISBROWSINGHTML"

  ; Browser data (profiles, history, bookmarks, cookies) is only removed if the user says so. Downloads and screenshots are never touched.
  ${GetParameters} $1
  ${GetOptions} $1 "/DELETEDATA" $2
  ${IfNot} ${Errors}
    RMDir /r "$LOCALAPPDATA\${APPNAME}"
  ${ElseIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your browsing data (profiles, history, bookmarks, cookies, settings)?$\r$\n$\r$\nYour downloaded files and screenshots are never deleted." IDNO +2
    RMDir /r "$LOCALAPPDATA\${APPNAME}"
  ${EndIf}

  RMDir /r "$INSTDIR"
SectionEnd
