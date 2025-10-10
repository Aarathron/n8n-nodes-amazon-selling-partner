export interface RateLimitConfig {
	rate: number; // requests per second
	burst: number; // maximum burst capacity
	description?: string;
}

// Rate limit groups based on Amazon SP-API documentation
export const RATE_LIMIT_GROUPS: Record<string, RateLimitConfig> = {
	// Orders API - Detail operations (getOrder, getOrderItems, getOrderAddress, etc.)
	'orders-detail': {
		rate: 0.5,
		burst: 30,
		description: 'Order detail operations: getOrder, getOrderItems, getOrderAddress, getOrderBuyerInfo, etc.'
	},
	
	// Orders API - List operations (getOrders)
	'orders-list': {
		rate: 0.0167, // 1 request per 60 seconds
		burst: 20,
		description: 'Order list operations: getOrders'
	},
	
	// Orders API - Update operations
	'orders-update': {
		rate: 2.0,
		burst: 10,
		description: 'Order update operations: confirmShipment, updateShipmentStatus'
	},
	
	// Reports API - All operations
	'reports': {
		rate: 0.0167, // 1 request per 60 seconds
		burst: 15,
		description: 'Reports API operations: createReport, getReport, getReportDocument'
	},
	
	// Analytics API - Data Kiosk and Analytics operations
	'analytics': {
		rate: 0.0167, // 1 request per 60 seconds (conservative, similar to reports)
		burst: 10,
		description: 'Analytics and Data Kiosk API operations: salesAndTraffic, etc.'
	},
	
	// Default fallback for unclassified endpoints
	'default': {
		rate: 0.5,
		burst: 10,
		description: 'Default rate limit for unclassified endpoints'
	}
};

// Endpoint pattern to group mapping
export const ENDPOINT_TO_GROUP: Array<{ pattern: RegExp; group: string }> = [
	// Orders API patterns
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/orderItems/, group: 'orders-detail' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/orderAddress/, group: 'orders-detail' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/buyerInfo/, group: 'orders-detail' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/orderItemsBuyerInfo/, group: 'orders-detail' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/regulatedInfo/, group: 'orders-detail' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+$/, group: 'orders-detail' }, // getOrder
	{ pattern: /^\/orders\/v0\/orders\/?(\?.*)?$/, group: 'orders-list' }, // getOrders
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/shipment/, group: 'orders-update' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/shipmentConfirmation$/, group: 'orders-update' },
	{ pattern: /^\/orders\/v0\/orders\/[^/]+\/shipmentStatus$/, group: 'orders-update' },
	
	// Reports API patterns
	{ pattern: /^\/reports\/2021-06-30\/reports\/?(\?.*)?$/, group: 'reports' }, // createReport, getReports
	{ pattern: /^\/reports\/2021-06-30\/reports\/[^/]+$/, group: 'reports' }, // getReport
	{ pattern: /^\/reports\/2021-06-30\/documents\/[^/]+$/, group: 'reports' }, // getReportDocument
	
	// Analytics API patterns
	{ pattern: /^\/analytics\/\d{4}-\d{2}-\d{2}\/.*$/, group: 'analytics' }, // Analytics API endpoints
	{ pattern: /^\/dataKiosk\/\d{4}-\d{2}-\d{2}\/analytics\/.*$/, group: 'analytics' }, // Data Kiosk Analytics endpoints
	{ pattern: /^\/dataKiosk\/\d{4}-\d{2}-\d{2}\/salesAndTraffic.*$/, group: 'analytics' }, // Data Kiosk Sales & Traffic
	
	// Add more patterns as needed for other APIs
];

/**
 * Get the rate limit group for a given endpoint
 */
export function getEndpointGroup(endpoint: string): string {
	for (const { pattern, group } of ENDPOINT_TO_GROUP) {
		if (pattern.test(endpoint)) {
			return group;
		}
	}
	return 'default';
}

/**
 * Get rate limit configuration for a group, with environment variable overrides
 */
export function getRateLimitConfig(group: string): RateLimitConfig {
	const baseConfig = RATE_LIMIT_GROUPS[group] || RATE_LIMIT_GROUPS['default'];
	
	// Allow environment variable overrides
	const envOverride = process.env.RATE_LIMIT_OVERRIDE_JSON;
	if (envOverride) {
		try {
			const overrides = JSON.parse(envOverride);
			if (overrides[group]) {
				return {
					...baseConfig,
					...overrides[group]
				};
			}
		} catch (error) {
			console.warn('Failed to parse RATE_LIMIT_OVERRIDE_JSON:', error);
		}
	}
	
	return baseConfig;
}

/**
 * Validate rate limit configuration
 */
export function validateRateLimitConfig(config: RateLimitConfig): boolean {
	return (
		typeof config.rate === 'number' &&
		config.rate > 0 &&
		typeof config.burst === 'number' &&
		config.burst > 0 &&
		config.burst >= 1 // Must allow at least 1 request
	);
} 