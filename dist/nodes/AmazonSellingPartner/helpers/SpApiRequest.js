"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpApiRequest = void 0;
const axios_1 = __importDefault(require("axios"));
const url_1 = require("url");
const n8n_workflow_1 = require("n8n-workflow");
const LwaClient_1 = require("./LwaClient");
const SigV4Signer_1 = require("./SigV4Signer");
const RateLimiter_1 = require("../core/RateLimiter");
const ErrorHandler_1 = require("../core/ErrorHandler");
const MetricsCollector_1 = require("../core/MetricsCollector");
const AuditLogger_1 = require("../core/AuditLogger");
const SecurityValidator_1 = require("../core/SecurityValidator");
const rateLimitConfig_1 = require("../core/rateLimitConfig");
class SpApiRequest {
    static rateLimiter = new RateLimiter_1.RateLimiter();
    static async makeRequest(executeFunctions, options) {
        const startTime = Date.now();
        const nodeId = executeFunctions.getNode().id;
        try {
            const credentials = await executeFunctions.getCredentials('amazonSpApi');
            // SP-API requires AWS SigV4 signing for all requests
            const useAwsSigning = true;
            // Security validation (modified for optional AWS credentials)
            const credentialValidation = this.validateCredentials(credentials, useAwsSigning);
            if (!credentialValidation.isValid) {
                AuditLogger_1.auditLogger.logCredentialUsage(nodeId, 'amazonSpApi', false, {
                    errors: credentialValidation.errors,
                });
                throw new n8n_workflow_1.NodeOperationError(executeFunctions.getNode(), `Invalid credentials: ${credentialValidation.errors.join(', ')}`);
            }
            // Validate environment isolation
            try {
                const environmentValidation = SecurityValidator_1.securityValidator.validateEnvironmentIsolation(credentials, nodeId);
                if (!environmentValidation.isValid) {
                    throw new n8n_workflow_1.NodeOperationError(executeFunctions.getNode(), `Environment isolation violation: ${environmentValidation.errors.join(', ')}`);
                }
            }
            catch (error) {
                // If security validator is not available, continue with basic validation
                console.warn('Security validator not available, skipping environment validation');
            }
            // Validate API parameters
            if (options.query) {
                try {
                    const paramValidation = SecurityValidator_1.securityValidator.validateApiParameters(options.query, nodeId);
                    if (!paramValidation.isValid) {
                        throw new n8n_workflow_1.NodeOperationError(executeFunctions.getNode(), `Invalid parameters: ${paramValidation.errors.join(', ')}`);
                    }
                    options.query = paramValidation.sanitizedData;
                }
                catch (error) {
                    // If security validator is not available, continue without parameter validation
                    console.warn('Security validator not available, skipping parameter validation');
                }
            }
            const baseUrl = this.getBaseUrl(credentials);
            // Build full URL
            const url = new url_1.URL(options.endpoint, baseUrl);
            if (options.query) {
                Object.entries(options.query).forEach(([key, value]) => {
                    if (value !== undefined && value !== null && value !== '') {
                        if (Array.isArray(value)) {
                            value.forEach(v => url.searchParams.append(key, v));
                        }
                        else {
                            url.searchParams.set(key, String(value));
                        }
                    }
                });
            }
            // Apply rate limiting using group-based rate limits
            const rateLimitGroup = (0, rateLimitConfig_1.getEndpointGroup)(options.endpoint);
            await this.rateLimiter.waitForToken(rateLimitGroup);
            // Get LWA access token
            const accessToken = await LwaClient_1.LwaClient.getAccessToken(credentials);
            AuditLogger_1.auditLogger.logAuthentication(nodeId, 'LWA', true, { endpoint: options.endpoint });
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
                    const signedHeaders = await SigV4Signer_1.SigV4Signer.signRequest(options.method, url.toString(), headers, options.body ? JSON.stringify(options.body) : undefined, credentials);
                    finalHeaders = { ...headers, ...signedHeaders };
                    AuditLogger_1.auditLogger.logAuthentication(nodeId, 'AWS_SigV4', true, { endpoint: options.endpoint });
                }
                catch (error) {
                    AuditLogger_1.auditLogger.logAuthentication(nodeId, 'AWS_SigV4', false, {
                        endpoint: options.endpoint,
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                    throw new n8n_workflow_1.NodeOperationError(executeFunctions.getNode(), `AWS SigV4 signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
                        description: 'Check your AWS credentials or disable AWS signing in advanced options'
                    });
                }
            }
            // Configure axios request based on response type
            const axiosConfig = {
                method: options.method,
                url: url.toString(),
                headers: finalHeaders,
                data: options.body,
                timeout: 60000,
                validateStatus: (status) => status < 500, // Don't throw on 4xx errors
            };
            // Set response type for non-JSON responses
            if (options.responseType === 'stream') {
                axiosConfig.responseType = 'stream';
            }
            else if (options.responseType === 'text') {
                axiosConfig.responseType = 'text';
            }
            // Make the request
            const response = await (0, axios_1.default)(axiosConfig);
            const duration = Date.now() - startTime;
            // Update rate limiter with response headers
            this.rateLimiter.updateFromHeaders(rateLimitGroup, response.headers);
            // Handle non-success responses
            if (response.status >= 400) {
                // Log failed API access
                AuditLogger_1.auditLogger.logApiAccess(nodeId, options.endpoint, false, {
                    status: response.status,
                    duration,
                    method: options.method,
                    useAwsSigning,
                });
                MetricsCollector_1.metricsCollector.recordApiRequest(options.endpoint, duration, false, `HTTP_${response.status}`);
                throw await ErrorHandler_1.ErrorHandler.handleApiError(response);
            }
            // Log successful API access
            AuditLogger_1.auditLogger.logApiAccess(nodeId, options.endpoint, true, {
                status: response.status,
                duration,
                method: options.method,
                useAwsSigning,
            });
            MetricsCollector_1.metricsCollector.recordApiRequest(options.endpoint, duration, true);
            return {
                data: response.data,
                headers: response.headers,
                status: response.status,
            };
        }
        catch (error) {
            const duration = Date.now() - startTime;
            // Log error
            AuditLogger_1.auditLogger.logError(nodeId, error instanceof Error ? error : new Error('Unknown error'), {
                endpoint: options.endpoint,
                method: options.method,
                duration,
            });
            if (error instanceof n8n_workflow_1.NodeOperationError) {
                MetricsCollector_1.metricsCollector.recordApiRequest(options.endpoint, duration, false, 'NODE_OPERATION_ERROR');
                throw error;
            }
            if (axios_1.default.isAxiosError(error)) {
                MetricsCollector_1.metricsCollector.recordApiRequest(options.endpoint, duration, false, 'NETWORK_ERROR');
                throw await ErrorHandler_1.ErrorHandler.handleNetworkError(error);
            }
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            MetricsCollector_1.metricsCollector.recordApiRequest(options.endpoint, duration, false, 'UNEXPECTED_ERROR');
            throw new n8n_workflow_1.NodeOperationError(executeFunctions.getNode(), `Unexpected error: ${errorMessage}`);
        }
    }
    // removed: legacy helper
    static validateCredentials(credentials, useAwsSigning) {
        const errors = [];
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
            const advancedOptions = credentials.advancedOptions;
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
    static getBaseUrl(credentials) {
        const advancedOptions = credentials.advancedOptions;
        const customEndpoint = credentials.spApiEndpoint || advancedOptions?.spApiEndpoint;
        if (customEndpoint) {
            return customEndpoint;
        }
        const region = credentials.awsRegion;
        const environment = credentials.environment;
        const endpoints = {
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
exports.SpApiRequest = SpApiRequest;
