"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmazonSpApi = void 0;
class AmazonSpApi {
    name = 'amazonSpApi';
    displayName = 'Amazon Selling Partner API';
    documentationUrl = 'https://developer-docs.amazon.com/sp-api/docs/what-is-the-selling-partner-api';
    properties = [
        {
            displayName: 'Environment',
            name: 'environment',
            type: 'options',
            options: [
                {
                    name: 'Production',
                    value: 'production',
                },
                {
                    name: 'Sandbox',
                    value: 'sandbox',
                },
            ],
            default: 'sandbox',
            description: 'The environment to use for API calls',
        },
        {
            displayName: 'AWS Region',
            name: 'awsRegion',
            type: 'options',
            options: [
                {
                    name: 'North America (us-east-1)',
                    value: 'us-east-1',
                },
                {
                    name: 'Europe (eu-west-1)',
                    value: 'eu-west-1',
                },
                {
                    name: 'Far East (us-west-2)',
                    value: 'us-west-2',
                },
            ],
            default: 'us-east-1',
            description: 'AWS region for your SP-API application',
        },
        {
            displayName: 'Notice',
            name: 'notice',
            type: 'notice',
            default: '',
            displayOptions: {
                show: {},
            },
            description: 'For basic operations, you only need LWA credentials below. AWS credentials are optional and only required for advanced operations or if your SP-API application specifically requires AWS SigV4 signing.',
        },
        {
            displayName: 'LWA Client ID',
            name: 'lwaClientId',
            type: 'string',
            default: '',
            required: true,
            description: 'Login with Amazon (LWA) Client ID from your SP-API application',
        },
        {
            displayName: 'LWA Client Secret',
            name: 'lwaClientSecret',
            type: 'string',
            typeOptions: {
                password: true,
            },
            default: '',
            required: true,
            description: 'Login with Amazon (LWA) Client Secret from your SP-API application',
        },
        {
            displayName: 'LWA Refresh Token',
            name: 'lwaRefreshToken',
            type: 'string',
            typeOptions: {
                password: true,
            },
            default: '',
            required: true,
            description: 'Login with Amazon (LWA) Refresh Token obtained during authorization',
        },
        {
            displayName: 'Seller ID',
            name: 'sellerId',
            type: 'string',
            default: '',
            required: false,
            description: 'Your Amazon Seller ID. Required for Listings operations.',
        },
        {
            displayName: 'Advanced Options',
            name: 'advancedOptions',
            type: 'collection',
            placeholder: 'Add Advanced Option',
            default: {},
            options: [
                {
                    displayName: 'AWS Access Key ID',
                    name: 'awsAccessKeyId',
                    type: 'string',
                    default: '',
                    description: 'AWS Access Key ID for your IAM user with SP-API permissions (optional for most operations)',
                },
                {
                    displayName: 'AWS Secret Access Key',
                    name: 'awsSecretAccessKey',
                    type: 'string',
                    typeOptions: {
                        password: true,
                    },
                    default: '',
                    description: 'AWS Secret Access Key for your IAM user (optional for most operations)',
                },
                {
                    displayName: 'AWS Role ARN',
                    name: 'awsRoleArn',
                    type: 'string',
                    default: '',
                    description: 'AWS Role ARN to assume for SP-API calls (for enhanced security)',
                },
                {
                    displayName: 'SP-API Endpoint Override',
                    name: 'spApiEndpoint',
                    type: 'string',
                    default: '',
                    description: 'Override the default SP-API endpoint URL',
                },
                {
                    displayName: 'Use AWS SigV4 Signing',
                    name: 'useAwsSigning',
                    type: 'boolean',
                    default: false,
                    description: 'Enable AWS SigV4 request signing (requires AWS credentials above)',
                },
            ],
        },
    ];
    authenticate = {
        type: 'generic',
        properties: {},
    };
    test = {
        request: {
            baseURL: '={{$credentials.advancedOptions.spApiEndpoint || ($credentials.environment === "sandbox" ? ($credentials.awsRegion === "eu-west-1" ? "https://sandbox.sellingpartnerapi-eu.amazon.com" : ($credentials.awsRegion === "us-west-2" ? "https://sandbox.sellingpartnerapi-fe.amazon.com" : "https://sandbox.sellingpartnerapi-na.amazon.com")) : ($credentials.awsRegion === "eu-west-1" ? "https://sellingpartnerapi-eu.amazon.com" : ($credentials.awsRegion === "us-west-2" ? "https://sellingpartnerapi-fe.amazon.com" : "https://sellingpartnerapi-na.amazon.com")))}}',
            url: '/sellers/v1/marketplaceParticipations',
            method: 'GET',
        },
    };
}
exports.AmazonSpApi = AmazonSpApi;
