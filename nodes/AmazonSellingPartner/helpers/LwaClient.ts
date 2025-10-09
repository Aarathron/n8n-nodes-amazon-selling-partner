import axios, { AxiosResponse } from 'axios';
import { createHash } from 'crypto';
import { ICredentialDataDecryptedObject, NodeOperationError } from 'n8n-workflow';

interface LwaTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
}

interface CachedToken {
	accessToken: string;
	expiresAt: number;
}

export class LwaClient {
	private static tokenCache = new Map<string, CachedToken>();
	private static readonly TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
	private static readonly BUFFER_TIME_SECONDS = 300; // 5 minutes buffer

	static async getAccessToken(credentials: ICredentialDataDecryptedObject): Promise<string> {
		const cacheKey = this.getCacheKey(credentials);
		const cached = this.tokenCache.get(cacheKey);

		// Return cached token if still valid
		if (cached && cached.expiresAt > Date.now()) {
			return cached.accessToken;
		}

		// Fetch new token
		const newToken = await this.fetchAccessToken(credentials);
		
		// Cache the new token
		this.tokenCache.set(cacheKey, {
			accessToken: newToken.access_token,
			expiresAt: Date.now() + (newToken.expires_in - this.BUFFER_TIME_SECONDS) * 1000,
		});

		return newToken.access_token;
	}

    private static async fetchAccessToken(credentials: ICredentialDataDecryptedObject): Promise<LwaTokenResponse> {
		try {
            // LWA requires application/x-www-form-urlencoded encoding
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: String(credentials.lwaRefreshToken || ''),
                client_id: String(credentials.lwaClientId || ''),
                client_secret: String(credentials.lwaClientSecret || ''),
            });

            const response: AxiosResponse<LwaTokenResponse> = await axios.post(
                this.TOKEN_ENDPOINT,
                body.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'n8n-amazon-sp-api/1.0.0',
                    },
                    timeout: 30000,
                }
            );

			return response.data;
		} catch (error) {
			if (axios.isAxiosError(error) && error.response) {
				const { status, data } = error.response;
				throw new NodeOperationError(
					{} as any,
					`LWA authentication failed (${status}): ${data.error_description || data.error || 'Unknown error'}`,
					{
						description: 'Check your LWA credentials and ensure they are valid and not expired',
					}
				);
			}
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			throw new NodeOperationError({} as any, `LWA request failed: ${errorMessage}`);
		}
	}

    private static getCacheKey(credentials: ICredentialDataDecryptedObject): string {
        // Cache per (clientId + refreshToken) to avoid cross-account token reuse
        const clientId = String(credentials.lwaClientId || '');
        const refreshToken = String(credentials.lwaRefreshToken || '');
        const tokenHash = createHash('sha256').update(refreshToken).digest('hex').slice(0, 16);
        return `lwa_${clientId}_${tokenHash}`;
    }

	static clearCache(credentials?: ICredentialDataDecryptedObject): void {
		if (credentials) {
			const cacheKey = this.getCacheKey(credentials);
			this.tokenCache.delete(cacheKey);
		} else {
			this.tokenCache.clear();
		}
	}
} 