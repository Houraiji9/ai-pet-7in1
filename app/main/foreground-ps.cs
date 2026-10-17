using System; using System.Text; using System.Runtime.InteropServices;
public static class AiPetFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint n);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackageFamilyName(IntPtr h, ref uint n, StringBuilder s);
  // 返回 [pid, path, packageFamily, title]；没有前台窗口时返回 null
  public static string[] Read(bool withTitle) {
    IntPtr w = GetForegroundWindow(); if (w == IntPtr.Zero) return null;
    uint pid; GetWindowThreadProcessId(w, out pid); if (pid == 0) return null;
    string title = "";
    if (withTitle) { var tb = new StringBuilder(1024); GetWindowTextW(w, tb, 1024); title = tb.ToString(); }
    string path = "", pkg = "";
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h != IntPtr.Zero) {
      try {
        var sb = new StringBuilder(32768); uint n = 32768;
        if (QueryFullProcessImageNameW(h, 0, sb, ref n)) path = sb.ToString();
        try { var pb = new StringBuilder(1024); uint pn = 1024; if (GetPackageFamilyName(h, ref pn, pb) == 0) pkg = pb.ToString(); } catch { }
      } finally { CloseHandle(h); }
    }
    return new string[] { pid.ToString(), path, pkg, title };
  }
}
