'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native protection policy rejects stale/outside parents and matches only the background markers',
  { skip: process.platform !== 'win32' && 'Windows helper policy only' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-job-policy-'));
    const file = path.join(dir, 'policy.ps1');
    const source = fs.readFileSync(path.join(__dirname, '../src/main/terminals/windows-job-helper.ps1'), 'utf8');
    const probe = `
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$method = [PtyJobs].GetMethod('ProtectDescendants', $flags)
if (!$method) { Write-Output 'missing-policy'; exit 0 }
$type = [PtyJobs].GetNestedType('Member', [Reflection.BindingFlags]'NonPublic')
$dictType = [System.Collections.Generic.Dictionary[uint32,object]].GetGenericTypeDefinition().MakeGenericType([type[]]@([uint32], $type))
$members = [Activator]::CreateInstance($dictType)
foreach ($row in @(@(12,11,300), @(11,10,200), @(10,0,100), @(13,10,50), @(14,99,200), @(15,16,200), @(16,15,200))) {
  $member = [Activator]::CreateInstance($type, $true)
  $member.Pid = [uint32]$row[0]; $member.Parent = [uint32]$row[1]; $member.Created = [long]$row[2]
  $members.Add([uint32]$row[0], $member)
}
$protect = New-Object 'System.Collections.Generic.HashSet[uint32]'
[void]$protect.Add(10); [void]$protect.Add(99)
$invokeArgs = New-Object object[] 2
$invokeArgs[0] = $members.PSObject.BaseObject
$invokeArgs[1] = $protect.PSObject.BaseObject
[void]$method.Invoke($null, $invokeArgs)
$markers = @($null, '', 'node daemon run --origin transient', 'node --bg-pty-host --id 1', 'node daemon runner --id 1', 'node daemon runx --id 1', 'node detached.js')
$matches = @($markers | ForEach-Object { [PtyJobs]::IsBackgroundAgent($_) })
Write-Output ('policy:' + (@{ protected = @($protect | Sort-Object); matches = $matches } | ConvertTo-Json -Compress))
`;
    try {
      fs.writeFileSync(file, source + probe);
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-File', file], { input: '', encoding: 'utf8', windowsHide: true, timeout: 20000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('policy:'));
      assert.ok(line, `production protection policy must execute: ${result.stdout}`);
      const actual = JSON.parse(line.slice(7));
      assert.deepEqual(actual.protected, [10, 11, 12, 99]);
      assert.deepEqual(actual.matches, [false, false, true, true, false, false, false]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
