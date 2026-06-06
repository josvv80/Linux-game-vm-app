using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

var builder = WebApplication.CreateBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.WriteIndented = true;
});
builder.Services.AddSingleton<GuestAgentState>();

var app = builder.Build();

app.MapGet("/health", (GuestAgentState state) => Results.Ok(state.GetHealth()));

app.MapPost("/register", (GuestAgentRegisterRequest request, GuestAgentState state) =>
{
    return Results.Ok(state.Register(request));
});

app.MapPost("/scan", async (GuestAgentState state, CancellationToken cancellationToken) =>
{
    return Results.Ok(await state.ScanAsync(cancellationToken));
});

app.MapGet("/games", (GuestAgentState state) => Results.Ok(state.ListGames()));

app.MapPost("/launch", (GuestAgentLaunchRequest request, GuestAgentState state) =>
{
    var result = state.Launch(request.GameId);
    return result is null
        ? Results.NotFound(new { message = $"Unknown game id: {request.GameId}" })
        : Results.Ok(result);
});

app.MapPost("/terminate", (GuestAgentTerminateRequest request, GuestAgentState state) =>
{
    var session = state.Terminate(request.SessionId);
    return session is null
        ? Results.NotFound(new { message = $"Unknown session id: {request.SessionId}" })
        : Results.Ok(session);
});

app.MapGet("/events", async (HttpContext context, GuestAgentState state, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-cache";
    context.Response.Headers.Append("X-Accel-Buffering", "no");
    context.Response.ContentType = "text/event-stream";
    await state.WriteEventStreamAsync(context.Response, cancellationToken);
});

app.Run();

internal sealed class GuestAgentState
{
    private readonly ConcurrentDictionary<Guid, Channel<GuestAgentEventEnvelope>> subscribers = new();
    private readonly List<GuestAgentEventEnvelope> recentEvents = new();
    private readonly List<GameRecord> games = new();
    private readonly List<GameSession> sessions = new();

    private string guestName = "Windows Gaming VM";
    private readonly string agentVersion = "0.1.0-scaffold";
    private GuestStatusSnapshot status = new()
    {
        GuestPowerState = "running",
        AgentState = "ready",
        StreamHostState = "ready",
        ScanState = "idle",
        ConnectedGuestName = "Windows Gaming VM",
        Warnings =
        [
            "Windows guest agent scaffold is using sample launcher data.",
            "Real Steam and Ubisoft Connect scanners are not implemented yet."
        ]
    };

    public GuestAgentHealthResponse GetHealth()
    {
        return new GuestAgentHealthResponse
        {
            GuestName = guestName,
            AgentVersion = agentVersion,
            Status = CloneStatus()
        };
    }

    public GuestAgentRegisterResponse Register(GuestAgentRegisterRequest request)
    {
        guestName = string.IsNullOrWhiteSpace(request.GuestName) ? guestName : request.GuestName.Trim();
        status.ConnectedGuestName = guestName;

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "guest.connected",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = $"Guest agent registered as {guestName}."
        });

        return new GuestAgentRegisterResponse
        {
            Ok = true,
            GuestName = guestName,
            RegisteredAt = UtcNow()
        };
    }

    public async Task<GuestAgentGameListResponse> ScanAsync(CancellationToken cancellationToken)
    {
        status.AgentState = "scanning";
        status.ScanState = "running";

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "guest.scan.started",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = "Guest launcher scan started."
        });

        await Task.Delay(TimeSpan.FromMilliseconds(150), cancellationToken);

        games.Clear();
        games.AddRange(CreateSampleGames());

        status.AgentState = "ready";
        status.ScanState = "complete";

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "guest.scan.completed",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = $"Guest launcher scan completed with {games.Count} games."
        });

        return ListGames();
    }

    public GuestAgentGameListResponse ListGames()
    {
        return new GuestAgentGameListResponse
        {
            Games = games.Select(CloneGame).ToList(),
            ScannedAt = UtcNow()
        };
    }

    public GuestAgentLaunchResponse? Launch(string gameId)
    {
        var game = games.FirstOrDefault(candidate => candidate.Id == gameId);

        if (game is null)
        {
            return null;
        }

        var session = new GameSession
        {
            Id = Guid.NewGuid().ToString(),
            GameId = gameId,
            RuntimeState = "running",
            GuestState = "ready",
            StreamState = "ready",
            StartedAt = UtcNow()
        };

        sessions.Insert(0, session);
        status.ActiveSessionId = session.Id;
        status.StreamHostState = "ready";

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "session.launch.started",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = $"Launch accepted for {game.Title}.",
            GameId = game.Id,
            SessionId = session.Id
        });

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "session.streaming.ready",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = "Guest stream path is ready.",
            GameId = game.Id,
            SessionId = session.Id
        });

        return new GuestAgentLaunchResponse
        {
            Session = CloneSession(session)
        };
    }

    public GameSession? Terminate(string sessionId)
    {
        var session = sessions.FirstOrDefault(candidate => candidate.Id == sessionId);

        if (session is null)
        {
            return null;
        }

        session.RuntimeState = "terminated";
        session.StreamState = "unavailable";
        session.EndedAt = UtcNow();

        if (status.ActiveSessionId == session.Id)
        {
            status.ActiveSessionId = null;
        }

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "session.ended",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = "Guest session terminated.",
            GameId = session.GameId,
            SessionId = session.Id
        });

        return CloneSession(session);
    }

    public async Task WriteEventStreamAsync(HttpResponse response, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<GuestAgentEventEnvelope>();
        subscribers[id] = channel;

        try
        {
            foreach (var envelope in recentEvents.OrderBy(envelope => envelope.Event.CreatedAt))
            {
                await WriteEnvelopeAsync(response, envelope, cancellationToken);
            }

            await foreach (var envelope in channel.Reader.ReadAllAsync(cancellationToken))
            {
                await WriteEnvelopeAsync(response, envelope, cancellationToken);
            }
        }
        finally
        {
            subscribers.TryRemove(id, out _);
        }
    }

    private void Publish(SessionEvent sessionEvent)
    {
        status.LastEventAt = sessionEvent.CreatedAt;

        var envelope = new GuestAgentEventEnvelope
        {
            Event = sessionEvent,
            Status = CloneStatus()
        };

        recentEvents.Add(envelope);
        if (recentEvents.Count > 40)
        {
            recentEvents.RemoveAt(0);
        }

        foreach (var subscriber in subscribers.Values)
        {
            subscriber.Writer.TryWrite(envelope);
        }
    }

    private GuestStatusSnapshot CloneStatus()
    {
        return new GuestStatusSnapshot
        {
            GuestPowerState = status.GuestPowerState,
            AgentState = status.AgentState,
            StreamHostState = status.StreamHostState,
            ScanState = status.ScanState,
            ActiveSessionId = status.ActiveSessionId,
            LastEventAt = status.LastEventAt,
            ConnectedGuestName = guestName,
            Warnings = [.. status.Warnings]
        };
    }

    private static GameRecord CloneGame(GameRecord game)
    {
        return new GameRecord
        {
            Id = game.Id,
            Title = game.Title,
            Launcher = game.Launcher,
            InstallState = game.InstallState,
            LaunchCommandRef = game.LaunchCommandRef,
            CoverArtRef = game.CoverArtRef,
            LastSeenAt = game.LastSeenAt,
            CompatibilityFlags = [.. game.CompatibilityFlags],
            GuestMetadata = new Dictionary<string, string>(game.GuestMetadata)
        };
    }

    private static GameSession CloneSession(GameSession session)
    {
        return new GameSession
        {
            Id = session.Id,
            GameId = session.GameId,
            RuntimeState = session.RuntimeState,
            GuestState = session.GuestState,
            StreamState = session.StreamState,
            StartedAt = session.StartedAt,
            EndedAt = session.EndedAt,
            LastError = session.LastError
        };
    }

    private static async Task WriteEnvelopeAsync(
        HttpResponse response,
        GuestAgentEventEnvelope envelope,
        CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(envelope);
        await response.WriteAsync($"event: message\n", cancellationToken);
        await response.WriteAsync($"data: {payload}\n\n", cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }

    private static List<GameRecord> CreateSampleGames()
    {
        return
        [
            new GameRecord
            {
                Id = "steam:app-578080",
                Title = "PUBG: BATTLEGROUNDS",
                Launcher = "steam",
                InstallState = "installed",
                LaunchCommandRef = "steam://run/578080",
                LastSeenAt = UtcNow(),
                CompatibilityFlags = ["prototype", "anti-cheat-unknown", "single-gpu-vfio-risk"],
                GuestMetadata = new Dictionary<string, string>
                {
                    ["installRoot"] = @"C:\Program Files (x86)\Steam",
                    ["launcherAppId"] = "578080"
                }
            },
            new GameRecord
            {
                Id = "ubisoft-connect:anno-1800",
                Title = "Anno 1800",
                Launcher = "ubisoft-connect",
                InstallState = "installed",
                LaunchCommandRef = "uplay://launch/12345/0",
                LastSeenAt = UtcNow(),
                CompatibilityFlags = ["prototype", "single-gpu-vfio-risk"],
                GuestMetadata = new Dictionary<string, string>
                {
                    ["installRoot"] = @"D:\Games\Ubisoft",
                    ["launcherAppId"] = "12345"
                }
            }
        ];
    }

    private static string UtcNow() => DateTimeOffset.UtcNow.ToString("O");
}

internal sealed class GuestAgentHealthResponse
{
    public string GuestName { get; set; } = "";
    public string AgentVersion { get; set; } = "";
    public GuestStatusSnapshot Status { get; set; } = new();
}

internal sealed class GuestAgentRegisterRequest
{
    public string GuestName { get; set; } = "";
    public string AgentVersion { get; set; } = "";
}

internal sealed class GuestAgentRegisterResponse
{
    public bool Ok { get; set; }
    public string RegisteredAt { get; set; } = "";
    public string GuestName { get; set; } = "";
}

internal sealed class GuestAgentGameListResponse
{
    public List<GameRecord> Games { get; set; } = [];
    public string ScannedAt { get; set; } = "";
}

internal sealed class GuestAgentLaunchRequest
{
    public string GameId { get; set; } = "";
}

internal sealed class GuestAgentLaunchResponse
{
    public GameSession Session { get; set; } = new();
}

internal sealed class GuestAgentTerminateRequest
{
    public string SessionId { get; set; } = "";
}

internal sealed class GuestAgentEventEnvelope
{
    public SessionEvent Event { get; set; } = new();
    public GuestStatusSnapshot Status { get; set; } = new();
}

internal sealed class GuestStatusSnapshot
{
    public string GuestPowerState { get; set; } = "offline";
    public string AgentState { get; set; } = "offline";
    public string StreamHostState { get; set; } = "unavailable";
    public string ScanState { get; set; } = "idle";
    public string? ActiveSessionId { get; set; }
    public List<string> Warnings { get; set; } = [];
    public string? LastEventAt { get; set; }
    public string? ConnectedGuestName { get; set; }
}

internal sealed class GameRecord
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Launcher { get; set; } = "";
    public string InstallState { get; set; } = "";
    public string LaunchCommandRef { get; set; } = "";
    public string? CoverArtRef { get; set; }
    public string LastSeenAt { get; set; } = "";
    public List<string> CompatibilityFlags { get; set; } = [];
    public Dictionary<string, string> GuestMetadata { get; set; } = [];
}

internal sealed class GameSession
{
    public string Id { get; set; } = "";
    public string GameId { get; set; } = "";
    public string RuntimeState { get; set; } = "queued";
    public string GuestState { get; set; } = "offline";
    public string StreamState { get; set; } = "unavailable";
    public string StartedAt { get; set; } = "";
    public string? EndedAt { get; set; }
    public string? LastError { get; set; }
}

internal sealed class SessionEvent
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string Level { get; set; } = "info";
    public string CreatedAt { get; set; } = "";
    public string Message { get; set; } = "";
    public string? GameId { get; set; }
    public string? SessionId { get; set; }
}
