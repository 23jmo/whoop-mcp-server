import type {
  WhoopTokens,
  WhoopUser,
  WhoopBodyMeasurement,
  WhoopCycle,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
  WhoopPaginatedResponse,
} from './types.js';

const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';
const WHOOP_AUTH_BASE = 'https://api.prod.whoop.com/oauth/oauth2';

export class WhoopClient {
  private tokens: WhoopTokens | null = null;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private onTokenRefresh?: (tokens: WhoopTokens) => void;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    onTokenRefresh?: (tokens: WhoopTokens) => void;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  setTokens(tokens: WhoopTokens) {
    this.tokens = tokens;
  }

  getAuthorizationUrl(scopes: string[]): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state: crypto.randomUUID(),
    });
    return `${WHOOP_AUTH_BASE}/auth?${params}`;
  }

  async exchangeCodeForTokens(code: string): Promise<WhoopTokens> {
    const response = await fetch(`${WHOOP_AUTH_BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    const tokens: WhoopTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    this.tokens = tokens;
    return tokens;
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${WHOOP_AUTH_BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    this.onTokenRefresh?.(this.tokens);
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }

    // Refresh if token expires in less than 5 minutes
    if (this.tokens.expires_at - Date.now() < 5 * 60 * 1000) {
      await this.refreshTokens();
    }

    const url = new URL(`${WHOOP_API_BASE}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.tokens!.access_token}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    return response.json();
  }

  async getProfile(): Promise<WhoopUser> {
    return this.request<WhoopUser>('/v1/user/profile/basic');
  }

  async getBodyMeasurement(): Promise<WhoopBodyMeasurement> {
    return this.request<WhoopBodyMeasurement>('/v1/user/measurement/body');
  }

  async getCycles(params?: {
    start?: string;
    end?: string;
    limit?: number;
    nextToken?: string;
  }): Promise<WhoopPaginatedResponse<WhoopCycle>> {
    const queryParams: Record<string, string> = {};
    if (params?.start) queryParams.start = params.start;
    if (params?.end) queryParams.end = params.end;
    if (params?.limit) queryParams.limit = params.limit.toString();
    if (params?.nextToken) queryParams.nextToken = params.nextToken;

    return this.request<WhoopPaginatedResponse<WhoopCycle>>('/v1/cycle', queryParams);
  }

  async getRecoveries(params?: {
    start?: string;
    end?: string;
    limit?: number;
    nextToken?: string;
  }): Promise<WhoopPaginatedResponse<WhoopRecovery>> {
    const queryParams: Record<string, string> = {};
    if (params?.start) queryParams.start = params.start;
    if (params?.end) queryParams.end = params.end;
    if (params?.limit) queryParams.limit = params.limit.toString();
    if (params?.nextToken) queryParams.nextToken = params.nextToken;

    return this.request<WhoopPaginatedResponse<WhoopRecovery>>('/v1/recovery', queryParams);
  }

  async getSleeps(params?: {
    start?: string;
    end?: string;
    limit?: number;
    nextToken?: string;
  }): Promise<WhoopPaginatedResponse<WhoopSleep>> {
    const queryParams: Record<string, string> = {};
    if (params?.start) queryParams.start = params.start;
    if (params?.end) queryParams.end = params.end;
    if (params?.limit) queryParams.limit = params.limit.toString();
    if (params?.nextToken) queryParams.nextToken = params.nextToken;

    return this.request<WhoopPaginatedResponse<WhoopSleep>>('/v1/activity/sleep', queryParams);
  }

  async getWorkouts(params?: {
    start?: string;
    end?: string;
    limit?: number;
    nextToken?: string;
  }): Promise<WhoopPaginatedResponse<WhoopWorkout>> {
    const queryParams: Record<string, string> = {};
    if (params?.start) queryParams.start = params.start;
    if (params?.end) queryParams.end = params.end;
    if (params?.limit) queryParams.limit = params.limit.toString();
    if (params?.nextToken) queryParams.nextToken = params.nextToken;

    return this.request<WhoopPaginatedResponse<WhoopWorkout>>('/v1/activity/workout', queryParams);
  }

  // Helper to fetch all pages
  async getAllCycles(params?: { start?: string; end?: string }): Promise<WhoopCycle[]> {
    const all: WhoopCycle[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.getCycles({ ...params, limit: 25, nextToken });
      all.push(...response.records);
      nextToken = response.next_token;
    } while (nextToken);

    return all;
  }

  async getAllRecoveries(params?: { start?: string; end?: string }): Promise<WhoopRecovery[]> {
    const all: WhoopRecovery[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.getRecoveries({ ...params, limit: 25, nextToken });
      all.push(...response.records);
      nextToken = response.next_token;
    } while (nextToken);

    return all;
  }

  async getAllSleeps(params?: { start?: string; end?: string }): Promise<WhoopSleep[]> {
    const all: WhoopSleep[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.getSleeps({ ...params, limit: 25, nextToken });
      all.push(...response.records);
      nextToken = response.next_token;
    } while (nextToken);

    return all;
  }

  async getAllWorkouts(params?: { start?: string; end?: string }): Promise<WhoopWorkout[]> {
    const all: WhoopWorkout[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.getWorkouts({ ...params, limit: 25, nextToken });
      all.push(...response.records);
      nextToken = response.next_token;
    } while (nextToken);

    return all;
  }
}
