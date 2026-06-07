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
app.MapGet("/simulation", (GuestAgentState state) => Results.Ok(state.GetSimulationSettings()));
app.MapPut("/simulation", (GuestAgentSimulationUpdateRequest request, GuestAgentState state) =>
{
    var response = state.UpdateSimulation(request);
    return response is null
        ? Results.NotFound(new { message = $"Unknown game id: {request.GameId}" })
        : Results.Ok(response);
});

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
    private readonly Lock sync = new();
    private readonly ConcurrentDictionary<Guid, Channel<GuestAgentEventEnvelope>> subscribers = new();
    private readonly List<GuestAgentEventEnvelope> recentEvents = new();
    private readonly List<GameRecord> games = new();
    private readonly List<GameSession> sessions = new();
    private readonly Dictionary<string, CancellationTokenSource> launchLifecycles = new();
    private readonly Dictionary<string, GuestAgentSimulationSettings> simulationProfiles = new();

    private string guestName = "Windows Gaming VM";
    private readonly string agentVersion = "0.1.0-scaffold";
    private GuestStatusSnapshot status = new()
    {
        GuestPowerState = "running",
        AgentState = "online",
        StreamHostState = "unavailable",
        ScanState = "idle",
        ConnectedGuestName = "Windows Gaming VM",
        Warnings =
        [
            "Windows guest agent scaffold is using sample launcher data.",
            "Real Steam and Ubisoft Connect scanners are not implemented yet.",
            "Sunshine readiness is simulated through delayed launch lifecycle events."
        ]
    };

    public GuestAgentState()
    {
        SeedDefaultSimulationProfiles();
    }

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
        ApplySimulationProfiles(games);

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

    public GuestAgentSimulationCatalogResponse GetSimulationSettings()
    {
        lock (sync)
        {
            return new GuestAgentSimulationCatalogResponse
            {
                Games = simulationProfiles.Values
                    .OrderBy(profile => profile.GameId, StringComparer.Ordinal)
                    .Select(CloneSimulationSettings)
                    .ToList()
            };
        }
    }

    public GuestAgentSimulationCatalogResponse? UpdateSimulation(GuestAgentSimulationUpdateRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.GameId))
        {
            return null;
        }

        lock (sync)
        {
            if (!simulationProfiles.TryGetValue(request.GameId, out var current))
            {
                return null;
            }

            current.Outcome = string.IsNullOrWhiteSpace(request.Outcome) ? current.Outcome : request.Outcome.Trim();
            current.FailureMessage = request.FailureMessage ?? current.FailureMessage;
            current.LaunchAcceptedDelayMs = request.LaunchAcceptedDelayMs ?? current.LaunchAcceptedDelayMs;
            current.GameDetectedDelayMs = request.GameDetectedDelayMs ?? current.GameDetectedDelayMs;
            current.StreamReadyDelayMs = request.StreamReadyDelayMs ?? current.StreamReadyDelayMs;

            foreach (var game in games.Where(candidate => candidate.Id == request.GameId))
            {
                ApplySimulationProfile(game, current);
            }

            return new GuestAgentSimulationCatalogResponse
            {
                Games = simulationProfiles.Values
                    .OrderBy(profile => profile.GameId, StringComparer.Ordinal)
                    .Select(CloneSimulationSettings)
                    .ToList()
            };
        }
    }

    public GuestAgentLaunchResponse? Launch(string gameId)
    {
        GameRecord? game;

        lock (sync)
        {
            game = games.FirstOrDefault(candidate => candidate.Id == gameId);
        }

        if (game is null)
        {
            return null;
        }

        var sessionId = Guid.NewGuid().ToString();
        var session = new GameSession
        {
            Id = sessionId,
            GameId = gameId,
            RuntimeState = "queued",
            GuestState = "online",
            StreamState = "preparing",
            StartedAt = UtcNow()
        };

        lock (sync)
        {
            sessions.Insert(0, session);
            status.ActiveSessionId = session.Id;
            status.AgentState = "online";
            status.StreamHostState = "preparing";
        }

        Publish(new SessionEvent
        {
            Id = Guid.NewGuid().ToString(),
            Type = "session.launch.requested",
            Level = "info",
            CreatedAt = UtcNow(),
            Message = $"Launch queued for {game.Title}.",
            GameId = game.Id,
            SessionId = session.Id
        });

        var cancellationTokenSource = new CancellationTokenSource();
        lock (sync)
        {
            launchLifecycles[session.Id] = cancellationTokenSource;
        }
        _ = RunLaunchLifecycleAsync(
            CloneGame(game),
            session.Id,
            CloneSimulationSettings(ResolveSimulationSettings(game.Id)),
            cancellationTokenSource.Token);

        return new GuestAgentLaunchResponse
        {
            Session = CloneSession(session)
        };
    }

    public GameSession? Terminate(string sessionId)
    {
        GameSession? session;
        CancellationTokenSource? lifecycle;

        lock (sync)
        {
            session = sessions.FirstOrDefault(candidate => candidate.Id == sessionId);
            if (launchLifecycles.Remove(sessionId, out var existingLifecycle))
            {
                lifecycle = existingLifecycle;
            }
            else
            {
                lifecycle = null;
            }
        }

        if (session is null)
        {
            return null;
        }

        lifecycle?.Cancel();

        lock (sync)
        {
            session.RuntimeState = "terminated";
            session.StreamState = "unavailable";
            session.EndedAt = UtcNow();
            session.GuestState = "ready";

            if (status.ActiveSessionId == session.Id)
            {
                status.ActiveSessionId = null;
                status.StreamHostState = "unavailable";
            }
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

    private async Task RunLaunchLifecycleAsync(
        GameRecord game,
        string sessionId,
        GuestAgentSimulationSettings simulation,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(simulation.LaunchAcceptedDelayMs), cancellationToken);

            var startedSession = UpdateSession(
                sessionId,
                session =>
                {
                    session.RuntimeState = "launching";
                    session.GuestState = "online";
                    session.StreamState = "preparing";
                },
                statusUpdate =>
                {
                    statusUpdate.AgentState = "online";
                    statusUpdate.StreamHostState = "preparing";
                });

            if (startedSession is null)
            {
                return;
            }

            Publish(new SessionEvent
            {
                Id = Guid.NewGuid().ToString(),
                Type = "session.launch.started",
                Level = "info",
                CreatedAt = UtcNow(),
                Message = $"Launch accepted for {game.Title}.",
                GameId = game.Id,
                SessionId = sessionId
            });

            await Task.Delay(TimeSpan.FromMilliseconds(simulation.GameDetectedDelayMs), cancellationToken);

            var runningSession = UpdateSession(
                sessionId,
                session =>
                {
                    session.RuntimeState = "running";
                    session.GuestState = "ready";
                },
                statusUpdate =>
                {
                    statusUpdate.AgentState = "ready";
                });

            if (runningSession is null)
            {
                return;
            }

            Publish(new SessionEvent
            {
                Id = Guid.NewGuid().ToString(),
                Type = "session.game.detected",
                Level = "info",
                CreatedAt = UtcNow(),
                Message = $"{game.Title} process was detected in the guest.",
                GameId = game.Id,
                SessionId = sessionId
            });

            await Task.Delay(TimeSpan.FromMilliseconds(simulation.StreamReadyDelayMs), cancellationToken);

            if (ShouldFailBeforeStreamReady(simulation))
            {
                var failureDetail = GetFailureMessage(game, simulation);
                var failedSession = UpdateSession(
                    sessionId,
                    session =>
                    {
                        session.RuntimeState = "failed";
                        session.GuestState = "error";
                        session.StreamState = "unavailable";
                        session.EndedAt = UtcNow();
                        session.LastError = failureDetail;
                    },
                    statusUpdate =>
                    {
                        statusUpdate.AgentState = "error";
                        statusUpdate.StreamHostState = "unavailable";
                        if (statusUpdate.ActiveSessionId == sessionId)
                        {
                            statusUpdate.ActiveSessionId = null;
                        }
                    });

                if (failedSession is null)
                {
                    return;
                }

                Publish(new SessionEvent
                {
                    Id = Guid.NewGuid().ToString(),
                    Type = "session.failed",
                    Level = "error",
                    CreatedAt = UtcNow(),
                    Message = failureDetail,
                    GameId = game.Id,
                    SessionId = sessionId
                });

                return;
            }

            var readySession = UpdateSession(
                sessionId,
                session =>
                {
                    session.StreamState = "ready";
                },
                statusUpdate =>
                {
                    statusUpdate.StreamHostState = "ready";
                });

            if (readySession is null)
            {
                return;
            }

            Publish(new SessionEvent
            {
                Id = Guid.NewGuid().ToString(),
                Type = "session.streaming.ready",
                Level = "info",
                CreatedAt = UtcNow(),
                Message = "Guest stream path is ready.",
                GameId = game.Id,
                SessionId = sessionId
            });
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            lock (sync)
            {
                if (launchLifecycles.Remove(sessionId, out var lifecycle))
                {
                    lifecycle.Dispose();
                }
            }
        }
    }

    private GameSession? UpdateSession(
        string sessionId,
        Action<GameSession> sessionUpdate,
        Action<GuestStatusSnapshot>? statusUpdate = null)
    {
        lock (sync)
        {
            var session = sessions.FirstOrDefault(candidate => candidate.Id == sessionId);

            if (session is null)
            {
                return null;
            }

            sessionUpdate(session);
            statusUpdate?.Invoke(status);
            return CloneSession(session);
        }
    }

    private void Publish(SessionEvent sessionEvent)
    {
        GuestAgentEventEnvelope envelope;

        lock (sync)
        {
            status.LastEventAt = sessionEvent.CreatedAt;

            envelope = new GuestAgentEventEnvelope
            {
                Event = sessionEvent,
                Status = CloneStatus()
            };

            recentEvents.Add(envelope);
            if (recentEvents.Count > 40)
            {
                recentEvents.RemoveAt(0);
            }
        }

        foreach (var subscriber in subscribers.Values)
        {
            subscriber.Writer.TryWrite(envelope);
        }
    }

    private void SeedDefaultSimulationProfiles()
    {
        foreach (var profile in CreateDefaultSimulationSettings())
        {
            simulationProfiles[profile.GameId] = profile;
        }
    }

    private static List<GuestAgentSimulationSettings> CreateDefaultSimulationSettings()
    {
        return
        [
            new GuestAgentSimulationSettings
            {
                GameId = "steam:app-578080",
                Outcome = "success",
                FailureMessage = "Simulated launch failure for PUBG: BATTLEGROUNDS.",
                LaunchAcceptedDelayMs = 250,
                GameDetectedDelayMs = 350,
                StreamReadyDelayMs = 500
            },
            new GuestAgentSimulationSettings
            {
                GameId = "ubisoft-connect:anno-1800",
                Outcome = "fail-before-stream-ready",
                FailureMessage = "Sunshine stream handshake timed out before the game session became remotely playable.",
                LaunchAcceptedDelayMs = 250,
                GameDetectedDelayMs = 350,
                StreamReadyDelayMs = 500
            }
        ];
    }

    private GuestAgentSimulationSettings ResolveSimulationSettings(string gameId)
    {
        lock (sync)
        {
            if (simulationProfiles.TryGetValue(gameId, out var profile))
            {
                return CloneSimulationSettings(profile);
            }
        }

        return new GuestAgentSimulationSettings
        {
            GameId = gameId,
            Outcome = "success",
            FailureMessage = $"Simulated launch failure for {gameId}.",
            LaunchAcceptedDelayMs = 250,
            GameDetectedDelayMs = 350,
            StreamReadyDelayMs = 500
        };
    }

    private void ApplySimulationProfiles(List<GameRecord> catalog)
    {
        foreach (var game in catalog)
        {
            ApplySimulationProfile(game, ResolveSimulationSettings(game.Id));
        }
    }

    private static void ApplySimulationProfile(GameRecord game, GuestAgentSimulationSettings profile)
    {
        game.GuestMetadata["simulatedOutcome"] = profile.Outcome;
        game.GuestMetadata["simulatedFailure"] = profile.FailureMessage;
        game.GuestMetadata["launchAcceptedDelayMs"] = profile.LaunchAcceptedDelayMs.ToString();
        game.GuestMetadata["gameDetectedDelayMs"] = profile.GameDetectedDelayMs.ToString();
        game.GuestMetadata["streamReadyDelayMs"] = profile.StreamReadyDelayMs.ToString();
    }

    private static GuestAgentSimulationSettings CloneSimulationSettings(GuestAgentSimulationSettings profile)
    {
        return new GuestAgentSimulationSettings
        {
            GameId = profile.GameId,
            Outcome = profile.Outcome,
            FailureMessage = profile.FailureMessage,
            LaunchAcceptedDelayMs = profile.LaunchAcceptedDelayMs,
            GameDetectedDelayMs = profile.GameDetectedDelayMs,
            StreamReadyDelayMs = profile.StreamReadyDelayMs
        };
    }

    private static bool ShouldFailBeforeStreamReady(GuestAgentSimulationSettings simulation)
    {
        return simulation.Outcome == "fail-before-stream-ready";
    }

    private static string GetFailureMessage(GameRecord game, GuestAgentSimulationSettings simulation)
    {
        if (!string.IsNullOrWhiteSpace(simulation.FailureMessage))
        {
            return simulation.FailureMessage;
        }

        return $"Simulated launch failure for {game.Title}.";
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
                    ["launcherAppId"] = "12345",
                    ["simulatedOutcome"] = "fail-before-stream-ready",
                    ["simulatedFailure"] = "Sunshine stream handshake timed out before the game session became remotely playable."
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

internal sealed class GuestAgentSimulationCatalogResponse
{
    public List<GuestAgentSimulationSettings> Games { get; set; } = [];
}

internal sealed class GuestAgentSimulationUpdateRequest
{
    public string GameId { get; set; } = "";
    public string? Outcome { get; set; }
    public string? FailureMessage { get; set; }
    public int? LaunchAcceptedDelayMs { get; set; }
    public int? GameDetectedDelayMs { get; set; }
    public int? StreamReadyDelayMs { get; set; }
}

internal sealed class GuestAgentSimulationSettings
{
    public string GameId { get; set; } = "";
    public string Outcome { get; set; } = "success";
    public string FailureMessage { get; set; } = "";
    public int LaunchAcceptedDelayMs { get; set; } = 250;
    public int GameDetectedDelayMs { get; set; } = 350;
    public int StreamReadyDelayMs { get; set; } = 500;
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
