import { IExecuteFunctions } from 'n8n-workflow';
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
export declare class SpApiRequest {
    private static rateLimiter;
    static makeRequest<T = any>(executeFunctions: IExecuteFunctions, options: SpApiRequestOptions): Promise<SpApiResponse<T>>;
    private static validateCredentials;
    private static getBaseUrl;
}
export {};
