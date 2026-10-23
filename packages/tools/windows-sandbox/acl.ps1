param([Parameter(Mandatory=$true)][string]$Operation, [Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Journal, [string]$Sid, [string[]]$ControlRoots = @())
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# In-box modules only, by absolute path: auto-loading analyses every installed module first (see IN_BOX_MODULES).
$PSModuleAutoLoadingPreference = 'None'
foreach ($module in 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security') { Import-Module -Name ($PSHOME + '\Modules\' + $module + '\' + $module + '.psd1') }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;
public static class YuantuAcl {
  [StructLayout(LayoutKind.Sequential)] struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInformation info);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h, int kind, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle h, int kind, uint flags, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint revision, uint flags, out IntPtr text, out uint length);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr sd, out uint length);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(SafeFileHandle h, uint info, IntPtr sd);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr acl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr acl, out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static readonly Dictionary<string, SafeFileHandle> pinned = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  // Do not follow links, and omit FILE_SHARE_DELETE while security changes are in flight.
  public static void Pin(string path) { Pin(path, 0xE0000); }
  // Validation only reads descriptors: READ_CONTROL keeps the object pinned without asking for WRITE_OWNER, which an
  // unelevated owner does not hold outside its profile (an inherited Authenticated Users ACE grants no WO).
  public static void PinRead(string path) { Pin(path, 0x20000); }
  static void Pin(string path, uint access) {
    if (pinned.ContainsKey(path)) return;
    SafeFileHandle handle = CreateFileW(path, access, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if(handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      if(error != 5 || (access & 0x80000) == 0) throw new Win32Exception(error, "Pin workspace security object");
      handle = PinAsOwner(path, access, error);
    }
    try { Inspect(handle); } catch { handle.Dispose(); throw; }
    pinned.Add(path, handle);
  }
  static void Inspect(SafeFileHandle handle) {
    FileInformation info;
    if(!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.Attributes & 0x400) != 0) throw new InvalidOperationException("Windows sandbox refuses reparse points in ACL trees");
    if((info.Attributes & 0x10) == 0 && info.Links > 1) throw new InvalidOperationException("Windows sandbox refuses hardlinks in ACL trees");
  }
  // Descriptors as they were before PinAsOwner added its ACE: what a grant journals and a restore puts back.
  static readonly Dictionary<string, string> originals = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  /**
   * Labels need WRITE_OWNER, which an unelevated owner lacks wherever its DACL comes from an inherited Authenticated
   * Users ACE (any volume outside the profile, or a TEMP moved there). The owner always holds WRITE_DAC, so it grants
   * itself WRITE_OWNER on this one object, after the link checks and with the original descriptor kept for the journal.
   */
  static SafeFileHandle PinAsOwner(string path, uint access, int denied) {
    using (SafeFileHandle owner = CreateFileW(path, 0x60000, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if(owner.IsInvalid) throw new Win32Exception(denied, "Pin workspace security object");
      Inspect(owner);
      string before = Describe(owner);
      // One explicit, non-inheritable ACE, every other ACE byte for byte as it was: the object classes'
      // canonicalization would drop a directory's inheritance flags, and SetSecurityInfo would then propagate that
      // loss to every child. SetKernelObjectSecurity writes this one DACL and propagates nothing.
      var raw = new RawSecurityDescriptor(before);
      RawAcl acl = raw.DiscretionaryAcl;
      if(acl == null) throw new Win32Exception(denied, "Pin workspace security object");
      int at = 0;
      while(at < acl.Count) {
        var ace = acl[at] as QualifiedAce;
        if(ace == null || (ace.AceFlags & AceFlags.Inherited) != 0 || ace.AceQualifier != AceQualifier.AccessDenied) break;
        at++;
      }
      acl.InsertAce(at, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x80000, System.Security.Principal.WindowsIdentity.GetCurrent().User, false, null));
      raw.DiscretionaryAcl = acl;
      IntPtr sd; uint length;
      if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(raw.GetSddlForm(AccessControlSections.Access), 1, out sd, out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        if(!SetKernelObjectSecurity(owner, 4, sd)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Grant the owner WRITE_OWNER");
      } finally { LocalFree(sd); }
      originals[path] = before;
    }
    SafeFileHandle handle = CreateFileW(path, access, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Pin workspace security object");
    return handle;
  }
  /** The descriptor to journal as `before`: the one PinAsOwner found, else the current one. */
  public static string Original(string path) {
    Pin(path);
    string before;
    return originals.TryGetValue(path, out before) ? before : Capture(path);
  }
  static SafeFileHandle Handle(string path) { Pin(path); return pinned[path]; }
  public static void Unpin(string path) {
    SafeFileHandle handle;
    if(pinned.TryGetValue(path, out handle)) { pinned.Remove(path); handle.Dispose(); }
  }
  public static void RequireMediumControl(string path) {
    Pin(path, 0x20000);
    var raw = new RawSecurityDescriptor(Capture(path));
    if (raw.SystemAcl == null) return; // An absent label is implicitly Medium.
    foreach (GenericAce ace in raw.SystemAcl) {
      if ((byte)ace.AceType != 0x11) continue;
      var bytes = new byte[ace.BinaryLength]; ace.GetBinaryForm(bytes, 0);
      var sid = new System.Security.Principal.SecurityIdentifier(bytes, 8);
      string[] fields = sid.Value.Split('-');
      if (UInt32.Parse(fields[fields.Length - 1]) < 8192)
        throw new InvalidOperationException("Low integrity launcher cache is unsafe; execution refused");
    }
  }
  public static string Capture(string path) { return Describe(Handle(path)); }
  static string Describe(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, sd, text = IntPtr.Zero; uint length;
    uint code = GetSecurityInfo(handle, 1, 0x14, out owner, out group, out dacl, out sacl, out sd);
    if(code != 0) throw new Win32Exception((int)code, "Capture file security");
    try {
      if(!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x14, out text, out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return Marshal.PtrToStringUni(text);
    } finally { if(text != IntPtr.Zero) LocalFree(text); LocalFree(sd); }
  }
  static string RecoveryDescriptor(string text) {
    var descriptor = new RawSecurityDescriptor(text);
    if (descriptor.SystemAcl != null) {
      foreach (GenericAce ace in descriptor.SystemAcl) {
        // Host atomic replacement inherits the identical label. Its ID bit is provenance, not a
        // permission change. Preserve exact DACL, label SID/policy, and every other inheritance flag.
        if ((byte)ace.AceType == 0x11) ace.AceFlags &= ~AceFlags.Inherited;
      }
    }
    // A legacy DACL (no auto-inherit flag) stores its inherited entries as plain explicit ACEs. Re-applying it with
    // SetSecurityInfo during grant keeps those and adds the parent's inherited copies, while an object the Host
    // atomically replaced carries only the inherited copies. An explicit ACE identical to an inherited ACE of the
    // same DACL grants nothing more, so drop it before comparing; every other entry still has to match.
    if (descriptor.DiscretionaryAcl != null) DropInheritedDuplicates(descriptor.DiscretionaryAcl);
    // .NET Framework's Access|Audit SDDL conversion omits mandatory-label ACEs. Compare the complete
    // binary descriptor so integrity SID/policy changes can never disappear from this check.
    var bytes = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(bytes, 0);
    return Convert.ToBase64String(bytes);
  }
  static string AceKey(GenericAce ace) {
    var copy = ace.Copy();
    copy.AceFlags &= ~AceFlags.Inherited;
    var bytes = new byte[copy.BinaryLength];
    copy.GetBinaryForm(bytes, 0);
    return Convert.ToBase64String(bytes);
  }
  /** Removes explicit ACEs that repeat an inherited ACE of the same ACL exactly. */
  static void DropInheritedDuplicates(RawAcl acl) {
    var inherited = new HashSet<string>(StringComparer.Ordinal);
    foreach (GenericAce ace in acl) if ((ace.AceFlags & AceFlags.Inherited) != 0) inherited.Add(AceKey(ace));
    for (int i = acl.Count - 1; i >= 0; i--)
      if ((acl[i].AceFlags & AceFlags.Inherited) == 0 && inherited.Contains(AceKey(acl[i]))) acl.RemoveAce(i);
  }
  public static bool RecoveryMatches(string expected, string actual) {
    return String.Equals(RecoveryDescriptor(expected), RecoveryDescriptor(actual), StringComparison.Ordinal);
  }
  public static void Restore(string path, string before) {
    var recorded = new RawSecurityDescriptor(before);
    if ((recorded.ControlFlags & (ControlFlags.DiscretionaryAclAutoInherited | ControlFlags.DiscretionaryAclProtected)) != 0) {
      Apply(path, before);
      return;
    }
    // A legacy DACL (neither auto-inherited nor protected) cannot go back through SetSecurityInfo: that re-derives
    // inheritance and returns its stored entries as explicit ACEs plus inherited duplicates. Write the DACL as
    // recorded instead. The kernel marks a DACL written that way over an auto-inherited one protected; setting the
    // label afterwards through SetSecurityInfo clears that mark and leaves the recorded entries untouched.
    IntPtr sd, sacl; uint length; bool present, defaulted;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(before, 1, out sd, out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      if(!SetKernelObjectSecurity(Handle(path), 4, sd)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Restore file security");
      if(!GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code = SetSecurityInfo(Handle(path), 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
      if(code != 0) throw new Win32Exception((int)code, "Restore file label");
    } finally { LocalFree(sd); }
  }
  public static void Apply(string path, string sddl) {
    IntPtr sd, dacl, sacl; uint length; bool present, defaulted;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      if(!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(!GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var raw = new RawSecurityDescriptor(sddl);
      uint flags = 0x14 | ((raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? 0x80000000u : 0x20000000u);
      uint code = SetSecurityInfo(Handle(path), 1, flags, IntPtr.Zero, IntPtr.Zero, dacl, sacl);
      if(code != 0) throw new Win32Exception((int)code, "Apply file security");
    } finally { LocalFree(sd); }
  }
}
'@

function Safe-Tree([switch]$ReadOnly) {
  $items = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  if ($items.Count -gt 100000) { throw 'Windows sandbox ACL tree exceeds 100000 objects' }
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Windows sandbox refuses reparse points in ACL trees: $($item.FullName)" }
    if ($ReadOnly) { [YuantuAcl]::PinRead($item.FullName) } else { [YuantuAcl]::Pin($item.FullName) }
  }
  return $items
}

$createdProtected = @()
trap {
  # Before a durable journal exists, rollback only our own empty reservations.
  if (-not (Test-Path -LiteralPath $Journal)) {
    foreach ($createdPath in $createdProtected) {
      if ((Test-Path -LiteralPath $createdPath -PathType Container) -and @(Get-ChildItem -LiteralPath $createdPath -Force).Count -eq 0) {
        [YuantuAcl]::Unpin($createdPath)
        Remove-Item -LiteralPath $createdPath -Force
      }
    }
  }
  throw $_
}

if ($Operation -eq 'validate-control') {
  # Batch independent control checks in one process; retain every check, including shared ancestors.
  $roots = @($Root)
  if ($ControlRoots) { $roots += $ControlRoots }
  foreach ($controlRoot in $roots) {
    $Root = $controlRoot
    # A Low parent with FILE_DELETE_CHILD could replace an otherwise Medium control directory.
    $parent = $Root
    while ($parent) {
      [YuantuAcl]::RequireMediumControl($parent)
      $directory = [IO.Directory]::GetParent($parent)
      $parent = if ($directory) { $directory.FullName } else { $null }
    }
    foreach ($item in (Safe-Tree -ReadOnly)) { [YuantuAcl]::RequireMediumControl($item.FullName) }
  }
} elseif ($Operation -eq 'grant') {
  if (Test-Path -LiteralPath $Journal) { throw 'Unrecovered Windows sandbox ACL journal exists' }
  # Validate/pin existing nodes before creating any root metadata reservations.
  $null = Safe-Tree
  foreach ($name in @('.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg')) {
    $protectedPath = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $protectedPath)) {
      [IO.Directory]::CreateDirectory($protectedPath) | Out-Null
      $createdProtected += $protectedPath
    }
  }
  $items = Safe-Tree
  # `Original`: a WRITE_OWNER ACE the owner granted itself while pinning is not part of what restore puts back.
  $entries = @($items | ForEach-Object { @{ path=$_.FullName; before=[YuantuAcl]::Original($_.FullName) } })
  # Flush a recovery record BEFORE the first security descriptor mutation.
  $json = @{ root=$Root; sid=$Sid; entries=$entries; createdProtected=$createdProtected } | ConvertTo-Json -Depth 5
  $stream = [IO.File]::Open($Journal, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  $acl = Get-Acl -LiteralPath $Root
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid), [Security.AccessControl.FileSystemRights]::Modify, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles, [Security.AccessControl.InheritanceFlags]::ContainerInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
  $dacl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  [YuantuAcl]::Apply($Root, $dacl + 'S:(ML;OICI;NW;;;LW)')
  foreach ($item in $items) {
    if ($item.Name -match '^\.(git|yuantu|agents|codex|aws|ssh|gnupg)$') {
      $protectedAcl = Get-Acl -LiteralPath $item.FullName
      $rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
      $protectedInherit = if ($item.PSIsContainer) { $inherit } else { [Security.AccessControl.InheritanceFlags]::None }
      $protectedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid), $rights, $protectedInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
      [YuantuAcl]::Apply($item.FullName, $protectedAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) + 'S:(ML;OICI;NW;;;ME)')
    }
  }
  # Explicitly set existing labels: a previous label removal can suppress subsequent inherited-label propagation.
  foreach ($item in $items) {
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new([YuantuAcl]::Capture($item.FullName))
    $access = $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $protected = $item.FullName.Substring($Root.Length).TrimStart('\') -match '(^|\\)\.(git|yuantu|agents|codex|aws|ssh|gnupg)(\\|$)'
    $integrity = if ($protected) { 'ME' } else { 'LW' }
    $label = if ($item.PSIsContainer) { 'S:(ML;OICI;NW;;;' + $integrity + ')' } else { 'S:(ML;;NW;;;' + $integrity + ')' }
    [YuantuAcl]::Apply($item.FullName, $access + $label)
  }
  foreach ($entry in $entries) { $entry.applied = [YuantuAcl]::Capture($entry.path) }
  $json = @{ root=$Root; sid=$Sid; entries=$entries; createdProtected=$createdProtected } | ConvertTo-Json -Depth 5
  $stream = [IO.File]::Open($Journal + '.next', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Replace($Journal + '.next', $Journal, [NullString]::Value)
} elseif ($Operation -eq 'restore') {
  # Read as UTF-8 to match the bytes written above. Windows PowerShell's default is the ANSI code page, which
  # silently re-decodes a workspace path containing non-ASCII characters into different text, so the restore
  # rejected its own journal with "ACL recovery root mismatch" and left the workspace inside the sandbox ACL.
  $record = Get-Content -LiteralPath $Journal -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$record.root -ne $Root) { throw 'ACL recovery root mismatch' }
  $currentItems = Safe-Tree
  # Check all original objects before restoring any of them. Concurrent operator ACL edits are never overwritten.
  foreach ($entry in $record.entries) {
    if (-not $entry.applied) { throw ('Incomplete ACL grant; reconcile original descriptors manually using journal: ' + $Journal) }
    if (-not (Test-Path -LiteralPath $entry.path)) { continue }
    $actual = [YuantuAcl]::Capture($entry.path)
    # Name the object and both descriptors: an operator reconciling the journal needs to see what differs.
    if (-not ([YuantuAcl]::RecoveryMatches([string]$entry.applied, $actual))) { throw ('ACL changed during sandbox execution; retained recovery journal: ' + $Journal + '; object: ' + $entry.path + '; expected: ' + $entry.applied + '; actual: ' + $actual) }
  }
  foreach ($entry in $record.entries) {
    if (Test-Path -LiteralPath $entry.path) { [YuantuAcl]::Restore($entry.path, [string]$entry.before) }
  }
  # Objects created during the lease have no previous label. Do not leave a new Low-integrity write surface.
  $originalPaths = @{}
  foreach ($entry in $record.entries) { $originalPaths[$entry.path] = $true }
  foreach ($item in $currentItems) {
    if (-not $originalPaths.ContainsKey($item.FullName)) {
      $raw = [Security.AccessControl.RawSecurityDescriptor]::new([YuantuAcl]::Original($item.FullName))
      $access = $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
      $label = if ($item.PSIsContainer) { 'S:(ML;OICI;NW;;;ME)' } else { 'S:(ML;;NW;;;ME)' }
      [YuantuAcl]::Apply($item.FullName, $access + $label)
    }
  }
  foreach ($createdPath in $record.createdProtected) {
    # Keep operator-created contents; only remove the empty reservation created by this lease.
    if ((Test-Path -LiteralPath $createdPath -PathType Container) -and @(Get-ChildItem -LiteralPath $createdPath -Force).Count -eq 0) {
      [YuantuAcl]::Unpin($createdPath)
      Remove-Item -LiteralPath $createdPath -Force
    }
  }
  Remove-Item -LiteralPath $Journal -Force
} else { throw 'Unknown ACL journal operation' }
