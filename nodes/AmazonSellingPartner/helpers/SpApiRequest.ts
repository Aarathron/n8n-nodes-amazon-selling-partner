import axios, { AxiosResponse } from 'axios';
import { URL } from 'url';
import {
	IExecuteFunctions,
	ICredentialDataDecryptedObject,
	NodeOperationError,
} from 'n8n-workflow';
import { LwaClient } from './LwaClient';
import { SigV4Signer } from './SigV4Signer';
import { RateLimiter } from '../core/RateLimiter';
import { ErrorHandler } from '../core/ErrorHandler';
import { metricsCollector } from '../core/MetricsCollector';
import { auditLogger } from '../core/AuditLogger';
import { securityValidator } from '../core/SecurityValidator';
import { getEndpointGroup } from '../core/rateLimitConfig';

interface SpApiRequestOptions {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
	endpoint: string;
	query?: Record<string, any>;
	body?: any;
	headers?: Record<string, string>;
	responseType?: 'json' | 'stream' | 'text';
}

interface SpApiResponse<T = any> {
	data: T;
	headers: Record<string, string>;
	status: number;
}

export class SpApiRequest {
	private static rateLimiter = new RateLimiter();

	static async makeRequest<T = any>(
		executeFunctions: IExecuteFunctions,
		options: SpApiRequestOptions
	): Promise<SpApiResponse<T>> {
		const startTime = Date.now();
		const nodeId = executeFunctions.getNode().id;
		
		try {
			const credentials = await executeFunctions.getCredentials('amazonSpApi');
			
            // SP-API requires AWS SigV4 signing for all requests
            const useAwsSigning = true;
			
			// Security validation (modified for optional AWS credentials)
			const credentialValidation = this.validateCredentials(credentials, useAwsSigning);
			if (!credentialValidation.isValid) {
				auditLogger.logCredentialUsage(nodeId, 'amazonSpApi', false, {
					errors: credentialValidation.errors,
				});
				throw new NodeOperationError(
					executeFunctions.getNode(),
					`Invalid credentials: ${credentialValidation.errors.join(', ')}`
				);
			}

			// Validate environment isolation
			try {
				const environmentValidation = securityValidator.validateEnvironmentIsolation(credentials, nodeId);
				if (!environmentValidation.isValid) {
					throw new NodeOperationError(
						executeFunctions.getNode(),
						`Environment isolation violation: ${environmentValidation.errors.join(', ')}`
					);
				}
			} catch (error) {
				// If security validator is not available, continue with basic validation
				console.warn('Security validator not available, skipping environment validation');
			}

			// Validate API parameters
			if (options.query) {
				try {
					const paramValidation = securityValidator.validateApiParameters(options.query, nodeId);
					if (!paramValidation.isValid) {
						throw new NodeOperationError(
							executeFunctions.getNode(),
							`Invalid parameters: ${paramValidation.errors.join(', ')}`
						);
					}
					options.query = paramValidation.sanitizedData;
				} catch (error) {
					// If security validator is not available, continue without parameter validation
					console.warn('Security validator not available, skipping parameter validation');
				}
			}

			const baseUrl = this.getBaseUrl(credentials);
			
			// Build full URL
			const url = new URL(options.endpoint, baseUrl);
			if (options.query) {
				Object.entries(options.query).forEach(([key, value]) => {
					if (value !== undefined && value !== null && value !== '') {
						if (Array.isArray(value)) {
							value.forEach(v => url.searchParams.append(key, v));
						} else {
							url.searchParams.set(key, String(value));
						}
					}
				});
			}

			// Apply rate limiting using group-based rate limits
			const rateLimitGroup = getEndpointGroup(options.endpoint);
			await this.rateLimiter.waitForToken(rateLimitGroup);

			// Get LWA access token
			const accessToken = await LwaClient.getAccessToken(credentials);
			auditLogger.logAuthentication(nodeId, 'LWA', true, { endpoint: options.endpoint });

			// Prepare headers
            const headers = {
				'Accept': options.responseType === 'json' ? 'application/json' : '*/*',
				'Content-Type': 'application/json',
				'User-Agent': 'n8n-amazon-sp-api/1.0.0',
                'x-amz-user-agent': 'n8n-amazon-sp-api/1.0.0',
				'x-amz-access-token': accessToken,
				...options.headers,
			};

			// Conditionally sign request with AWS SigV4
			let finalHeaders = headers;
			if (useAwsSigning) {
				try {
					const signedHeaders = await SigV4Signer.signRequest(
						options.method,
						url.toString(),
						headers,
						options.body ? JSON.stringify(options.body) : undefined,
						credentials
					);
					finalHeaders = { ...headers, ...signedHeaders };
					auditLogger.logAuthentication(nodeId, 'AWS_SigV4', true, { endpoint: options.endpoint });
				} catch (error) {
					auditLogger.logAuthentication(nodeId, 'AWS_SigV4', false, { 
						endpoint: options.endpoint,
						error: error instanceof Error ? error.message : 'Unknown error'
					});
					throw new NodeOperationError(
						executeFunctions.getNode(),
						`AWS SigV4 signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
						{
							description: 'Check your AWS credentials or disable AWS signing in advanced options'
						}
					);
				}
			}

			// Configure axios request based on response type
			const axiosConfig: any = {
				method: options.method,
				url: url.toString(),
				headers: finalHeaders,
				data: options.body,
				timeout: 60000, // 60 seconds
				validateStatus: (status: number) => status < 500, // Don't throw on 4xx errors
			};

			// Set response type for non-JSON responses
			if (options.responseType === 'stream') {
				axiosConfig.responseType = 'stream';
			} else if (options.responseType === 'text') {
				axiosConfig.responseType = 'text';
			}

			// Make the request
			const response: AxiosResponse<T> = await axios(axiosConfig);

			const duration = Date.now() - startTime;

			// Update rate limiter with response headers
			this.rateLimiter.updateFromHeaders(rateLimitGroup, response.headers as Record<string, string>);

			// Handle non-success responses
			if (response.status >= 400) {
				// Log failed API access
				auditLogger.logApiAccess(nodeId, options.endpoint, false, {
					status: response.status,
					duration,
					method: options.method,
					useAwsSigning,
				});
				metricsCollector.recordApiRequest(options.endpoint, duration, false, `HTTP_${response.status}`);
				
				throw await ErrorHandler.handleApiError(response);
			}

			// Log successful API access
			auditLogger.logApiAccess(nodeId, options.endpoint, true, {
				status: response.status,
				duration,
				method: options.method,
				useAwsSigning,
			});
			metricsCollector.recordApiRequest(options.endpoint, duration, true);

			return {
				data: response.data,
				headers: response.headers as Record<string, string>,
				status: response.status,
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			
			// Log error
			auditLogger.logError(nodeId, error instanceof Error ? error : new Error('Unknown error'), {
				endpoint: options.endpoint,
				method: options.method,
				duration,
			});

			if (error instanceof NodeOperationError) {
				metricsCollector.recordApiRequest(options.endpoint, duration, false, 'NODE_OPERATION_ERROR');
				throw error;
			}

			if (axios.isAxiosError(error)) {
				metricsCollector.recordApiRequest(options.endpoint, duration, false, 'NETWORK_ERROR');
				throw await ErrorHandler.handleNetworkError(error);
			}

			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			metricsCollector.recordApiRequest(options.endpoint, duration, false, 'UNEXPECTED_ERROR');
			throw new NodeOperationError(
				executeFunctions.getNode(),
				`Unexpected error: ${errorMessage}`
			);
		}
	}

    // removed: legacy helper

	private static validateCredentials(
		credentials: ICredentialDataDecryptedObject, 
		useAwsSigning: boolean
	): { isValid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Always validate LWA credentials
		if (!credentials.lwaClientId) {
			errors.push('LWA Client ID is required');
		}
		if (!credentials.lwaClientSecret) {
			errors.push('LWA Client Secret is required');
		}
		if (!credentials.lwaRefreshToken) {
			errors.push('LWA Refresh Token is required');
		}

		// Validate AWS credentials only if AWS signing is enabled
		if (useAwsSigning) {
			const advancedOptions = credentials.advancedOptions as any;
			const awsAccessKeyId = credentials.awsAccessKeyId || advancedOptions?.awsAccessKeyId;
			const awsSecretAccessKey = credentials.awsSecretAccessKey || advancedOptions?.awsSecretAccessKey;

			if (!awsAccessKeyId) {
				errors.push('AWS Access Key ID is required when AWS signing is enabled');
			}
			if (!awsSecretAccessKey) {
				errors.push('AWS Secret Access Key is required when AWS signing is enabled');
			}
		}

		return {
			isValid: errors.length === 0,
			errors,
		};
	}

	private static getBaseUrl(credentials: ICredentialDataDecryptedObject): string {
		const advancedOptions = credentials.advancedOptions as any;
		const customEndpoint = credentials.spApiEndpoint || advancedOptions?.spApiEndpoint;
		
		if (customEndpoint) {
			return customEndpoint as string;
		}

		const region = credentials.awsRegion as string;
		const environment = credentials.environment as string;

		const endpoints: Record<string, string> = {
			'us-east-1': environment === 'sandbox' 
				? 'https://sandbox.sellingpartnerapi-na.amazon.com'
				: 'https://sellingpartnerapi-na.amazon.com',
			'eu-west-1': environment === 'sandbox'
				? 'https://sandbox.sellingpartnerapi-eu.amazon.com'
				: 'https://sellingpartnerapi-eu.amazon.com',
			'us-west-2': environment === 'sandbox'
				? 'https://sandbox.sellingpartnerapi-fe.amazon.com'
				: 'https://sellingpartnerapi-fe.amazon.com',
		};
		
		return endpoints[region] || endpoints['us-east-1'];
	}
} 