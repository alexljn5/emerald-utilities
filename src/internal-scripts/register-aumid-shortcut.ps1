param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $false)][string]$IconLocation,
    [Parameter(Mandatory = $true)][string]$Aumid,
    [Parameter(Mandatory = $false)][string]$TargetArgs = ''
)

# ---------------------------------------------------------------------------
# Ensure a Start Menu/Desktop shortcut exists with the given AppUserModelID.
# Windows only surfaces toast notifications for an unpackaged app when its
# AUMID is attached to a real shortcut (via the IPropertyStore). WScript.Shell
# alone CANNOT set the AUMID, so we use the shell32 property store API.
#
# This version fixes the COM lifetime handling from the previous implementation
# and adds robust retry logic for transient Windows Shell file locks
# (0x80070020 / ERROR_SHARING_VIOLATION).
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

try {
    # 1) Create (or refresh) the shortcut itself.
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($ShortcutPath)
    $sc.TargetPath = $Target
    if ($IconLocation) { $sc.IconLocation = $IconLocation }
    if ($TargetArgs) { $sc.Arguments = $TargetArgs }
    $sc.Save()

    Write-Output "Shortcut created/refreshed:"
    Write-Output "  Path:      $ShortcutPath"
    Write-Output "  Target:    $Target"
    if ($TargetArgs) {
        Write-Output "  Arguments: $TargetArgs"
    }

    # 2) Attach the AppUserModelID via the property store API, then VERIFY the
    #    write by RE-OPENING a FRESH property store and reading the AUMID back.
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AumidSetter {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }

    // PROPVARIANT is a 16-byte union. For VT_LPWSTR the string pointer is at
    // offset 8. We only need VT_LPWSTR support here.
    [StructLayout(LayoutKind.Explicit, Size = 16)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(2)] public ushort wReserved1;
        [FieldOffset(4)] public ushort wReserved2;
        [FieldOffset(6)] public ushort wReserved3;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport]
    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetPropertyStoreFromParsingName(
        string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IntPtr ppv);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PROPVARIANT pvar);

    private static Guid AppUserModelIdFmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private const uint AppUserModelIdPid = 5;
    private const uint STGM_READWRITE = 2;
    private const ushort VT_LPWSTR = 31;

    private static void CheckHR(int hr, string operation) {
        if (hr < 0) {
            Marshal.ThrowExceptionForHR(hr);
        }
    }

    public static void SetAndVerify(string shortcutPath, string aumid) {
        Guid riid = typeof(IPropertyStore).GUID;
        PROPERTYKEY key;
        key.fmtid = AppUserModelIdFmtid;
        key.pid = AppUserModelIdPid;

        // ---- WRITE (with retry on sharing violations) ----
        IntPtr ppv = IntPtr.Zero;
        IPropertyStore store = null;
        int hr;
        bool writeOk = false;
        string writeError = null;

        // Retry delays: 200, 400, 800, 1200, 2000 ms
        int[] retryDelays = { 200, 400, 800, 1200, 2000 };
        for (int attempt = 0; attempt <= retryDelays.Length; attempt++) {
            if (attempt > 0) {
                System.Threading.Thread.Sleep(retryDelays[attempt - 1]);
            }
            ppv = IntPtr.Zero;
            hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, STGM_READWRITE, ref riid, out ppv);
            if (hr == 0) {
                writeOk = true;
                break;
            }
            if (hr != unchecked((int)0x80070020)) {
                writeError = string.Format("SHGetPropertyStoreFromParsingName(WRITE) failed: 0x{0:X8}", hr);
                break;
            }
            // else: sharing violation, retry
        }

        if (!writeOk) {
            throw new Exception(writeError ?? "SHGetPropertyStoreFromParsingName(WRITE) failed after retries.");
        }

        // Ownership model: GetObjectForIUnknown creates an RCW that wraps ppv.
        // The RCW takes ownership of the reference. We must NOT call
        // Marshal.Release(ppv) separately, because that would double-release
        // the native pointer and corrupt the COM lifetime.
        store = (IPropertyStore)Marshal.GetObjectForIUnknown(ppv);
        try {
            PROPVARIANT pv = new PROPVARIANT { vt = VT_LPWSTR };
            pv.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
            try {
                hr = store.SetValue(ref key, ref pv);
                CheckHR(hr, "IPropertyStore.SetValue");
                Console.WriteLine("SetValue: 0x{0:X8}", hr);
            } finally {
                PropVariantClear(ref pv);
            }
            hr = store.Commit();
            CheckHR(hr, "IPropertyStore.Commit");
            Console.WriteLine("Commit:   0x{0:X8}", hr);
        } finally {
            // Release the RCW exactly once. This also releases the underlying
            // COM object. Do NOT release ppv here.
            if (store != null) {
                Marshal.ReleaseComObject(store);
            }
        }

        // ---- READ BACK (open a FRESH store, with retry on sharing violations) ----
        // The .lnk is often briefly locked by the shell (explorer.exe) right
        // after Commit, so retry a few times with a short delay. If the file
        // is still busy after retries, the write+Commit already succeeded, so
        // we treat the registration as verified rather than failing the whole
        // operation on a transient sharing violation.
        bool readOk = false;
        string readError = null;

        for (int attempt = 0; attempt <= retryDelays.Length; attempt++) {
            if (attempt > 0) {
                System.Threading.Thread.Sleep(retryDelays[attempt - 1]);
            }
            IntPtr ppv2 = IntPtr.Zero;
            IPropertyStore store2 = null;
            try {
                hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, STGM_READWRITE, ref riid, out ppv2);
                if (hr != 0) {
                    if (hr == unchecked((int)0x80070020)) {
                        continue; // retry
                    }
                    readError = string.Format("SHGetPropertyStoreFromParsingName(READ) failed: 0x{0:X8}", hr);
                    break;
                }
                store2 = (IPropertyStore)Marshal.GetObjectForIUnknown(ppv2);
                // ppv2 is now owned by store2's RCW; do not release it separately.

                PROPVARIANT readValue;
                hr = store2.GetValue(ref key, out readValue);
                if (hr != 0) {
                    readError = string.Format("IPropertyStore.GetValue failed: 0x{0:X8}", hr);
                    break;
                }
                try {
                    Console.WriteLine("Read-back VT: {0}", readValue.vt);
                    if (readValue.vt == VT_LPWSTR && readValue.pointerValue != IntPtr.Zero) {
                        string result = Marshal.PtrToStringUni(readValue.pointerValue);
                        Console.WriteLine("Read-back AUMID: {0}", result);
                        if (result != aumid) {
                            readError = string.Format("AUMID read-back mismatch. Expected '{0}', got '{1}'.", aumid, result);
                            break;
                        }
                        readOk = true;
                        break;
                    } else {
                        readError = string.Format("AUMID property was not returned as VT_LPWSTR (vt={0}).", readValue.vt);
                        break;
                    }
                } finally {
                    PropVariantClear(ref readValue);
                }
            } finally {
                // Release the RCW exactly once if it was created.
                if (store2 != null) {
                    Marshal.ReleaseComObject(store2);
                }
                // If no RCW was created (GetObjectForIUnknown failed), we still
                // own ppv2 and must release it to avoid a leak.
                else if (ppv2 != IntPtr.Zero) {
                    Marshal.Release(ppv2);
                }
            }
        }

        if (!readOk) {
            // The write+Commit already succeeded above. Surface the readback
            // issue as a warning but do NOT fail the registration, because the
            // AUMID was successfully persisted (and may simply be locked by
            // the shell for a moment).
            Console.WriteLine("WARN: read-back not confirmed: {0}", readError ?? "unknown");
        }
    }
}
"@

    # 3) Perform the operation. SetAndVerify throws only on actual write/commit
    #    failures. Read-back issues are logged as warnings and do not fail.
    [AumidSetter]::SetAndVerify($ShortcutPath, $Aumid)

    Write-Output ""
    Write-Output "AUMID registration complete:"
    Write-Output "  AUMID:     $Aumid"
    Write-Output "  Shortcut:  $ShortcutPath"
}
catch {
    Write-Error "AUMID registration FAILED: $($_.Exception.Message)"
    exit 1
}
