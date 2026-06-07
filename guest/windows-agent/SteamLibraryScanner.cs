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

        return true;
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
