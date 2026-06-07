using System.Diagnostics;

internal static class GameProcessWatcher
{
    public static async Task<ObservedGameProcess?> WaitForGameProcessAsync(
        GameRecord game,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        if (!game.GuestMetadata.TryGetValue("candidateProcessNames", out var candidateProcessNamesRaw) ||
            string.IsNullOrWhiteSpace(candidateProcessNamesRaw))
        {
            return null;
        }

        var candidateProcessNames = candidateProcessNamesRaw
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (candidateProcessNames.Length == 0)
        {
            return null;
        }

        var startedAt = DateTime.UtcNow;
        var installRoot = game.GuestMetadata.TryGetValue("installRoot", out var installRootValue)
            ? installRootValue
            : null;

        while (DateTime.UtcNow - startedAt < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();

            foreach (var processName in candidateProcessNames)
            {
                Process[] processes;

                try
                {
                    processes = Process.GetProcessesByName(processName);
                }
                catch
                {
                    continue;
                }

                foreach (var process in processes)
                {
                    try
                    {
                        var processPath = process.MainModule?.FileName;

                        if (!string.IsNullOrWhiteSpace(installRoot) &&
                            !string.IsNullOrWhiteSpace(processPath) &&
                            !processPath.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }

                        return new ObservedGameProcess
                        {
                            ProcessName = process.ProcessName,
                            ProcessPath = processPath
                        };
                    }
                    catch
                    {
                        return new ObservedGameProcess
                        {
                            ProcessName = process.ProcessName,
                            ProcessPath = null
                        };
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }
            }

            await Task.Delay(TimeSpan.FromMilliseconds(400), cancellationToken);
        }

        return null;
    }
}

internal sealed class ObservedGameProcess
{
    public string ProcessName { get; set; } = "";
    public string? ProcessPath { get; set; }
}
