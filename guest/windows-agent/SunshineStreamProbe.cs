using System.Diagnostics;
using System.Net.NetworkInformation;

internal static class SunshineStreamProbe
{
    public static readonly string[] DefaultProcessNames =
    [
        "sunshine",
        "Sunshine",
        "sunshine-tray"
    ];

    public static readonly int[] DefaultPorts = [47984, 47989, 47990, 48010];

    public static async Task<ObservedStreamHost?> WaitForReadyAsync(
        TimeSpan timeout,
        SunshineProbeOptions options,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var startedAt = DateTime.UtcNow;

        while (DateTime.UtcNow - startedAt < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var observed = TryObserveSunshine(options);

            if (observed is not null)
            {
                return observed;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(400), cancellationToken);
        }

        return null;
    }

    private static ObservedStreamHost? TryObserveSunshine(SunshineProbeOptions options)
    {
        var processName = FindSunshineProcessName(options.ProcessNames);
        var listeningPorts = FindListeningSunshinePorts(options.Ports);

        if (processName is null && listeningPorts.Count == 0)
        {
            return null;
        }

        if (processName is null)
        {
            return new ObservedStreamHost
            {
                Mode = "sunshine-port-listener",
                Detail = $"Sunshine-compatible listener found on port(s) {string.Join(", ", listeningPorts)}.",
                ListeningPorts = listeningPorts
            };
        }

        if (listeningPorts.Count == 0)
        {
            return null;
        }

        return new ObservedStreamHost
        {
            Mode = "sunshine-process-and-port",
            Detail = $"Sunshine process {processName} is running with listener port(s) {string.Join(", ", listeningPorts)}.",
            ProcessName = processName,
            ListeningPorts = listeningPorts
        };
    }

    private static string? FindSunshineProcessName(IEnumerable<string> processNames)
    {
        foreach (var processName in processNames)
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
                    return process.ProcessName;
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        return null;
    }

    private static List<int> FindListeningSunshinePorts(IEnumerable<int> ports)
    {
        try
        {
            var activePorts = IPGlobalProperties
                .GetIPGlobalProperties()
                .GetActiveTcpListeners()
                .Select(endpoint => endpoint.Port)
                .ToHashSet();

            return ports
                .Where(activePorts.Contains)
                .OrderBy(port => port)
                .ToList();
        }
        catch
        {
            return [];
        }
    }
}

internal sealed class SunshineProbeOptions
{
    public List<string> ProcessNames { get; set; } = [.. SunshineStreamProbe.DefaultProcessNames];
    public List<int> Ports { get; set; } = [.. SunshineStreamProbe.DefaultPorts];
}

internal sealed class ObservedStreamHost
{
    public string Mode { get; set; } = "";
    public string Detail { get; set; } = "";
    public string? ProcessName { get; set; }
    public List<int> ListeningPorts { get; set; } = [];
}
