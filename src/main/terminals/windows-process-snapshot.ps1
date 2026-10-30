$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProcessSnapshot897 {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int n, out int size);
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct Entry {
    public uint Next, Threads;
    public long PrivateSize;
    public uint HardFaults, ThreadPeak;
    public ulong Cycles;
    public long Created, UserTime, KernelTime;
    public UnicodeString Name;
    public int Priority;
    public IntPtr Pid, Parent;
  }
  public sealed class Row { public long pid; public long parentPid; public string created; }
  public static Row[] Read() {
    int size = 1024 * 1024;
    for (int attempt = 0; attempt < 4; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int needed;
        int status = NtQuerySystemInformation(5, buffer, size, out needed);
        if (status == unchecked((int)0xc0000004)) { size = Math.Max(size * 2, needed + 65536); continue; }
        if (status != 0) throw new InvalidOperationException("NTSTATUS " + status);
        var rows = new List<Row>();
        int offset = 0;
        while (true) {
          Entry entry = (Entry)Marshal.PtrToStructure(IntPtr.Add(buffer, offset), typeof(Entry));
          rows.Add(new Row { pid = entry.Pid.ToInt64(), parentPid = entry.Parent.ToInt64(), created = entry.Created.ToString(System.Globalization.CultureInfo.InvariantCulture) });
          if (entry.Next == 0) return rows.ToArray();
          offset = checked(offset + (int)entry.Next);
          if (offset > size - Marshal.SizeOf(typeof(Entry))) throw new InvalidOperationException("Invalid process snapshot");
        }
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("Process snapshot grew too large");
  }
}
'@
@([ProcessSnapshot897]::Read()) | ConvertTo-Json -Compress
