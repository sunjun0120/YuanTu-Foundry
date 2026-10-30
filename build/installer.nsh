; Custom NSIS hooks for the Windows installer (included by electron-builder through `nsis.include`).

; Uninstalling the application also removes the Windows sandbox accounts, their firewall filters and their grants:
; the desktop has no settings page for them, so this is where they go away. It runs before the files are deleted,
; while the helper is still on disk, and never during an update, which uninstalls the old version first and would
; otherwise make every update ask to set the sandbox up again. The helper elevates itself, so a machine that has the
; accounts sees one UAC prompt here; one that never set them up sees nothing.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $R0 "$INSTDIR\resources\app\dist\packages\sandbox\windows-sandbox\yuantu-sandbox.exe"
    ${if} ${FileExists} "$R0"
      ; Any one of the three is enough to be worth removing: a half-finished setup leaves some of them behind.
      StrCpy $R1 "0"
      nsExec::Exec '"$SYSDIR\net.exe" localgroup YuanTuSandboxUsers'
      Pop $R2
      ${if} $R2 == "0"
        StrCpy $R1 "1"
      ${endif}
      nsExec::Exec '"$SYSDIR\net.exe" user YuanTuSandboxOffline'
      Pop $R2
      ${if} $R2 == "0"
        StrCpy $R1 "1"
      ${endif}
      nsExec::Exec '"$SYSDIR\net.exe" user YuanTuSandboxOnline'
      Pop $R2
      ${if} $R2 == "0"
        StrCpy $R1 "1"
      ${endif}
      ${if} $R1 == "1"
        nsExec::Exec '"$R0" account-uninstall'
        Pop $R2
        ${if} $R2 != "0"
          MessageBox MB_OK|MB_ICONEXCLAMATION "未能删除 Windows 沙箱账户（YuanTuSandboxOffline、YuanTuSandboxOnline）。应用仍会被卸载；如需清理，请在“计算机管理 > 本地用户和组”中手动删除这两个账户和 YuanTuSandboxUsers 组。$\r$\n$\r$\nThe Windows sandbox accounts could not be removed. The application will still be uninstalled; remove the two accounts and the YuanTuSandboxUsers group in Computer Management if needed." /SD IDOK
        ${endif}
      ${endif}
    ${endif}
  ${endIf}
!macroend
