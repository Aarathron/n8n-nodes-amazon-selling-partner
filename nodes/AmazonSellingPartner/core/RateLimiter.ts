import { NodeOperationError } from 'n8n-workflow';
import { metricsCollector } from './MetricsCollector';
import { getRateLimitConfig, validateRateLimitConfig, type RateLimitConfig } from './rateLimitConfig';

interface TokenBucket {
	tokens: number;
	maxTokens: number;
	refillRate: number; // tokens per second
	lastRefill: number;
	config: RateLimitConfig;
}

interface QueuedRequest {
	resolve: () => void;
	reject: (error: Error) => void;
	timestamp: number;
	groupKey: string;
}

interface RateLimit {
	bucket: TokenBucket;
	requestQueue: QueuedRequest[];
	processingInterval?: NodeJS.Timeout;
}

interface RateLimiterMetrics {
	queueLength: number;
	waitTimeMs: number;
	rateLimitHits: number;
	activeGroups: number;
}

// Optional distributed backend interface
interface DistributedBackend {
	getTokens(groupKey: string): Promise<number>;
	consumeTokens(groupKey: string, count: number): Promise<boolean>;
	refillTokens(groupKey: string, tokens: number, maxTokens: number): Promise<void>;
}

export class RateLimiter {
	private limits = new Map<string, RateLimit>();
	private readonly QUEUE_TIMEOUT: number;
	private readonly MAX_RETRIES = 10;
	private readonly BASE_RETRY_DELAY = 2000; // 2 seconds
	private readonly MAX_RETRY_DELAY = 60000; // 60 seconds
	private distributedBackend?: DistributedBackend;
	private metrics: RateLimiterMetrics = {
		queueLength: 0,
		waitTimeMs: 0,
		rateLimitHits: 0,
		activeGroups: 0,
	};

	constructor(options: {
		queueTimeout?: number;
		distributedBackend?: DistributedBackend;
	} = {}) {
		this.QUEUE_TIMEOUT = options.queueTimeout || parseInt(process.env.RATE_LIMIT_QUEUE_TIMEOUT || '300000'); // 5 minutes
		this.distributedBackend = options.distributedBackend;
		
		// Start metrics collection
		this.startMetricsCollection();
	}

	async waitForToken(groupKey: string, retryCount = 0): Promise<void> {
		const startTime = Date.now();
		const rateLimit = this.getRateLimit(groupKey);
		
		try {
			// Try to get token from distributed backend first
			if (this.distributedBackend) {
				const success = await this.distributedBackend.consumeTokens(groupKey, 1);
				if (success) {
					const waitTime = Date.now() - startTime;
					this.updateMetrics({ waitTimeMs: waitTime });
					return;
				}
			} else {
				// Use local token bucket
				await this.refillTokens(groupKey, rateLimit.bucket);

				// If we have tokens, consume one and proceed
				if (rateLimit.bucket.tokens >= 1) {
					rateLimit.bucket.tokens -= 1;
					const waitTime = Date.now() - startTime;
					this.updateMetrics({ waitTimeMs: waitTime });
					return;
				}
			}

			// No tokens available, queue the request
			this.recordRateLimitHit(groupKey);
			
			return new Promise((resolve, reject) => {
				const queueItem: QueuedRequest = {
					resolve: () => {
						const waitTime = Date.now() - startTime;
						this.updateMetrics({ waitTimeMs: waitTime });
						resolve();
					},
					reject,
					timestamp: Date.now(),
					groupKey,
				};

				rateLimit.requestQueue.push(queueItem);
				this.updateQueueMetrics();

				// Set timeout for queued request
				setTimeout(() => {
					const index = rateLimit.requestQueue.indexOf(queueItem);
					if (index !== -1) {
						rateLimit.requestQueue.splice(index, 1);
						this.updateQueueMetrics();
						
						// Try retry with exponential backoff
						if (retryCount < this.MAX_RETRIES) {
							const delay = this.calculateRetryDelay(retryCount);
							setTimeout(() => {
								this.waitForToken(groupKey, retryCount + 1)
									.then(resolve)
									.catch(reject);
							}, delay);
						} else {
							reject(new NodeOperationError(
								{} as any,
								`Request timeout: Rate limit queue exceeded maximum wait time after ${retryCount} retries`,
								{ description: `The request was queued for too long due to rate limiting for group: ${groupKey}` }
							));
						}
					}
				}, this.QUEUE_TIMEOUT);

				// Start processing queue if not already running
				this.processQueue(groupKey);
			});
		} catch (error) {
			const waitTime = Date.now() - startTime;
			this.updateMetrics({ waitTimeMs: waitTime });
			throw error;
		}
	}

	updateFromHeaders(groupKey: string, headers: Record<string, string>): void {
		const rateLimitHeader = headers['x-amzn-ratelimit-limit'];
		if (!rateLimitHeader) return;

		try {
			const [rate, burst] = rateLimitHeader.split(':').map(Number);
			if (rate && burst) {
				const rateLimit = this.getRateLimit(groupKey);
				const newConfig: RateLimitConfig = {
					rate,
					burst,
					description: `Updated from API headers for ${groupKey}`
				};
				
				if (validateRateLimitConfig(newConfig)) {
					rateLimit.bucket.refillRate = rate;
					rateLimit.bucket.maxTokens = burst;
					rateLimit.bucket.config = newConfig;
					
					// Ensure current tokens don't exceed new max
					rateLimit.bucket.tokens = Math.min(rateLimit.bucket.tokens, burst);
					
					// Update distributed backend if available
					if (this.distributedBackend) {
						this.distributedBackend.refillTokens(groupKey, rateLimit.bucket.tokens, burst);
					}
				}
			}
		} catch (error) {
			// Ignore parsing errors, use defaults
			console.warn(`Failed to parse rate limit header for ${groupKey}:`, error);
		}
	}

	getMetrics(): RateLimiterMetrics & { groupDetails: Record<string, { queueLength: number; tokens: number; maxTokens: number }> } {
		const groupDetails: Record<string, { queueLength: number; tokens: number; maxTokens: number }> = {};
		
		for (const [groupKey, rateLimit] of this.limits.entries()) {
			groupDetails[groupKey] = {
				queueLength: rateLimit.requestQueue.length,
				tokens: Math.floor(rateLimit.bucket.tokens),
				maxTokens: rateLimit.bucket.maxTokens,
			};
		}

		return {
			...this.metrics,
			activeGroups: this.limits.size,
			groupDetails,
		};
	}

	private getRateLimit(groupKey: string): RateLimit {
		if (!this.limits.has(groupKey)) {
			const config = getRateLimitConfig(groupKey);
			
			if (!validateRateLimitConfig(config)) {
				throw new Error(`Invalid rate limit configuration for group: ${groupKey}`);
			}

			this.limits.set(groupKey, {
				bucket: {
					tokens: config.burst,
					maxTokens: config.burst,
					refillRate: config.rate,
					lastRefill: Date.now(),
					config,
				},
				requestQueue: [],
			});
		}
		return this.limits.get(groupKey)!;
	}

	private async refillTokens(groupKey: string, bucket: TokenBucket): Promise<void> {
		const now = Date.now();
		const timePassed = (now - bucket.lastRefill) / 1000; // seconds
		const tokensToAdd = timePassed * bucket.refillRate;
		
		bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
		bucket.lastRefill = now;

		// Update distributed backend if available
		if (this.distributedBackend) {
			await this.distributedBackend.refillTokens(groupKey, bucket.tokens, bucket.maxTokens);
		}
	}

	private processQueue(groupKey: string): void {
		const rateLimit = this.getRateLimit(groupKey);
		
		// Don't start multiple intervals for the same group
		if (rateLimit.processingInterval) {
			return;
		}

		// Process queue periodically
		rateLimit.processingInterval = setInterval(async () => {
			try {
				if (this.distributedBackend) {
					// Use distributed backend
					while (rateLimit.requestQueue.length > 0) {
						const success = await this.distributedBackend.consumeTokens(groupKey, 1);
						if (!success) break;
						
						const queueItem = rateLimit.requestQueue.shift()!;
						queueItem.resolve();
					}
				} else {
					// Use local bucket
					await this.refillTokens(groupKey, rateLimit.bucket);
					
					while (rateLimit.requestQueue.length > 0 && rateLimit.bucket.tokens >= 1) {
						const queueItem = rateLimit.requestQueue.shift()!;
						rateLimit.bucket.tokens -= 1;
						queueItem.resolve();
					}
				}

				// Clean up expired queue items
				const now = Date.now();
				const initialLength = rateLimit.requestQueue.length;
				rateLimit.requestQueue = rateLimit.requestQueue.filter(item => {
					if (now - item.timestamp > this.QUEUE_TIMEOUT) {
						item.reject(new NodeOperationError(
							{} as any,
							'Request timeout: Exceeded maximum queue wait time',
							{ description: `Request for group ${groupKey} timed out in queue` }
						));
						return false;
					}
					return true;
				});

				if (initialLength !== rateLimit.requestQueue.length) {
					this.updateQueueMetrics();
				}

				// Stop processing if queue is empty
				if (rateLimit.requestQueue.length === 0) {
					if (rateLimit.processingInterval) {
						clearInterval(rateLimit.processingInterval);
						rateLimit.processingInterval = undefined;
					}
				}
			} catch (error) {
				console.error(`Error processing rate limit queue for ${groupKey}:`, error);
			}
		}, 1000); // Check every second
	}

	private calculateRetryDelay(retryCount: number): number {
		// Exponential backoff with jitter
		const exponentialDelay = Math.min(this.BASE_RETRY_DELAY * Math.pow(2, retryCount), this.MAX_RETRY_DELAY);
		const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
		return exponentialDelay + jitter;
	}

	private recordRateLimitHit(groupKey: string): void {
		this.metrics.rateLimitHits++;
		metricsCollector.recordRateLimitHit(groupKey);
	}

	private updateQueueMetrics(): void {
		let totalQueueLength = 0;
		for (const rateLimit of this.limits.values()) {
			totalQueueLength += rateLimit.requestQueue.length;
		}
		this.metrics.queueLength = totalQueueLength;
	}

	private updateMetrics(updates: Partial<RateLimiterMetrics>): void {
		Object.assign(this.metrics, updates);
	}

	private startMetricsCollection(): void {
		// Export metrics every 30 seconds
		setInterval(() => {
			const metrics = this.getMetrics();
			
			// Record metrics for monitoring
			metricsCollector.recordMetric('rate_limiter_queue_length', metrics.queueLength);
			metricsCollector.recordMetric('rate_limiter_active_groups', metrics.activeGroups);
			
			// Record per-group metrics
			for (const [groupKey, details] of Object.entries(metrics.groupDetails)) {
				metricsCollector.recordMetric('rate_limiter_group_queue_length', details.queueLength, { group: groupKey });
				metricsCollector.recordMetric('rate_limiter_group_tokens', details.tokens, { group: groupKey });
			}
		}, 30000);
	}

	// Cleanup method for graceful shutdown
	cleanup(): void {
		for (const rateLimit of this.limits.values()) {
			if (rateLimit.processingInterval) {
				clearInterval(rateLimit.processingInterval);
			}
			
			// Reject all queued requests
			rateLimit.requestQueue.forEach(item => {
				item.reject(new Error('Rate limiter shutting down'));
			});
		}
		this.limits.clear();
	}
} 