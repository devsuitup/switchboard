'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('member inspection exceptions skip those members, clean siblings and release the job with one warning',
  { skip: process.platform !== 'win32' && 'Windows job APIs only' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-job-errors-'));
    const file = path.join(dir, 'probe.ps1');
    const source = fs.readFileSync(path.join(__dirname, '../src/main/terminals/windows-job-helper.ps1'), 'utf8');
    const probe = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
public class MemberFaults : IEqualityComparer<uint> {
 public HashSet<uint> Fail = new HashSet<uint>();
 public bool Equals(uint a, uint b) { return a == b; }
 public int GetHashCode(uint pid) { if (Fail.Contains(pid)) throw new InvalidOperationException("member fault"); return (int)pid; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 public static string Run(Type type, string node) {
  var flags = BindingFlags.Static | BindingFlags.NonPublic;
  var assign = type.GetMethod("Assign", flags);
  var finish = type.GetMethod("Finish", flags);
  var jobs = (Dictionary<string, IntPtr>)type.GetField("Jobs", flags).GetValue(null);
  var children = new List<Process>();
  try {
   for (int i = 0; i < 3; i++) children.Add(Process.Start(new ProcessStartInfo(node, "-e \"setTimeout(()=>{},20000)\"") { UseShellExecute = false, CreateNoWindow = true }));
   long now = (long)(DateTime.UtcNow - new DateTime(1970,1,1)).TotalMilliseconds;
   int assigned = (int)assign.Invoke(null, new object[] { "faults", (uint)children[0].Id, now });
   if (assigned != 0) throw new Exception("assign failed: " + assigned);
   for (int i = 1; i < children.Count; i++) if (!AssignProcessToJobObject(jobs["faults"], children[i].Handle)) throw new Exception("sibling assignment failed");
   var comparer = new MemberFaults();
   var roster = new Dictionary<uint,long>(comparer);
   roster.Add(uint.MaxValue, 1);
   comparer.Fail.Add((uint)children[0].Id); comparer.Fail.Add((uint)children[1].Id);
   int error = (int)finish.Invoke(null, new object[] { "faults", true, roster });
   bool siblingExited = children[2].WaitForExit(3000);
   return error + ":" + children[0].HasExited + ":" + children[1].HasExited + ":" + siblingExited + ":" + jobs.ContainsKey("faults");
  } finally {
   if (jobs.ContainsKey("faults")) finish.Invoke(null, new object[] { "faults", false, new Dictionary<uint,long>() });
   foreach (var child in children) { if (!child.HasExited) child.Kill(); child.WaitForExit(3000); child.Dispose(); }
  }
 }
}
'@
Write-Output ('faults:' + [MemberFaults]::Run([PtyJobs], $env:SB_TEST_NODE))
`;
    try {
      fs.writeFileSync(file, source + probe);
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-File', file], { input: '', encoding: 'utf8', windowsHide: true, timeout: 20000,
          env: { ...process.env, SB_TEST_NODE: process.execPath } });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /faults:87:False:False:True:False/, 'failed members survive while the sibling is cleaned and the job released');
      assert.equal((result.stderr.match(/member cleanup failed/g) || []).length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20 }); }
  });
