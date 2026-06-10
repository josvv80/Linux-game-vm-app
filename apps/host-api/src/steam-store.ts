import type { GameRecord } from "@game-vm-hub/shared-types";

interface SteamStoreMovie {
  mp4?: {
    "480"?: string;
    max?: string;
  };
}

interface SteamStoreAppDetails {
  success?: boolean;
  data?: {
    movies?: SteamStoreMovie[];
  };
}

type SteamStoreResponse = Record<string, SteamStoreAppDetails>;

export class SteamStoreService {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  clear() {
    this.cache.clear();
  }

  async getTrailerUrl(game: GameRecord): Promise<string | null> {
    if (game.launcher !== "steam") {
      return null;
    }

    const appId = game.guestMetadata.launcherAppId?.trim();

    if (!appId) {
      return null;
    }

    const cached = this.cache.get(appId);

    if (cached) {
      return cached;
    }

    const pending = this.fetchTrailerUrl(appId).catch((error) => {
      this.cache.delete(appId);
      throw error;
    });

    this.cache.set(appId, pending);
    return pending;
  }

  private async fetchTrailerUrl(appId: string): Promise<string | null> {
    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.searchParams.set("appids", appId);
    url.searchParams.set("l", "english");

    const response = await this.fetchImpl(url);

    if (!response.ok) {
      throw new Error(`Steam store metadata failed: ${response.status}`);
    }

    const payload = (await response.json()) as SteamStoreResponse;
    const appDetails = payload[appId];

    if (!appDetails?.success) {
      return null;
    }

    const movie = appDetails.data?.movies?.[0];

    return movie?.mp4?.max ?? movie?.mp4?.["480"] ?? null;
  }
}
