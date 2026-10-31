$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PtyJobs {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessBasic { public IntPtr Reserved, Peb, Reserved2, Reserved3, Pid, Parent; }
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, Maximum; public IntPtr Buffer; }
 sealed class Member { public uint Pid, Parent; public long Created; }
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref Extended info, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint size, out uint needed);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, IntPtr info, int size, out int needed);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
 static readonly Dictionary<string, IntPtr> Jobs = new Dictionary<string, IntPtr>();
 static bool commandWarning;
 static bool Limits(IntPtr job, uint flags) { var info = new Extended(); info.Basic.Flags = flags; return SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info)); }
 static int Error() { return Marshal.GetLastWin32Error(); }
 static int Assign(string id, uint pid, long spawn) {
  if (Jobs.ContainsKey(id)) return 183;
  IntPtr process = OpenProcess(0x101101, false, pid);
  if (process == IntPtr.Zero) return Error();
  IntPtr job = IntPtr.Zero;
  try {
   long created, exit, kernel, user;
   if (!GetProcessTimes(process, out created, out exit, out kernel, out user)) return Error();
   if (created > (spawn + 100) * 10000 + 116444736000000000L || WaitForSingleObject(process, 0) != 258) return 1168;
   job = CreateJobObject(IntPtr.Zero, null);
   if (job == IntPtr.Zero) return Error();
   if (!Limits(job, 0x800)) return Error();
   if (!AssignProcessToJobObject(job, process)) return Error();
   Jobs.Add(id, job); job = IntPtr.Zero;
   return 0;
  } finally { if (job != IntPtr.Zero) CloseHandle(job); CloseHandle(process); }
 }
 static List<uint> Members(IntPtr job) {
  for (int size = 1024; size <= 16777216; size *= 2) {
   IntPtr buffer = Marshal.AllocHGlobal(size);
   try {
    uint needed;
    bool ok = QueryInformationJobObject(job, 3, buffer, (uint)size, out needed);
    if (!ok) { int error = Error(); if (error == 234) continue; throw new System.ComponentModel.Win32Exception(error); }
    int count = Marshal.ReadInt32(buffer, 4);
    if (count < 0 || count > (size - 8) / IntPtr.Size) continue;
    var pids = new List<uint>();
    for (int i = 0; i < count; i++) pids.Add(unchecked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64()));
    return pids;
   } finally { Marshal.FreeHGlobal(buffer); }
  }
  throw new System.ComponentModel.Win32Exception(234);
 }
 static Member Identity(IntPtr process, uint pid) {
  long created, exit, kernel, user;
  if (!GetProcessTimes(process, out created, out exit, out kernel, out user)) return null;
  int size = Marshal.SizeOf(typeof(ProcessBasic)), needed;
  IntPtr buffer = Marshal.AllocHGlobal(size);
  try {
   if (NtQueryInformationProcess(process, 0, buffer, size, out needed) < 0) return null;
   var basic = (ProcessBasic)Marshal.PtrToStructure(buffer, typeof(ProcessBasic));
   return new Member { Pid = pid, Parent = unchecked((uint)basic.Parent.ToInt64()), Created = created };
  } finally { Marshal.FreeHGlobal(buffer); }
 }
 static string CommandLine(IntPtr process) {
  int needed;
  NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out needed);
  if (needed < Marshal.SizeOf(typeof(Unicode)) || needed > 1048576) return null;
  IntPtr buffer = Marshal.AllocHGlobal(needed);
  try {
   int returned;
   if (NtQueryInformationProcess(process, 60, buffer, needed, out returned) < 0) return null;
   var text = (Unicode)Marshal.PtrToStructure(buffer, typeof(Unicode));
   long offset = text.Buffer.ToInt64() - buffer.ToInt64();
   if (offset < 0 || offset > needed || text.Length > needed - offset || text.Length % 2 != 0) return null;
   return Marshal.PtrToStringUni(text.Buffer, text.Length / 2);
  } finally { Marshal.FreeHGlobal(buffer); }
 }
 public static bool IsBackgroundAgent(string command) {
  if (String.IsNullOrWhiteSpace(command)) return false;
  int count;
  IntPtr buffer = CommandLineToArgvW(command, out count);
  if (buffer == IntPtr.Zero) return false;
  try {
   var args = new string[count];
   for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, i * IntPtr.Size));
   string executable = System.IO.Path.GetFileName(args[0]);
   int first = 1;
   if (String.Equals(executable, "node", StringComparison.OrdinalIgnoreCase) || String.Equals(executable, "node.exe", StringComparison.OrdinalIgnoreCase)) {
    if (count < 3 || !args[1].Replace('\\', '/').EndsWith("/@anthropic-ai/claude-code/cli.js", StringComparison.OrdinalIgnoreCase)) return false;
    first = 2;
   } else if (!String.Equals(executable, "claude", StringComparison.OrdinalIgnoreCase) && !String.Equals(executable, "claude.exe", StringComparison.OrdinalIgnoreCase)) return false;
   return count > first && (args[first] == "--bg-pty-host" || count > first + 1 && args[first] == "daemon" && args[first + 1] == "run");
  } finally { LocalFree(buffer); }
 }
 static bool MatchesStart(long created, long expected) { return expected > 0 && Math.Abs(created - expected) <= 100; }
 static void WarnCommand(uint pid) {
  if (commandWarning) return;
  commandWarning = true; Console.Error.WriteLine("[pty] Windows job command-line read failed; only roster PIDs protect unreadable members (pid=" + pid + ")");
 }
 static void ProtectDescendants(Dictionary<uint, Member> members, HashSet<uint> protect) {
  bool changed;
  do {
   changed = false;
   foreach (var member in members.Values) {
    Member parent;
    if (!protect.Contains(member.Pid) && protect.Contains(member.Parent) && members.TryGetValue(member.Parent, out parent) && parent.Created <= member.Created) {
     protect.Add(member.Pid); changed = true;
    }
   }
  } while (changed);
 }
 static int TerminateMembers(IntPtr job, Dictionary<uint, long> roster) {
  var protect = new HashSet<uint>();
  var members = new Dictionary<uint, Member>();
  var pids = Members(job);
  foreach (uint pid in pids) {
   IntPtr process = OpenProcess(0x1000, false, pid);
   if (process == IntPtr.Zero) { WarnCommand(pid); continue; }
   try {
    bool inJob;
    if (!IsProcessInJob(process, job, out inJob) || !inJob) continue;
    var member = Identity(process, pid);
    if (member != null) members[pid] = member;
    long expected;
    if (member != null && roster.TryGetValue(pid, out expected) && MatchesStart(member.Created, expected)) protect.Add(pid);
    string command = CommandLine(process);
    if (command == null) WarnCommand(pid);
    if (IsBackgroundAgent(command)) protect.Add(pid);
   } finally { CloseHandle(process); }
  }
  ProtectDescendants(members, protect);
  int error = 0;
  foreach (uint pid in pids) {
   if (protect.Contains(pid)) continue;
   IntPtr process = OpenProcess(0x1001, false, pid);
   if (process == IntPtr.Zero) { int code = Error(); if (code != 87 && error == 0) error = code; continue; }
   try {
    bool inJob;
    if (!IsProcessInJob(process, job, out inJob)) { if (error == 0) error = Error(); continue; }
    if (inJob && !TerminateProcess(process, 1) && error == 0) error = Error();
   } finally { CloseHandle(process); }
  }
  return error;
 }
 static int Finish(string id, bool terminate, Dictionary<uint, long> roster) {
  IntPtr job;
  if (!Jobs.TryGetValue(id, out job)) return 0;
  int error = 0;
  try { if (terminate) error = TerminateMembers(job, roster); }
  catch (System.ComponentModel.Win32Exception ex) { error = ex.NativeErrorCode; }
  finally { Jobs.Remove(id); CloseHandle(job); }
  return error;
 }
 public static void Run() {
  Console.WriteLine("ready"); Console.Out.Flush();
  try {
   string line;
   while ((line = Console.ReadLine()) != null) {
    string[] a = line.Split(' ');
    string id = a.Length > 1 ? a[1] : "invalid";
    int error = 87;
    string response = "error";
    try {
     if (a.Length == 4 && a[0] == "assign") { error = Assign(id, uint.Parse(a[2]), long.Parse(a[3])); response = "assigned"; }
     if ((a.Length == 2 || a.Length == 3) && (a[0] == "terminate" || a[0] == "release")) {
      var roster = new Dictionary<uint, long>();
      if (a.Length == 3) foreach (string value in a[2].Split(',')) {
       string[] pair = value.Split(':'); uint pid; long created;
       if (pair.Length == 2 && uint.TryParse(pair[0], out pid) && pid > 0 && long.TryParse(pair[1], out created) && created > 0) roster[pid] = created;
      }
      error = Finish(id, a[0] == "terminate", roster); response = a[0] == "terminate" ? "terminated" : "released";
     }
    } catch { error = 87; }
    Console.WriteLine(error == 0 ? response + " " + id : "error " + id + " " + error); Console.Out.Flush();
   }
  } finally {
   foreach (IntPtr job in Jobs.Values) CloseHandle(job);
   Jobs.Clear();
  }
 }
}
'@
[PtyJobs]::Run()
