; The protected package is a separate, per-machine product invocation.
; Override remembered paths and /D instead of inheriting a per-user install.
!macro customInit
  ; Migration/upgrade cannot invoke an existing per-user uninstaller elevated.
  ; Retain all existing installations until the VM lifecycle is accepted.
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 != ""
  ${OrIf} $1 != ""
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "Protected upgrade or migration requires the accepted recovery lifecycle. Existing installation retained."
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\YuanTu Agent\."
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "An existing installation tree requires recovery review. Files retained."
    SetErrorLevel 2
    Abort
  ${EndIf}
  StrCpy $INSTDIR "$PROGRAMFILES64\YuanTu Agent"
!macroend

!macro customUnInit
  ${If} $INSTDIR != "$PROGRAMFILES64\YuanTu Agent"
    MessageBox MB_OK|MB_ICONSTOP "Protected installation path is inconsistent. Retain the installation for recovery."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ; Standard NSIS removal must never discard a helper needed for crash recovery
  ; or leave WFP rules whose live descendants have not been reconciled.
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "Protected removal remains blocked until the Windows recovery and multi-user sandbox lifecycle is accepted. Installation and policy retained."
  SetErrorLevel 2
  Abort
!macroend
