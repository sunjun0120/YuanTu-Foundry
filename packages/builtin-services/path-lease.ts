import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

// Keep every ancestor open without FILE_SHARE_DELETE. A checked path cannot be swapped for a junction
// while the lease is alive. Files additionally refuse FILE_SHARE_WRITE to freeze their contents.
// The helper only holds handles; the bytes never pass through it. Reads and creates happen in this process, by
// path, under those handles: base64 over the helper's pipes cost a 200 MB archive about 23 s and 1 GB.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FoundryPathLease {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
 [StructLayout(LayoutKind.Sequential)]
 public struct Info { public uint attrs, ct1, ct2, at1, at2, wt1, wt2, volume, sizeHigh, sizeLow, links, indexHigh, indexLow; }
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
}
'@
$held = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
while ($null -ne ($line = [Console]::In.ReadLine())) {
 try {
  $req = ConvertFrom-Json $line
  if ($req.op -eq 'ping') {
    [Console]::Out.WriteLine('{"ok":true}')
    continue
  }
  if ($req.op -eq 'mkdir') {
    [void][System.IO.Directory]::CreateDirectory($req.path)
    [Console]::Out.WriteLine('{"ok":true}')
    continue
  }
  $share = if ($req.directory) { 3 } else { 1 }
  $h = [FoundryPathLease]::CreateFileW($req.path, 1, $share, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
  if ($h.IsInvalid) { throw "Cannot lock path (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  $info = New-Object FoundryPathLease+Info
  if (-not [FoundryPathLease]::GetFileInformationByHandle($h, [ref]$info)) { $h.Dispose(); throw 'Cannot inspect locked path' }
  if (($info.attrs -band 0x400) -ne 0) { $h.Dispose(); throw 'A link or reparse point is not allowed' }
  if ((($info.attrs -band 0x10) -ne 0) -ne [bool]$req.directory) { $h.Dispose(); throw 'Unexpected file type' }
  $held.Add($h)
  # The volume serial and file index of the held object, which the caller matches against what it opened itself.
  [Console]::Out.WriteLine('{"ok":true,"volume":"' + ('{0:x}' -f $info.volume) + '","index":"' + ('{0:x8}{1:x8}' -f $info.indexHigh, $info.indexLow) + '"}')
 } catch {
  [Console]::Out.WriteLine((@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
 }
}
foreach ($h in $held) { $h.Dispose() }
`;

/** A lease deliberately fails closed on systems without this handle-based implementation. */
export class PathLease {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly locked = new Set<string>();
  /** Per locked file, the volume serial and file index of the object the helper holds. */
  private readonly files = new Map<string, { volume: bigint; index: bigint }>();
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }

  /** Whether this platform has the handle-based implementation; everywhere else `open` refuses. */
  static supported(platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'win32';
  }

  static async open(
    signal?: AbortSignal,
    executable = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  ): Promise<PathLease> {
    if (!PathLease.supported())
      throw new Error('Secure path leases are unavailable on this platform');
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      },
    );
    child.stderr.resume();
    child.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    return new PathLease(child);
  }

  private async request(
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; volume?: string; index?: string }> {
    if (
      this.closed ||
      this.child.pid === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      throw new Error('Path lease helper exited');
    const lines = createInterface({ input: this.child.stdout });
    try {
      const answer = new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          this.child.off('error', failed);
          this.child.off('exit', exited);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exited = () => failed(new Error('Path lease helper exited'));
        lines.once('line', (line) => {
          cleanup();
          resolve(line);
        });
        this.child.once('error', failed);
        this.child.once('exit', exited);
      });
      this.child.stdin.write(`${JSON.stringify(input)}\n`);
      const parsed = JSON.parse(await answer) as {
        ok: boolean;
        error?: string;
        volume?: string;
        index?: string;
      };
      if (!parsed.ok) throw new Error(parsed.error ?? 'Secure filesystem operation failed');
      return parsed;
    } finally {
      lines.close();
    }
  }

  private async lockOne(target: string, directory: boolean): Promise<void> {
    const key = path.resolve(target).toLowerCase();
    if (this.locked.has(key)) return;
    const reply = await this.request({ path: target, directory });
    if (!directory) {
      if (typeof reply.volume !== 'string' || typeof reply.index !== 'string')
        throw new Error('Invalid secure lock response');
      this.files.set(key, {
        volume: BigInt(`0x${reply.volume}`),
        index: BigInt(`0x${reply.index}`),
      });
    }
    this.locked.add(key);
  }

  /**
   * Reads a locked file in this process.
   *
   * The handles the helper holds keep the path from being swapped and the contents from being written, so a read by
   * path sees the held file. That is still checked rather than assumed: the opened file must have the volume and
   * file index the helper reported, and the helper must still be alive once the read is done.
   */
  async readFile(target: string): Promise<Buffer> {
    const identity = this.files.get(path.resolve(target).toLowerCase());
    if (!identity) throw new Error('File is not locked');
    await this.request({ op: 'ping' });
    const handle = await open(target, 'r');
    let bytes: Buffer;
    try {
      const info = await handle.stat({ bigint: true });
      if (info.dev !== identity.volume || info.ino !== identity.index)
        throw new Error('File changed while it was locked');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    await this.request({ op: 'ping' });
    return bytes;
  }

  async mkdir(target: string): Promise<void> {
    if (!this.locked.has(path.resolve(path.dirname(target)).toLowerCase()))
      throw new Error('Parent is not locked');
    await this.request({ op: 'mkdir', path: target });
  }

  /** Creates a new file in a locked directory; an existing name fails with `EEXIST` and is never replaced. */
  async createFile(target: string, bytes: Buffer): Promise<void> {
    if (!this.locked.has(path.resolve(path.dirname(target)).toLowerCase()))
      throw new Error('Parent is not locked');
    await this.request({ op: 'ping' });
    const handle = await open(target, 'wx');
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await this.request({ op: 'ping' });
  }

  async lockDirectory(target: string): Promise<void> {
    const absolute = path.resolve(target);
    const root = path.parse(absolute).root;
    let current = root;
    await this.lockOne(current, true);
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      await this.lockOne(current, true);
    }
  }

  async lockFile(target: string): Promise<void> {
    await this.lockDirectory(path.dirname(target));
    await this.lockOne(path.resolve(target), false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (
      this.child.pid === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    await exited;
  }
}
