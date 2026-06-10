import type { CatalogGameMetadata, GameRecord } from "@game-vm-hub/shared-types";

interface TheGamesDbGame {
  id: number;
  game_title: string;
  overview?: string | null;
}

interface TheGamesDbImage {
  type: string;
  side?: string | null;
  filename: string;
}

interface TheGamesDbSearchResponse {
  data?: {
    games?: TheGamesDbGame[];
  };
  include?: {
    boxart?: {
      base_url?: {
        medium?: string;
        large?: string;
        original?: string;
      };
      data?: Record<string, TheGamesDbImage[]>;
    };
  };
}

interface TheGamesDbImagesResponse {
  data?: {
    base_url?: {
      medium?: string;
      large?: string;
      original?: string;
    };
    images?: Record<string, TheGamesDbImage[]>;
  };
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreCandidate(game: GameRecord, candidate: TheGamesDbGame) {
  const normalizedGameTitle = normalizeTitle(game.title);
  const normalizedCandidateTitle = normalizeTitle(candidate.game_title);

  if (normalizedGameTitle === normalizedCandidateTitle) {
    return 4;
  }

  if (normalizedCandidateTitle.startsWith(normalizedGameTitle)) {
    return 3;
  }

  if (normalizedGameTitle.startsWith(normalizedCandidateTitle)) {
    return 2;
  }

  if (normalizedCandidateTitle.includes(normalizedGameTitle)) {
    return 1;
  }

  return 0;
}

function buildImageUrl(
  baseUrl: { medium?: string; large?: string; original?: string } | undefined,
  filename: string | undefined,
) {
  if (!filename) {
    return undefined;
  }

  return `${baseUrl?.large ?? baseUrl?.medium ?? baseUrl?.original ?? ""}${filename}`;
}

function pickFirstImage(
  images: TheGamesDbImage[] | undefined,
  predicate: (image: TheGamesDbImage) => boolean,
) {
  return images?.find(predicate);
}

export class TheGamesDbService {
  private readonly cache = new Map<string, Promise<CatalogGameMetadata | null>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  clear() {
    this.cache.clear();
  }

  async getMetadata(game: GameRecord, apiKey: string): Promise<CatalogGameMetadata | null> {
    const normalizedApiKey = apiKey.trim();

    if (!normalizedApiKey) {
      return null;
    }

    const cacheKey = `${normalizedApiKey}:${game.id}:${game.title}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const pending = this.fetchMetadata(game, normalizedApiKey).catch((error) => {
      this.cache.delete(cacheKey);
      throw error;
    });

    this.cache.set(cacheKey, pending);
    return pending;
  }

  private async fetchMetadata(
    game: GameRecord,
    apiKey: string,
  ): Promise<CatalogGameMetadata | null> {
    const searchUrl = new URL("https://api.thegamesdb.net/v1.1/Games/ByGameName");
    searchUrl.searchParams.set("apikey", apiKey);
    searchUrl.searchParams.set("name", game.title);
    searchUrl.searchParams.set("fields", "overview");
    searchUrl.searchParams.set("include", "boxart");

    const searchResponse = await this.fetchImpl(searchUrl);

    if (!searchResponse.ok) {
      throw new Error(`TheGamesDB search failed: ${searchResponse.status}`);
    }

    const searchPayload = (await searchResponse.json()) as TheGamesDbSearchResponse;
    const candidates = searchPayload.data?.games ?? [];

    const bestCandidate = candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(game, candidate),
      }))
      .sort((left, right) => right.score - left.score)[0];

    if (!bestCandidate || bestCandidate.score === 0) {
      return null;
    }

    const gameId = String(bestCandidate.candidate.id);
    const searchBoxart = searchPayload.include?.boxart?.data?.[gameId] ?? [];
    const searchBaseUrl = searchPayload.include?.boxart?.base_url;

    const imagesUrl = new URL("https://api.thegamesdb.net/v1/Games/Images");
    imagesUrl.searchParams.set("apikey", apiKey);
    imagesUrl.searchParams.set("games_id", gameId);
    imagesUrl.searchParams.set("filter[type]", "fanart,banner,boxart,screenshot,titlescreen");

    const imagesResponse = await this.fetchImpl(imagesUrl);

    if (!imagesResponse.ok) {
      throw new Error(`TheGamesDB images failed: ${imagesResponse.status}`);
    }

    const imagesPayload = (await imagesResponse.json()) as TheGamesDbImagesResponse;
    const images = imagesPayload.data?.images?.[gameId] ?? searchBoxart;
    const imageBaseUrl = imagesPayload.data?.base_url ?? searchBaseUrl;

    const frontBoxart =
      pickFirstImage(images, (image) => image.type === "boxart" && image.side === "front") ??
      pickFirstImage(searchBoxart, (image) => image.type === "boxart" && image.side === "front") ??
      pickFirstImage(images, (image) => image.type === "boxart") ??
      pickFirstImage(searchBoxart, (image) => image.type === "boxart");
    const heroImage =
      pickFirstImage(images, (image) => image.type === "fanart") ??
      pickFirstImage(images, (image) => image.type === "banner") ??
      pickFirstImage(images, (image) => image.type === "screenshot") ??
      pickFirstImage(images, (image) => image.type === "titlescreen") ??
      frontBoxart;

    const metadata: CatalogGameMetadata = {
      source: "thegamesdb",
      matchedTitle: bestCandidate.candidate.game_title,
    };

    if (bestCandidate.candidate.overview) {
      metadata.overview = bestCandidate.candidate.overview;
    }

    const coverArtRef = buildImageUrl(imageBaseUrl, frontBoxart?.filename);
    const heroArtRef = buildImageUrl(imageBaseUrl, heroImage?.filename);

    if (coverArtRef) {
      metadata.coverArtRef = coverArtRef;
    }
    if (heroArtRef) {
      metadata.heroArtRef = heroArtRef;
    }

    return metadata;
  }
}
