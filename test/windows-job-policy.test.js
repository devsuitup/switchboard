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
    const probe = String.raw`
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
$markers = @($null, '', '"C:\Program Files\Claude\claude.exe" daemon run --origin transient --spawned-by 123', 'node "C:\cli\node_modules\@anthropic-ai\claude-code\cli.js" --bg-pty-host --id 1', 'claude daemon runner --id 1', 'claude daemon runx --id 1', 'node detached.js', 'claude -p "why does the daemon run slowly"', 'git commit -m "fix daemon run loop"', 'claude -p "--bg-pty-host"', 'node unrelated.js daemon run --origin transient', 'git --bg-pty-host', 'node "C:\cli\node_modules\@anthropic-ai\claude-code\cli.js" daemon run --origin transient --spawned-by 123', 'claude --bg-pty-host --id 1', 'claude -p "explain --bg-pty-host please"')
$matches = @($markers | ForEach-Object { [PtyJobs]::IsBackgroundAgent($_) })
$start = [PtyJobs].GetMethod('MatchesStart', $flags)
$starts = @((-101), (-100), 0, 100, 101 | ForEach-Object { $start.Invoke($null, [object[]]@([long](133000000000000000 + $_), [long]133000000000000000)) })
Write-Output ('policy:' + (@{ protected = @($protect | Sort-Object); matches = $matches; starts = $starts } | ConvertTo-Json -Compress))
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
      assert.deepEqual(actual.matches, [false, false, true, true, false, false, false, false, false, false, false, false, true, true, false]);
      assert.deepEqual(actual.starts, [false, true, true, true, false]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
