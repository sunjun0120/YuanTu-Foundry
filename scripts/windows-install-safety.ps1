function Assert-YuanTuInstallations($Entries, [string]$Target) {
  foreach ($entry in $Entries) {
    if (-not ([string]$entry.DisplayName).StartsWith('YuanTu Agent', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $location = [string]$entry.InstallLocation
    if (-not $location -and ([string]$entry.UninstallString) -match '^"([^"\r\n]+)"(?:\s|$)') {
      $location = [IO.Path]::GetDirectoryName($Matches[1])
    }
    if (-not $location -or -not [IO.Path]::IsPathRooted($location) -or [IO.Path]::GetFullPath($location).TrimEnd('\') -ne $Target.TrimEnd('\')) {
      throw 'A YuanTu installation is outside or has an unknown verification location; refusing to replace it'
    }
  }
}

function Get-YuanTuInstallations {
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      try {
        $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if (-not $uninstall) { continue }
        try {
          foreach ($name in $uninstall.GetSubKeyNames()) {
            $key = $uninstall.OpenSubKey($name)
            if (-not $key) { throw 'Uninstall registry changed during verification; retry after inspection' }
            try {
              $displayName = [string]$key.GetValue('DisplayName')
              if ($displayName.StartsWith('YuanTu Agent', [StringComparison]::OrdinalIgnoreCase)) {
                [PSCustomObject]@{ DisplayName = $displayName; InstallLocation = $key.GetValue('InstallLocation'); UninstallString = $key.GetValue('UninstallString') }
              }
            } finally { $key.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      } finally { $base.Dispose() }
    }
  }
}
