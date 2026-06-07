using System.Text.RegularExpressions;

internal static partial class SteamLibraryScanner
{
    public static SteamScanCatalog Scan()
    {
        var steamRoots = GetCandidateSteamRoots()
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(Directory.Exists)
            .ToList();

        var libraryRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var steamRoot in steamRoots)
        {
            libraryRoots.Add(steamRoot);

            var libraryFoldersPath = Path.Combine(steamRoot, "steamapps", "libraryfolders.vdf");

            if (!File.Exists(libraryFoldersPath))
            {
                continue;
            }

            foreach (var libraryRoot in ParseLibraryRoots(libraryFoldersPath))
            {
                if (Directory.Exists(libraryRoot))
                {
                    libraryRoots.Add(Path.GetFullPath(libraryRoot));
                }
            }
        }

        var games = new List<GameRecord>();

        foreach (var libraryRoot in libraryRoots.OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            var steamAppsPath = Path.Combine(libraryRoot, "steamapps");

            if (!Directory.Exists(steamAppsPath))
            {
                continue;
            }

            foreach (var manifestPath in Directory.EnumerateFiles(steamAppsPath, "appmanifest_*.acf"))
            {
                if (TryParseAppManifest(manifestPath, libraryRoot, out var game))
                {
                    games.Add(game);
                }
            }
        }

        return new SteamScanCatalog
        {
            Games = games
                .GroupBy(game => game.Id, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderBy(game => game.Title, StringComparer.OrdinalIgnoreCase)
                .ToList(),
            LibraryRoots = libraryRoots.Count
        };
    }

    private static IEnumerable<string> GetCandidateSteamRoots()
    {
        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Steam");
        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Steam");
    }

    private static IEnumerable<string> ParseLibraryRoots(string libraryFoldersPath)
    {
        var content = File.ReadAllText(libraryFoldersPath);

        foreach (Match match in LibraryPathRegex().Matches(content))
        {
            var rawPath = match.Groups["path"].Value;

            if (string.IsNullOrWhiteSpace(rawPath))
            {
                continue;
            }

            yield return rawPath.Replace(@"\\", @"\");
        }
    }

    private static bool TryParseAppManifest(string manifestPath, string libraryRoot, out GameRecord game)
    {
        game = new GameRecord();

        var content = File.ReadAllText(manifestPath);
        var appId = ReadManifestValue(content, "appid");
        var title = ReadManifestValue(content, "name");
        var installDir = ReadManifestValue(content, "installdir");

        if (string.IsNullOrWhiteSpace(appId) || string.IsNullOrWhiteSpace(title))
        {
            return false;
        }

        var installRoot = string.IsNullOrWhiteSpace(installDir)
            ? libraryRoot
            : Path.Combine(libraryRoot, "steamapps", "common", installDir);

        game = new GameRecord
        {
            Id = $"steam:app-{appId}",
            Title = title,
            Launcher = "steam",
            InstallState = "installed",
            LaunchCommandRef = $"steam://run/{appId}",
            LastSeenAt = DateTimeOffset.UtcNow.ToString("O"),
            CompatibilityFlags =
            [
                "prototype",
                "single-gpu-vfio-risk"
            ],
            GuestMetadata = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["installRoot"] = installRoot,
                ["launcherAppId"] = appId,
                ["steamLibraryRoot"] = libraryRoot,
                ["steamManifestPath"] = manifestPath,
                ["discoverySource"] = "steam-appmanifest",
                ["launchStrategy"] = "steam-handoff-or-simulated-fallback"
            }
        };

        var candidateProcessNames = GetCandidateProcessNames(installRoot);

        if (candidateProcessNames.Count > 0)
        {
            game.GuestMetadata["candidateProcessNames"] = string.Join(";", candidateProcessNames);
        }

        return true;
    }

    private static List<string> GetCandidateProcessNames(string installRoot)
    {
        if (!Directory.Exists(installRoot))
        {
            return [];
        }

        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pendingDirectories = new Queue<(string path, int depth)>();
        pendingDirectories.Enqueue((installRoot, 0));

        while (pendingDirectories.Count > 0 && candidates.Count < 12)
        {
            var (path, depth) = pendingDirectories.Dequeue();

            IEnumerable<string> executablePaths;

            try
            {
                executablePaths = Directory.EnumerateFiles(path, "*.exe", SearchOption.TopDirectoryOnly);
            }
            catch
            {
                continue;
            }

            foreach (var executablePath in executablePaths)
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

            if (depth >= 1)
            {
                continue;
            }

            IEnumerable<string> childDirectories;

            try
            {
                childDirectories = Directory.EnumerateDirectories(path);
            }
            catch
            {
                continue;
            }

            foreach (var childDirectory in childDirectories.Take(8))
            {
                pendingDirectories.Enqueue((childDirectory, depth + 1));
            }
        }

        return candidates
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static bool IsIgnoredExecutable(string processName)
    {
        var ignored = processName.ToLowerInvariant();
        return ignored.Contains("unins")
            || ignored.Contains("setup")
            || ignored.Contains("crash")
            || ignored.Contains("report");
    }

    private static string? ReadManifestValue(string content, string key)
    {
        var match = Regex.Match(
            content,
            $"\"{Regex.Escape(key)}\"\\s+\"(?<value>[^\"]+)\"",
            RegexOptions.IgnoreCase);

        return match.Success ? match.Groups["value"].Value : null;
    }

    [GeneratedRegex("\"path\"\\s+\"(?<path>[^\"]+)\"", RegexOptions.IgnoreCase)]
    private static partial Regex LibraryPathRegex();
}

internal sealed class SteamScanCatalog
{
    public List<GameRecord> Games { get; set; } = [];
    public int LibraryRoots { get; set; }
}
