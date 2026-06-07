using System.Diagnostics;

internal static class SteamGameLauncher
{
    public static SteamLaunchAttempt TryLaunch(GameRecord game)
    {
        if (!string.Equals(game.Launcher, "steam", StringComparison.OrdinalIgnoreCase))
        {
            return SteamLaunchAttempt.Skip("Real launch execution is only implemented for Steam titles.");
        }

        if (!OperatingSystem.IsWindows())
        {
            return SteamLaunchAttempt.Skip("Real Steam launch can only run on a Windows guest.");
        }

        if (!game.GuestMetadata.TryGetValue("launcherAppId", out var launcherAppId) ||
            string.IsNullOrWhiteSpace(launcherAppId))
        {
            return SteamLaunchAttempt.Fail("Steam launch metadata is missing launcherAppId.");
        }

        try
        {
            var steamExecutable = ResolveSteamExecutable(game);

            if (steamExecutable is not null)
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = steamExecutable,
                    Arguments = $"-applaunch {launcherAppId}",
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(steamExecutable)
                });

                return SteamLaunchAttempt.CreateStarted(
                    $"Started Steam launch through {steamExecutable}.",
                    "steam-executable");
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = $"steam://run/{launcherAppId}",
                UseShellExecute = true
            });

            return SteamLaunchAttempt.CreateStarted(
                $"Started Steam launch through steam://run/{launcherAppId}.",
                "steam-protocol");
        }
        catch (Exception exception)
        {
            return SteamLaunchAttempt.Fail($"Steam launch handoff failed: {exception.Message}");
        }
    }

    private static string? ResolveSteamExecutable(GameRecord game)
    {
        var candidatePaths = new List<string>();

        if (game.GuestMetadata.TryGetValue("steamLibraryRoot", out var steamLibraryRoot) &&
            !string.IsNullOrWhiteSpace(steamLibraryRoot))
        {
            candidatePaths.Add(Path.Combine(steamLibraryRoot, "steam.exe"));
        }

        candidatePaths.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Steam",
            "steam.exe"));
        candidatePaths.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Steam",
            "steam.exe"));

        return candidatePaths
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(File.Exists);
    }
}

internal sealed class SteamLaunchAttempt
{
    public bool Started { get; init; }
    public bool ShouldRunSimulatedLifecycle { get; init; }
    public string Detail { get; init; } = "";
    public string Mode { get; init; } = "simulated";

    public static SteamLaunchAttempt CreateStarted(string detail, string mode)
    {
        return new SteamLaunchAttempt
        {
            Started = true,
            ShouldRunSimulatedLifecycle = true,
            Detail = detail,
            Mode = mode
        };
    }

    public static SteamLaunchAttempt Skip(string detail)
    {
        return new SteamLaunchAttempt
        {
            Started = false,
            ShouldRunSimulatedLifecycle = true,
            Detail = detail,
            Mode = "simulated"
        };
    }

    public static SteamLaunchAttempt Fail(string detail)
    {
        return new SteamLaunchAttempt
        {
            Started = false,
            ShouldRunSimulatedLifecycle = false,
            Detail = detail,
            Mode = "failed"
        };
    }
}
