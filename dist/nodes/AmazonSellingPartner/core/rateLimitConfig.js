"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRateLimitConfig = exports.getRateLimitConfig = exports.getEndpointGroup = exports.ENDPOINT_TO_GROUP = exports.RATE_LIMIT_GROUPS = void 0;
// Rate limit groups based on Amazon SP-API documentation
exports.RATE_LIMIT_GROUPS = {
    // Orders API - Detail operations (getOrder, getOrderItems, getOrderAddress, etc.)
    'orders-detail': {
        rate: 0.5,
        burst: 30,
        description: 'Order detail operations: getOrder, getOrderItems, getOrderAddress, getOrderBuyerInfo, etc.'
    },
    // Orders API - List operations (getOrders)
    'orders-list': {
        rate: 0.0167,
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
        rate: 0.0167,
        burst: 15,
        description: 'Reports API operations: createReport, getReport, getReportDocument'
    },
    // Analytics API - Data Kiosk and Analytics operations
    'analytics': {
        rate: 0.0167,
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
exports.ENDPOINT_TO_GROUP = [
    // Orders API patterns
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/orderItems/, group: 'orders-detail' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/orderAddress/, group: 'orders-detail' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/buyerInfo/, group: 'orders-detail' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/orderItemsBuyerInfo/, group: 'orders-detail' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/regulatedInfo/, group: 'orders-detail' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+$/, group: 'orders-detail' },
    { pattern: /^\/orders\/v0\/orders\/?(\?.*)?$/, group: 'orders-list' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/shipment/, group: 'orders-update' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/shipmentConfirmation$/, group: 'orders-update' },
    { pattern: /^\/orders\/v0\/orders\/[^/]+\/shipmentStatus$/, group: 'orders-update' },
    // Reports API patterns
    { pattern: /^\/reports\/2021-06-30\/reports\/?(\?.*)?$/, group: 'reports' },
    { pattern: /^\/reports\/2021-06-30\/reports\/[^/]+$/, group: 'reports' },
    { pattern: /^\/reports\/2021-06-30\/documents\/[^/]+$/, group: 'reports' },
    // Analytics API patterns
    { pattern: /^\/analytics\/\d{4}-\d{2}-\d{2}\/.*$/, group: 'analytics' },
    { pattern: /^\/dataKiosk\/\d{4}-\d{2}-\d{2}\/analytics\/.*$/, group: 'analytics' },
    { pattern: /^\/dataKiosk\/\d{4}-\d{2}-\d{2}\/salesAndTraffic.*$/, group: 'analytics' }, // Data Kiosk Sales & Traffic
    // Add more patterns as needed for other APIs
];
/**
 * Get the rate limit group for a given endpoint
 */
function getEndpointGroup(endpoint) {
    for (const { pattern, group } of exports.ENDPOINT_TO_GROUP) {
        if (pattern.test(endpoint)) {
            return group;
        }
    }
    return 'default';
}
exports.getEndpointGroup = getEndpointGroup;
/**
 * Get rate limit configuration for a group, with environment variable overrides
 */
function getRateLimitConfig(group) {
    const baseConfig = exports.RATE_LIMIT_GROUPS[group] || exports.RATE_LIMIT_GROUPS['default'];
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
        }
        catch (error) {
            console.warn('Failed to parse RATE_LIMIT_OVERRIDE_JSON:', error);
        }
    }
    return baseConfig;
}
exports.getRateLimitConfig = getRateLimitConfig;
/**
 * Validate rate limit configuration
 */
function validateRateLimitConfig(config) {
    return (typeof config.rate === 'number' &&
        config.rate > 0 &&
        typeof config.burst === 'number' &&
        config.burst > 0 &&
        config.burst >= 1 // Must allow at least 1 request
    );
}
exports.validateRateLimitConfig = validateRateLimitConfig;
