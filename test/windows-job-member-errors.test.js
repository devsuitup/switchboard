'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const strict of [false, true]) test(`member inspection exceptions protect descendants and clean siblings (retained=${strict})`,
  { skip: process.platform !== 'win32' && 'Windows job APIs only' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-job-errors-'));
    const file = path.join(dir, 'probe.ps1');
    const parentFile = path.join(dir, 'parent.cjs');
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
  Process descendant = null;
  try {
   for (int i = 0; i < 3; i++) children.Add(Process.Start(new ProcessStartInfo(node, i == 0 ? "\"" + Environment.GetEnvironmentVariable("SB_TEST_PARENT") + "\"" : "-e \"process.stdin.resume()\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true }));
   long now = (long)(DateTime.UtcNow - new DateTime(1970,1,1)).TotalMilliseconds;
   int assigned = (int)assign.Invoke(null, new object[] { "faults", (uint)children[0].Id, now });
   if (assigned != 0) throw new Exception("assign failed: " + assigned);
   for (int i = 1; i < children.Count; i++) if (!AssignProcessToJobObject(jobs["faults"], children[i].Handle)) throw new Exception("sibling assignment failed");
   children[0].StandardInput.WriteLine("spawn"); children[0].StandardInput.Flush();
   descendant = Process.GetProcessById(int.Parse(children[0].StandardOutput.ReadLine()));
   var comparer = new MemberFaults();
   var roster = new Dictionary<uint,long>(comparer);
   roster.Add(uint.MaxValue, 1);
   comparer.Fail.Add((uint)children[0].Id); comparer.Fail.Add((uint)children[1].Id);
   int error = Environment.GetEnvironmentVariable("SB_TEST_STRICT") == "true"
    ? (int)type.GetMethod("TerminateMembers", flags).Invoke(null, new object[] { jobs["faults"], roster, true })
    : (int)finish.Invoke(null, new object[] { "faults", true, roster });
   bool siblingExited = children[2].WaitForExit(3000);
   return error + ":" + children[0].HasExited + ":" + children[1].HasExited + ":" + siblingExited + ":" + jobs.ContainsKey("faults") + ":" + descendant.HasExited;
  } finally {
   if (jobs.ContainsKey("faults")) finish.Invoke(null, new object[] { "faults", false, new Dictionary<uint,long>() });
   if (descendant != null) { if (!descendant.HasExited) descendant.Kill(); descendant.WaitForExit(3000); descendant.Dispose(); }
   foreach (var child in children) { if (!child.HasExited) child.Kill(); child.WaitForExit(3000); child.Dispose(); }
  }
 }
}
'@
Write-Output ('faults:' + [MemberFaults]::Run([PtyJobs], $env:SB_TEST_NODE))
`;
    try {
      fs.writeFileSync(parentFile, `
const { spawn } = require('node:child_process');
process.stdin.once('data', () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  process.stdout.write(child.pid + '\\n');
});
process.stdin.resume();
`);
      fs.writeFileSync(file, source + probe);
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-File', file], { input: 'unknown invalid\n', encoding: 'utf8', windowsHide: true, timeout: 20000,
          env: { ...process.env, SB_TEST_NODE: process.execPath, SB_TEST_PARENT: parentFile, SB_TEST_STRICT: String(strict) } });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /error invalid 87/, 'protocol errors retain ERROR_INVALID_PARAMETER');
      assert.match(result.stdout, /faults:299:/, 'member inspection failures return the distinct member-skipped code');
      assert.match(result.stdout, new RegExp(`faults:\\d+:False:False:True:${strict ? 'True' : 'False'}:False`),
        'the child of a faulted member must survive termination while siblings are cleaned and the job lifetime is respected');
      assert.equal((result.stderr.match(/member cleanup failed/g) || []).length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20 }); }
  });
