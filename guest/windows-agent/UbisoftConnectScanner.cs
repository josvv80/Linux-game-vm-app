using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

internal static partial class UbisoftConnectScanner
{
    public static UbisoftScanCatalog Scan()
    {
        if (!OperatingSystem.IsWindows())
        {
            return new UbisoftScanCatalog();
        }

        var games = new List<GameRecord>();

        games.AddRange(ScanRegistryInstalls());
        games.AddRange(ScanManifestInstalls());

        return new UbisoftScanCatalog
        {
            Games = games
                .Where(game => !string.IsNullOrWhiteSpace(game.Title))
                .GroupBy(game => game.Id, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderBy(game => game.Title, StringComparer.OrdinalIgnoreCase)
                .ToList()
        };
    }

    [SupportedOSPlatform("windows")]
    private static IEnumerable<GameRecord> ScanRegistryInstalls()
    {
        foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                using var uninstallKey = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");

                if (uninstallKey is null)
                {
                    continue;
                }

                foreach (var subKeyName in uninstallKey.GetSubKeyNames())
                {
                    using var appKey = uninstallKey.OpenSubKey(subKeyName);

                    if (appKey is null)
                    {
                        continue;
                    }

                    var title = ReadString(appKey, "DisplayName");
                    var publisher = ReadString(appKey, "Publisher");

                    if (string.IsNullOrWhiteSpace(title) || !LooksLikeUbisoftGame(title, publisher))
                    {
                        continue;
                    }

                    var installRoot = ReadString(appKey, "InstallLocation");
                    var launcherAppId = TryGetLauncherAppId(subKeyName, appKey);
                    var idSeed = launcherAppId ?? subKeyName;
                    var processNames = GetCandidateProcessNames(installRoot);

                    var metadata = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                    {
                        ["discoverySource"] = "ubisoft-registry",
                        ["launchStrategy"] = "simulated-only",
                        ["ubisoftRegistryKey"] = subKeyName
                    };

                    if (!string.IsNullOrWhiteSpace(installRoot))
                    {
                        metadata["installRoot"] = installRoot;
                    }

                    if (!string.IsNullOrWhiteSpace(launcherAppId))
                    {
                        metadata["launcherAppId"] = launcherAppId;
                    }

                    if (processNames.Count > 0)
                    {
                        metadata["candidateProcessNames"] = string.Join(";", processNames);
                    }

                    yield return CreateGameRecord(title, idSeed, launcherAppId, metadata);
                }
            }
        }
    }

    private static IEnumerable<GameRecord> ScanManifestInstalls()
    {
        foreach (var launcherRoot in GetCandidateLauncherRoots().Where(Directory.Exists))
        {
            var dataRoot = Path.Combine(launcherRoot, "data");

            if (!Directory.Exists(dataRoot))
            {
                continue;
            }

            foreach (var manifestPath in SafeEnumerateFiles(dataRoot, "*.json", maxFiles: 400))
            {
                if (!TryReadManifestGame(manifestPath, out var game))
                {
                    continue;
                }

                yield return game;
            }
        }
    }

    private static bool TryReadManifestGame(string manifestPath, out GameRecord game)
    {
        game = new GameRecord();

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            var root = document.RootElement;
            var title =
                ReadJsonString(root, "displayName") ??
                ReadJsonString(root, "name") ??
                ReadJsonString(root, "title");

            if (string.IsNullOrWhiteSpace(title) || IsLauncherTitle(title))
            {
                return false;
            }

            var launcherAppId =
                ReadJsonString(root, "productId") ??
                ReadJsonString(root, "spaceId") ??
                ReadJsonString(root, "gameId") ??
                ReadJsonString(root, "id") ??
                GetNumericPathSegment(manifestPath);

            var installRoot =
                ReadJsonString(root, "installDir") ??
                ReadJsonString(root, "installPath") ??
                ReadJsonString(root, "rootPath");
            var processNames = GetCandidateProcessNames(installRoot);

            var metadata = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["discoverySource"] = "ubisoft-connect-manifest",
                ["launchStrategy"] = "simulated-only",
                ["ubisoftManifestPath"] = manifestPath
            };

            if (!string.IsNullOrWhiteSpace(installRoot))
            {
                metadata["installRoot"] = installRoot;
            }

            if (!string.IsNullOrWhiteSpace(launcherAppId))
            {
                metadata["launcherAppId"] = launcherAppId;
            }

            if (processNames.Count > 0)
            {
                metadata["candidateProcessNames"] = string.Join(";", processNames);
            }

            game = CreateGameRecord(title, launcherAppId ?? manifestPath, launcherAppId, metadata);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static GameRecord CreateGameRecord(
        string title,
        string idSeed,
        string? launcherAppId,
        Dictionary<string, string> metadata)
    {
        return new GameRecord
        {
            Id = $"ubisoft-connect:{NormalizeIdSegment(idSeed)}",
            Title = title.Trim(),
            Launcher = "ubisoft-connect",
            InstallState = "installed",
            LaunchCommandRef = string.IsNullOrWhiteSpace(launcherAppId)
                ? "ubisoft-connect://launch"
                : $"uplay://launch/{launcherAppId}/0",
            LastSeenAt = DateTimeOffset.UtcNow.ToString("O"),
            CompatibilityFlags =
            [
                "prototype",
                "single-gpu-vfio-risk"
            ],
            GuestMetadata = metadata
        };
    }

    private static IEnumerable<string> GetCandidateLauncherRoots()
    {
        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Ubisoft",
            "Ubisoft Game Launcher");
        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Ubisoft",
            "Ubisoft Game Launcher");
    }

    private static List<string> GetCandidateProcessNames(string? installRoot)
    {
        if (string.IsNullOrWhiteSpace(installRoot) || !Directory.Exists(installRoot))
        {
            return [];
        }

        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var executablePath in SafeEnumerateFiles(installRoot, "*.exe", maxFiles: 80))
        {
            var processName = Path.GetFileNameWithoutExtension(executablePath);

            if (string.IsNullOrWhiteSpace(processName) || IsIgnoredExecutable(processName))
            {
                continue;
            }

            candidates.Add(processName);

            if (candidates.Count >= 12)
            {
                break;
            }
        }

        return candidates
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static IEnumerable<string> SafeEnumerateFiles(
        string root,
        string searchPattern,
        int maxFiles)
    {
        var pendingDirectories = new Queue<string>();
        var visitedDirectories = 0;
        var emittedFiles = 0;

        pendingDirectories.Enqueue(root);

        while (pendingDirectories.Count > 0 && emittedFiles < maxFiles && visitedDirectories < 300)
        {
            var directory = pendingDirectories.Dequeue();
            visitedDirectories += 1;

            IEnumerable<string> files;

            try
            {
                files = Directory
                    .EnumerateFiles(directory, searchPattern, SearchOption.TopDirectoryOnly)
                    .ToList();
            }
            catch
            {
                continue;
            }

            foreach (var file in files)
            {
                yield return file;
                emittedFiles += 1;

                if (emittedFiles >= maxFiles)
                {
                    yield break;
                }
            }

            IEnumerable<string> childDirectories;

            try
            {
                childDirectories = Directory
                    .EnumerateDirectories(directory)
                    .ToList();
            }
            catch
            {
                continue;
            }

            foreach (var childDirectory in childDirectories)
            {
                pendingDirectories.Enqueue(childDirectory);
            }
        }
    }

    private static bool LooksLikeUbisoftGame(string title, string? publisher)
    {
        if (IsLauncherTitle(title))
        {
            return false;
        }

        return publisher?.Contains("Ubisoft", StringComparison.OrdinalIgnoreCase) == true ||
            title.Contains("Ubisoft", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsLauncherTitle(string title)
    {
        return title.Equals("Ubisoft Connect", StringComparison.OrdinalIgnoreCase) ||
            title.Equals("Ubisoft Game Launcher", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsIgnoredExecutable(string processName)
    {
        var ignored = processName.ToLowerInvariant();
        return ignored.Contains("unins")
            || ignored.Contains("setup")
            || ignored.Contains("crash")
            || ignored.Contains("report")
            || ignored.Contains("installer")
            || ignored.Contains("launcher")
            || ignored.Contains("upc")
            || ignored.Contains("uplay");
    }

    [SupportedOSPlatform("windows")]
    private static string? TryGetLauncherAppId(string subKeyName, RegistryKey appKey)
    {
        foreach (var valueName in new[] { "UplayId", "GameId", "ProductId" })
        {
            var value = ReadString(appKey, valueName);

            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        var numericMatch = NumericSegmentRegex().Match(subKeyName);
        return numericMatch.Success ? numericMatch.Value : null;
    }

    [SupportedOSPlatform("windows")]
    private static string? ReadString(RegistryKey key, string valueName)
    {
        return key.GetValue(valueName) as string;
    }

    private static string? ReadJsonString(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString(),
            JsonValueKind.Number => property.GetRawText(),
            _ => null
        };
    }

    private static string? GetNumericPathSegment(string path)
    {
        var directory = Path.GetDirectoryName(path);

        while (!string.IsNullOrWhiteSpace(directory))
        {
            var segment = Path.GetFileName(directory);

            if (!string.IsNullOrWhiteSpace(segment) && NumericSegmentRegex().IsMatch(segment))
            {
                return segment;
            }

            directory = Path.GetDirectoryName(directory);
        }

        return null;
    }

    private static string NormalizeIdSegment(string value)
    {
        var normalized = IdUnsafeCharacterRegex()
            .Replace(value.Trim().ToLowerInvariant(), "-")
            .Trim('-');

        return string.IsNullOrWhiteSpace(normalized) ? "unknown" : normalized;
    }

    [GeneratedRegex(@"^\d+$")]
    private static partial Regex NumericSegmentRegex();

    [GeneratedRegex(@"[^a-z0-9]+")]
    private static partial Regex IdUnsafeCharacterRegex();
}

internal sealed class UbisoftScanCatalog
{
    public List<GameRecord> Games { get; set; } = [];
}
