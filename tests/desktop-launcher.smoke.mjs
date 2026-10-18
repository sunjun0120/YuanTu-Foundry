// @test-serial desktop-ui: Launches real Electron windows.
// The Windows `start-desktop` launcher and single-instance restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitFor } from './desktop-smoke-support.mjs';
process.env.YUANTU_SESSION_TITLES = 'false';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ---- merged from launcher.smoke.mjs ----
const exec = promisify(execFile);
function launch(args, env) {
  const child = spawn(process.execPath, [path.resolve('scripts/start-desktop.mjs'), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return { child, closed, output: () => output };
}
async function windowProbe(parentPid, action = 'inspect') {
  assert.ok(Number.isSafeInteger(parentPid));
  const source = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LauncherProbe {
 public delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int max);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static string Inspect(uint target,string action) {
  string result="missing";
  EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);
   if(pid==target) {var title=new StringBuilder(256);GetWindowText(h,title,256);
    if(title.ToString()=="YuanTu Agent") {
     result="visible="+IsWindowVisible(h)+" minimized="+IsIconic(h);
     if(action=="minimize")ShowWindowAsync(h,6);
     if(action=="close")PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
    }
   }return true;
  },IntPtr.Zero);return result;
 }
}
'@
$process = Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Where-Object {$_.Name -eq 'electron.exe'} | Select-Object -First 1
if(!$process) { throw 'Launcher child missing' }
[LauncherProbe]::Inspect($process.ProcessId,'${action}')
`;
  const { stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 10000 },
  );
  return stdout.trim();
}
test(
  'actual Windows launcher shows its window and duplicate launch restores the existing instance',
  { skip: process.platform !== 'win32' && 'needs Windows', timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-launch-'));
    const profile = path.join(root, 'profile');
    const args = ['--workspace', root, '--user-data-dir', profile];
    const env = {
      ...process.env,
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
    };
    const first = launch(args, env);
    let exited = false;
    void first.closed.then(() => {
      exited = true;
    });
    t.after(async () => {
      if (!exited) {
        await windowProbe(first.child.pid, 'close').catch(() => {});
        await Promise.race([first.closed, new Promise((r) => setTimeout(r, 5000))]);
      }
      if (!exited) {
        await exec('taskkill.exe', ['/PID', String(first.child.pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {});
        await first.closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    await waitFor(() => first.output().includes('[desktop] host.ready'));
    assert.equal(await windowProbe(first.child.pid), 'visible=True minimized=False');
    await windowProbe(first.child.pid, 'minimize');
    assert.match(await windowProbe(first.child.pid), /minimized=True/);
    const second = launch(args, env);
    const secondCode = await Promise.race([
      second.closed,
      new Promise((_, reject) => {
        setTimeout(() => {
          second.child.kill();
          reject(new Error('Duplicate launch failed to exit'));
        }, 10000).unref();
      }),
    ]);
    assert.equal(secondCode, 0);
    assert.match(second.output(), /Existing window activated/);
    assert.equal(await windowProbe(first.child.pid), 'visible=True minimized=False');
  },
);
