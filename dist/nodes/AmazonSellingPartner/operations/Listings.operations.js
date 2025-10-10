"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeListingsOperation = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const SpApiRequest_1 = require("../helpers/SpApiRequest");
const SecurityValidator_1 = require("../core/SecurityValidator");
const MetricsCollector_1 = require("../core/MetricsCollector");
const AuditLogger_1 = require("../core/AuditLogger");
// Helper function to get seller ID from credentials (required for Listings)
async function getSellerId() {
    const nodeId = this.getNode().id;
    const credentials = await this.getCredentials('amazonSpApi');
    const sellerId = credentials.sellerId;
    if (!sellerId || sellerId.trim().length === 0) {
        AuditLogger_1.auditLogger.logEvent({
            nodeId,
            action: 'seller_id_missing',
            resource: 'credentials',
            details: {},
            severity: 'high',
            source: 'system',
            outcome: 'failure'
        });
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Seller ID is required in credentials for Listings operations');
    }
    return sellerId;
}
// Helper function to format listing data for output
function formatListingForOutput(listing, marketplaceId) {
    const output = {
        asin: listing.asin,
        sku: listing.sku,
    };
    // Add summary data
    if (listing.summaries) {
        const relevantSummary = marketplaceId
            ? listing.summaries.find(s => s.marketplaceId === marketplaceId)
            : listing.summaries[0];
        if (relevantSummary) {
            output.itemName = relevantSummary.itemName;
            output.conditionType = relevantSummary.conditionType;
            output.status = relevantSummary.status;
            output.fulfillmentChannels = relevantSummary.fulfillmentChannels;
            output.createdDate = relevantSummary.createdDate;
            output.lastUpdatedDate = relevantSummary.lastUpdatedDate;
            output.mainImage = relevantSummary.mainImage;
        }
    }
    // Add attributes
    if (listing.attributes && marketplaceId) {
        const relevantAttributes = listing.attributes.find(a => a.marketplaceId === marketplaceId);
        if (relevantAttributes) {
            output.attributes = relevantAttributes.attributes.reduce((acc, attr) => {
                acc[attr.attributeName] = attr.attributeValue;
                return acc;
            }, {});
        }
    }
    // Add offers
    if (listing.offers && marketplaceId) {
        const relevantOffers = listing.offers.find(o => o.marketplaceId === marketplaceId);
        if (relevantOffers) {
            output.offers = relevantOffers.offers;
        }
    }
    // Add issues
    if (listing.issues && marketplaceId) {
        const relevantIssues = listing.issues.find(i => i.marketplaceId === marketplaceId);
        if (relevantIssues) {
            output.issues = relevantIssues.issues;
        }
    }
    // Add fulfillment availability
    if (listing.fulfillmentAvailability && marketplaceId) {
        const relevantAvailability = listing.fulfillmentAvailability.find(f => f.marketplaceId === marketplaceId);
        if (relevantAvailability) {
            output.fulfillmentAvailability = relevantAvailability.fulfillmentAvailability;
        }
    }
    // Add procurement
    if (listing.procurement && marketplaceId) {
        const relevantProcurement = listing.procurement.find(p => p.marketplaceId === marketplaceId);
        if (relevantProcurement) {
            output.procurement = relevantProcurement;
        }
    }
    // Add metadata
    output.marketplaceId = marketplaceId;
    output.extractedAt = new Date().toISOString();
    return output;
}
async function executeListingsOperation(operation, itemIndex) {
    const returnData = [];
    const nodeId = this.getNode().id;
    if (operation === 'listAsins') {
        try {
            // Start metrics collection
            const startTime = Date.now();
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'operation_start',
                resource: 'listings',
                details: { operation: 'listAsins', itemIndex },
                severity: 'low',
                source: 'user',
                outcome: 'success'
            });
            // Get parameters
            const marketplaceIds = this.getNodeParameter('marketplaceIds', itemIndex);
            const additionalOptions = this.getNodeParameter('additionalOptions', itemIndex, {});
            // Extract options with defaults
            const includedData = additionalOptions.includedData || ['summaries', 'attributes', 'offers'];
            const pageSize = additionalOptions.pageSize || 20;
            const returnAll = additionalOptions.returnAll !== false;
            const maxResultsLimit = additionalOptions.maxResultsLimit || 1000;
            const skuFilter = additionalOptions.skuFilter || '';
            const statusFilter = additionalOptions.statusFilter || [];
            const issueLocale = additionalOptions.issueLocale || 'en_US';
            // Security validation
            const marketplaceValidation = SecurityValidator_1.securityValidator.validateMarketplaceIds(marketplaceIds, nodeId);
            if (!marketplaceValidation.isValid) {
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Invalid marketplace IDs: ${marketplaceValidation.errors.join(', ')}`);
            }
            // Validate page size manually since validatePageSize doesn't exist
            if (pageSize < 1 || pageSize > 20) {
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Page size must be between 1 and 20');
            }
            // Get seller ID from credentials
            const sellerId = await getSellerId.call(this);
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'seller_id_extracted',
                resource: 'credentials',
                details: { sellerId },
                severity: 'low',
                source: 'system',
                outcome: 'success'
            });
            const allListings = [];
            let nextToken;
            let requestCount = 0;
            let totalProcessed = 0;
            do {
                requestCount++;
                AuditLogger_1.auditLogger.logEvent({
                    nodeId,
                    action: 'api_request_start',
                    resource: 'listings',
                    details: {
                        requestNumber: requestCount,
                        pageSize,
                        hasNextToken: !!nextToken,
                        totalProcessed
                    },
                    severity: 'low',
                    source: 'system',
                    outcome: 'success'
                });
                // Build query parameters
                const queryParams = {
                    marketplaceIds: marketplaceIds.join(','),
                    includedData: includedData.join(','),
                    pageSize: pageSize.toString(),
                };
                if (nextToken) {
                    queryParams.pageToken = nextToken;
                }
                if (skuFilter) {
                    queryParams.sku = skuFilter;
                }
                if (statusFilter.length > 0) {
                    queryParams.status = statusFilter.join(',');
                }
                if (issueLocale) {
                    queryParams.issuesLocale = issueLocale;
                }
                // Make API request
                const response = await SpApiRequest_1.SpApiRequest.makeRequest(this, {
                    method: 'GET',
                    endpoint: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
                    query: queryParams,
                });
                // Process response - SpApiRequest returns {data: actualResponse}
                const apiData = response.data;
                if (apiData && apiData.listings && apiData.listings.length > 0) {
                    allListings.push(...apiData.listings);
                    totalProcessed += apiData.listings.length;
                    AuditLogger_1.auditLogger.logEvent({
                        nodeId,
                        action: 'batch_processed',
                        resource: 'listings',
                        details: {
                            batchSize: apiData.listings.length,
                            totalProcessed,
                            hasNextToken: !!apiData.nextToken
                        },
                        severity: 'low',
                        source: 'system',
                        outcome: 'success'
                    });
                }
                nextToken = apiData?.nextToken;
                // Safety checks
                if (totalProcessed >= maxResultsLimit) {
                    AuditLogger_1.auditLogger.logEvent({
                        nodeId,
                        action: 'max_results_reached',
                        resource: 'listings',
                        details: { maxResultsLimit, totalProcessed },
                        severity: 'medium',
                        source: 'system',
                        outcome: 'warning'
                    });
                    break;
                }
                if (requestCount >= 100) { // Safety limit to prevent infinite loops
                    AuditLogger_1.auditLogger.logEvent({
                        nodeId,
                        action: 'max_requests_reached',
                        resource: 'listings',
                        details: { requestCount, totalProcessed },
                        severity: 'medium',
                        source: 'system',
                        outcome: 'warning'
                    });
                    break;
                }
            } while (nextToken && returnAll);
            // Format output data
            const outputData = [];
            if (marketplaceIds.length === 1) {
                // Single marketplace - flatten data
                allListings.forEach(listing => {
                    outputData.push(formatListingForOutput(listing, marketplaceIds[0]));
                });
            }
            else {
                // Multiple marketplaces - provide data per marketplace
                allListings.forEach(listing => {
                    marketplaceIds.forEach(marketplaceId => {
                        outputData.push(formatListingForOutput(listing, marketplaceId));
                    });
                });
            }
            // Add to return data
            outputData.forEach(data => {
                returnData.push({
                    json: data,
                    pairedItem: { item: itemIndex },
                });
            });
            // Collect metrics
            const duration = Date.now() - startTime;
            MetricsCollector_1.metricsCollector.recordMetric('operation_duration', duration, { operation: 'listAsins' });
            MetricsCollector_1.metricsCollector.recordMetric('api_requests_count', requestCount, { operation: 'listAsins' });
            MetricsCollector_1.metricsCollector.recordMetric('results_count', outputData.length, { operation: 'listAsins' });
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'operation_completed',
                resource: 'listings',
                details: {
                    operation: 'listAsins',
                    itemIndex,
                    duration,
                    requestCount,
                    totalListings: allListings.length,
                    outputCount: outputData.length,
                    marketplaces: marketplaceIds.length,
                },
                severity: 'low',
                source: 'system',
                outcome: 'success'
            });
        }
        catch (error) {
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'operation_failed',
                resource: 'listings',
                details: {
                    operation: 'listAsins',
                    itemIndex,
                    error: error instanceof Error ? error.message : 'Unknown error',
                },
                severity: 'high',
                source: 'system',
                outcome: 'failure'
            });
            if (error instanceof n8n_workflow_1.NodeOperationError) {
                throw error;
            }
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Amazon SP-API Listings error: ${errorMessage}`);
        }
    }
    else if (operation === 'getListingDetails') {
        try {
            // Start metrics collection
            const startTime = Date.now();
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'operation_start',
                resource: 'listing_details',
                details: { operation: 'getListingDetails', itemIndex },
                severity: 'low',
                source: 'user',
                outcome: 'success'
            });
            // Get parameters
            const identifierType = this.getNodeParameter('identifierType', itemIndex);
            const marketplaceIds = this.getNodeParameter('marketplaceIds', itemIndex);
            const detailOptions = this.getNodeParameter('detailOptions', itemIndex, {});
            let identifier;
            if (identifierType === 'sku') {
                identifier = this.getNodeParameter('sku', itemIndex);
            }
            else {
                identifier = this.getNodeParameter('asin', itemIndex);
            }
            // Extract options with defaults
            const includedData = detailOptions.includedData || ['summaries', 'attributes', 'offers', 'issues'];
            const issueLocale = detailOptions.issueLocale || 'en_US';
            // Security validation
            const marketplaceValidation = SecurityValidator_1.securityValidator.validateMarketplaceIds(marketplaceIds, nodeId);
            if (!marketplaceValidation.isValid) {
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Invalid marketplace IDs: ${marketplaceValidation.errors.join(', ')}`);
            }
            // Validate identifier
            if (!identifier || identifier.trim().length === 0) {
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Identifier cannot be empty');
            }
            // Get seller ID from credentials
            const sellerId = await getSellerId.call(this);
            // Build query parameters
            const queryParams = {
                marketplaceIds: marketplaceIds.join(','),
                includedData: includedData.join(','),
            };
            if (issueLocale) {
                queryParams.issuesLocale = issueLocale;
            }
            // Build endpoint
            let endpoint;
            if (identifierType === 'sku') {
                endpoint = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(identifier)}`;
            }
            else {
                // For ASIN-based lookup, we'll use the search endpoint with ASIN filter
                queryParams.asin = identifier;
                endpoint = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`;
            }
            // Make API request
            const response = await SpApiRequest_1.SpApiRequest.makeRequest(this, {
                method: 'GET',
                endpoint,
                query: queryParams,
            });
            let listingData;
            if (identifierType === 'sku') {
                // Direct SKU response
                listingData = response.data;
            }
            else {
                // ASIN search response - find matching ASIN
                if (response.data?.listings && response.data.listings.length > 0) {
                    const matchingListing = response.data.listings.find((listing) => listing.asin === identifier);
                    if (matchingListing) {
                        listingData = matchingListing;
                    }
                    else {
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `No listing found for ASIN: ${identifier}`);
                    }
                }
                else {
                    throw new n8n_workflow_1.NodeOperationError(this.getNode(), `No listing found for ASIN: ${identifier}`);
                }
            }
            // Format output data for all marketplaces
            const outputData = [];
            marketplaceIds.forEach(marketplaceId => {
                outputData.push(formatListingForOutput(listingData, marketplaceId));
            });
            // Add to return data
            outputData.forEach(data => {
                returnData.push({
                    json: data,
                    pairedItem: { item: itemIndex },
                });
            });
            // Collect metrics
            const duration = Date.now() - startTime;
            MetricsCollector_1.metricsCollector.recordMetric('operation_duration', duration, { operation: 'getListingDetails' });
            MetricsCollector_1.metricsCollector.recordMetric('results_count', outputData.length, { operation: 'getListingDetails' });
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'operation_completed',
                resource: 'listing_details',
                details: {
                    operation: 'getListingDetails',
                    itemIndex,
                    duration,
                    identifier,
                    identifierType,
                    outputCount: outputData.length,
                    marketplaces: marketplaceIds.length,
                },
                severity: 'low',
                source: 'system',
                outcome: 'success'
            });
        }
        catch (error) {
            AuditLogger_1.auditLogger.logEvent({
                nodeId,
                action: 'operation_failed',
                resource: 'listing_details',
                details: {
                    operation: 'getListingDetails',
                    itemIndex,
                    error: error instanceof Error ? error.message : 'Unknown error',
                },
                severity: 'high',
                source: 'system',
                outcome: 'failure'
            });
            if (error instanceof n8n_workflow_1.NodeOperationError) {
                throw error;
            }
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Amazon SP-API Listings error: ${errorMessage}`);
        }
    }
    else {
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
    }
    return returnData;
}
exports.executeListingsOperation = executeListingsOperation;
