$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class UnityReturnEvidenceDeletion
{
    private const uint Delete = 0x00010000;
    private const uint FileReadData = 0x00000001;
    private const uint FileReadAttributes = 0x00000080;
    private const uint ShareRead = 0x00000001;
    private const uint ShareReadDelete = 0x00000005;
    private const uint OpenExisting = 3;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const int FileBasicInfo = 0;
    private const int FileDispositionInfo = 4;
    private const long WindowsEpochTicks = 116444736000000000L;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;

        public ulong Value
        {
            get { return ((ulong)High << 32) | Low; }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint Attributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;

        public ulong FileIndex
        {
            get { return ((ulong)FileIndexHigh << 32) | FileIndexLow; }
        }

        public ulong FileSize
        {
            get { return ((ulong)FileSizeHigh << 32) | FileSizeLow; }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInformation
    {
        [MarshalAs(UnmanagedType.U1)]
        public bool DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileBasicInformation
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint Attributes;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FileBasicInformation information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int informationClass,
        ref FileDispositionInformation information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        SafeFileHandle file,
        byte[] buffer,
        uint bytesToRead,
        out uint bytesRead,
        IntPtr overlapped);

    private static SafeFileHandle Open(string path, bool directory)
    {
        uint flags = FileFlagOpenReparsePoint;
        if (directory)
        {
            flags |= FileFlagBackupSemantics;
        }
        SafeFileHandle handle = CreateFile(
            path,
            Delete | FileReadAttributes | (directory ? 0u : FileReadData),
            directory ? ShareReadDelete : ShareRead,
            IntPtr.Zero,
            OpenExisting,
            flags,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return handle;
    }

    private static ByHandleFileInformation Information(SafeFileHandle handle)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return information;
    }

    private static FileBasicInformation BasicInformation(SafeFileHandle handle)
    {
        FileBasicInformation information;
        if (!GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            out information,
            (uint)Marshal.SizeOf(typeof(FileBasicInformation))))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return information;
    }

    private static ulong Unsigned(string value)
    {
        return UInt64.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture);
    }

    private static ulong UnixNanosecondsToFileTime(string value)
    {
        long nanoseconds = Int64.Parse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        checked
        {
            return (ulong)(nanoseconds / 100L + WindowsEpochTicks);
        }
    }

    private static void Validate(
        ByHandleFileInformation actual,
        string expectedDevice,
        string expectedFileIndex,
        string expectedSize,
        string expectedLinks,
        string expectedBirthtime,
        string expectedMtime,
        bool directory)
    {
        bool actualDirectory = (actual.Attributes & FileAttributeDirectory) != 0;
        if (
            actualDirectory != directory ||
            (actual.Attributes & FileAttributeReparsePoint) != 0 ||
            actual.VolumeSerialNumber != Unsigned(expectedDevice) ||
            actual.FileIndex != Unsigned(expectedFileIndex) ||
            actual.FileSize != Unsigned(expectedSize) ||
            actual.NumberOfLinks != Unsigned(expectedLinks) ||
            actual.CreationTime.Value != UnixNanosecondsToFileTime(expectedBirthtime) ||
            actual.LastWriteTime.Value != UnixNanosecondsToFileTime(expectedMtime))
        {
            throw new InvalidOperationException("Return evidence identity changed.");
        }
    }

    private static void ValidateChangeTime(
        SafeFileHandle handle,
        string expectedCtime)
    {
        if ((ulong)BasicInformation(handle).ChangeTime != UnixNanosecondsToFileTime(expectedCtime))
        {
            throw new InvalidOperationException("Return evidence change time changed.");
        }
    }

    private static void ValidateDigest(
        SafeFileHandle handle,
        string expectedDigest,
        string expectedSize)
    {
        ulong unsignedSize = Unsigned(expectedSize);
        if (unsignedSize > Int32.MaxValue)
        {
            throw new InvalidOperationException("Return evidence is too large to hash.");
        }
        byte[] data = new byte[(int)unsignedSize];
        int offset = 0;
        while (offset < data.Length)
        {
            uint bytesRead;
            uint requested = (uint)Math.Min(65536, data.Length - offset);
            byte[] chunk = new byte[(int)requested];
            if (!ReadFile(handle, chunk, requested, out bytesRead, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (bytesRead == 0)
            {
                throw new InvalidOperationException("Return evidence ended during hashing.");
            }
            Buffer.BlockCopy(chunk, 0, data, offset, (int)bytesRead);
            offset += (int)bytesRead;
        }
        byte[] trailing = new byte[1];
        uint trailingRead;
        if (!ReadFile(handle, trailing, 1, out trailingRead, IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (trailingRead != 0)
        {
            throw new InvalidOperationException("Return evidence grew during hashing.");
        }
        using (SHA256 sha256 = SHA256.Create())
        {
            string actual = BitConverter.ToString(sha256.ComputeHash(data))
                .Replace("-", "")
                .ToLowerInvariant();
            if (!String.Equals(actual, expectedDigest, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Return evidence digest changed.");
            }
        }
    }

    private static void MarkForDeletion(SafeFileHandle handle)
    {
        FileDispositionInformation disposition = new FileDispositionInformation { DeleteFile = true };
        if (!SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            ref disposition,
            (uint)Marshal.SizeOf(typeof(FileDispositionInformation))))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Delete(
        string directoryPath,
        string filePath,
        string directoryDevice,
        string directoryFileIndex,
        string directorySize,
        string directoryLinks,
        string directoryBirthtime,
        string directoryMtime,
        string directoryCtime,
        string fileDevice,
        string fileFileIndex,
        string fileSize,
        string fileLinks,
        string fileBirthtime,
        string fileMtime,
        string fileCtime,
        string expectedDigest)
    {
        SafeFileHandle directory;
        try
        {
            directory = Open(directoryPath, true);
        }
        catch
        {
            throw new InvalidOperationException("open-directory");
        }
        using (directory)
        {
            try
            {
                Validate(
                    Information(directory),
                    directoryDevice,
                    directoryFileIndex,
                    directorySize,
                    directoryLinks,
                    directoryBirthtime,
                    directoryMtime,
                    true);
                ValidateChangeTime(directory, directoryCtime);
            }
            catch
            {
                throw new InvalidOperationException("validate-directory");
            }
            SafeFileHandle file;
            try
            {
                file = Open(filePath, false);
            }
            catch
            {
                throw new InvalidOperationException("open-file");
            }
            using (file)
            {
                try
                {
                    Validate(
                        Information(file),
                        fileDevice,
                        fileFileIndex,
                        fileSize,
                        fileLinks,
                        fileBirthtime,
                        fileMtime,
                        false);
                    ValidateChangeTime(file, fileCtime);
                }
                catch
                {
                    throw new InvalidOperationException("validate-file");
                }
                try
                {
                    ValidateDigest(file, expectedDigest, fileSize);
                }
                catch
                {
                    throw new InvalidOperationException("hash-file");
                }
                try
                {
                    if (Information(file).NumberOfLinks != 1)
                    {
                        throw new InvalidOperationException();
                    }
                    MarkForDeletion(file);
                }
                catch
                {
                    throw new InvalidOperationException("delete-file");
                }
            }
            try
            {
                MarkForDeletion(directory);
            }
            catch
            {
                throw new InvalidOperationException("delete-directory");
            }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
} catch {
    if ($env:UNITY_DELETE_TEST_DIAGNOSTICS -eq "true") {
        [Console]::Error.WriteLine("native-stage: compile")
        $compilerDiagnostics = (@($_) + @($Error | Select-Object -First 20) | Out-String)
        $safeDiagnostics = [regex]::Matches(
            $compilerDiagnostics,
            'CS[0-9]{4}:[^\r\n]*'
        ) | ForEach-Object { $_.Value } | Select-Object -Unique
        foreach ($diagnostic in $safeDiagnostics) {
            [Console]::Error.WriteLine("native-compiler: " + $diagnostic)
        }
    }
    exit 1
}

try {
    [UnityReturnEvidenceDeletion]::Delete(
        $env:UNITY_DELETE_DIRECTORY_PATH,
        $env:UNITY_DELETE_FILE_PATH,
        $env:UNITY_DELETE_DIRECTORY_DEV,
        $env:UNITY_DELETE_DIRECTORY_INO,
        $env:UNITY_DELETE_DIRECTORY_SIZE,
        $env:UNITY_DELETE_DIRECTORY_NLINK,
        $env:UNITY_DELETE_DIRECTORY_BIRTHTIME_NS,
        $env:UNITY_DELETE_DIRECTORY_MTIME_NS,
        $env:UNITY_DELETE_DIRECTORY_CTIME_NS,
        $env:UNITY_DELETE_FILE_DEV,
        $env:UNITY_DELETE_FILE_INO,
        $env:UNITY_DELETE_FILE_SIZE,
        $env:UNITY_DELETE_FILE_NLINK,
        $env:UNITY_DELETE_FILE_BIRTHTIME_NS,
        $env:UNITY_DELETE_FILE_MTIME_NS,
        $env:UNITY_DELETE_FILE_CTIME_NS,
        $env:UNITY_DELETE_EXPECTED_DIGEST
    )
} catch {
    if ($env:UNITY_DELETE_TEST_DIAGNOSTICS -eq "true") {
        $allowedStages = @(
            "open-directory",
            "validate-directory",
            "open-file",
            "validate-file",
            "hash-file",
            "delete-file",
            "delete-directory"
        )
        $stage = "unknown"
        $current = $_.Exception
        while ($null -ne $current) {
            foreach ($candidate in $allowedStages) {
                if ($current.Message.Contains($candidate)) {
                    $stage = $candidate
                    break
                }
            }
            if ($stage -ne "unknown") {
                break
            }
            $current = $current.InnerException
        }
        [Console]::Error.WriteLine("native-stage: " + $stage)
    }
    exit 1
}
