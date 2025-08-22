import {
	IExecuteFunctions,
	INodeExecutionData,
	NodeOperationError,
} from 'n8n-workflow';
import { SpApiRequest } from '../helpers/SpApiRequest';
import { ReportDownloader } from '../helpers/ReportDownloader';
import { securityValidator } from '../core/SecurityValidator';
import { metricsCollector } from '../core/MetricsCollector';
import { auditLogger } from '../core/AuditLogger';
import {
	ANALYTICS_METRICS,
	SCHEMA_VERSIONS,
	DEFAULT_SETTINGS,
	buildDataKioskEndpoint,
	REPORTS_FALLBACK_MAPPING,
} from './analytics/constants';

// Core interfaces
interface AnalyticsRequest {
	marketplaceIds: string[];
	startDate: string;
	endDate: string;
	granularity: 'DAILY' | 'WEEKLY' | 'MONTHLY';
	metrics: string[];
	dimensions?: string[];
	filters?: Record<string, any>;
	sort?: {
		metric: string;
		direction: 'asc' | 'desc';
	};
	limit?: number;
	pageToken?: string;
}

interface AnalyticsResponse {
	data: AnalyticsDataPoint[];
	nextToken?: string;
	metadata?: {
		totalResults?: number;
		currency?: string;
		timezone?: string;
		reportId?: string;
		reportType?: string;
		generatedAt?: string;
		chunked?: boolean;
		totalChunks?: number;
	};
}

interface AnalyticsDataPoint {
	asin: string;
	marketplaceId: string;
	date: string;
	metrics: Record<string, number | null>;
	[key: string]: any;
}

interface NormalizedRow {
	asin: string;
	sku?: string;
	marketplaceId: string;
	marketplaceName?: string;
	date: string;
	granularity: string;
	[metricId: string]: any;
}

// Main execution function
export async function executeAnalyticsOperation(
	this: IExecuteFunctions,
	operation: string,
	index: number,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'salesAndTrafficByAsin':
			return await getSalesAndTrafficByAsin.call(this, index);
		case 'validateAccess':
			return await validateAnalyticsAccess.call(this, index);
		default:
			throw new NodeOperationError(this.getNode(), `Unknown analytics operation: ${operation}`);
	}
}

// Validate Analytics Access
async function validateAnalyticsAccess(
	this: IExecuteFunctions,
	_index: number,
): Promise<INodeExecutionData[]> {
	const nodeId = this.getNode().id;
	
	try {
		// Test Data Kiosk access
		let dataKioskAccess = false;
		let reportsAccess = false;
		let errors: string[] = [];

		try {
			const dataKioskEndpoint = buildDataKioskEndpoint('2024-04-24', 'salesAndTraffic');
			await SpApiRequest.makeRequest(this, {
				method: 'GET',
				endpoint: `${dataKioskEndpoint}/validate`,
			});
			dataKioskAccess = true;
		} catch (error) {
			errors.push(`Data Kiosk: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}

		// Test Reports API access
		try {
			await SpApiRequest.makeRequest(this, {
				method: 'GET',
				endpoint: '/reports/2021-06-30/reports',
				query: { reportTypes: 'GET_SALES_AND_TRAFFIC_REPORT' },
			});
			reportsAccess = true;
		} catch (error) {
			errors.push(`Reports API: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}

		const result = {
			success: dataKioskAccess || reportsAccess,
			dataKioskAccess,
			reportsAccess,
			recommendedMode: dataKioskAccess ? 'dataKiosk' : reportsAccess ? 'reports' : 'none',
			errors: errors.length > 0 ? errors : undefined,
			timestamp: new Date().toISOString(),
		};

		auditLogger.logEvent({
			nodeId,
			action: 'analytics_access_validation',
			resource: 'analytics',
			details: result,
			severity: result.success ? 'low' : 'high',
			source: 'system',
			outcome: result.success ? 'success' : 'failure',
		});

		return [{ json: result }];
	} catch (error) {
		throw new NodeOperationError(
			this.getNode(),
			`Failed to validate analytics access: ${error instanceof Error ? error.message : 'Unknown error'}`
		);
	}
}

// Main Sales & Traffic by ASIN operation
async function getSalesAndTrafficByAsin(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	const nodeId = this.getNode().id;
	const startTime = Date.now();

	try {
		// Parse parameters
		const params = await parseAnalyticsParameters.call(this, index);
		
		// Validate parameters
		await validateAnalyticsParameters.call(this, params, nodeId);

		// Resolve SKUs to ASINs if needed
		if (params.filters?.skus?.length > 0 && params.filters.resolveSKUs) {
			params.filters.asins = await resolveSKUsToASINs.call(this, params.filters.skus, params.marketplaceIds);
		}

		// Execute analytics request with fallback
		let analyticsData: AnalyticsResponse;
		let usedMode: string;

		try {
			if (params.advancedOptions.analyticsMode === 'reports') {
				analyticsData = await executeReportsMode.call(this, params);
				usedMode = 'reports';
			} else {
				try {
					analyticsData = await executeDataKioskMode.call(this, params);
					usedMode = 'dataKiosk';
				} catch (error) {
					if (params.advancedOptions.analyticsMode === 'auto') {
						auditLogger.logEvent({
							nodeId,
							action: 'analytics_fallback',
							resource: 'analytics',
							details: { 
								originalMode: 'dataKiosk',
								fallbackMode: 'reports',
								error: error instanceof Error ? error.message : 'Unknown error'
							},
							severity: 'medium',
							source: 'system',
							outcome: 'success',
						});
						analyticsData = await executeReportsMode.call(this, params);
						usedMode = 'reports';
					} else {
						throw error;
					}
				}
			}
		} catch (error) {
			metricsCollector.recordApiRequest('analytics', Date.now() - startTime, false, 'EXECUTION_ERROR');
			throw error;
		}

		// Normalize and process data
		const normalizedData = normalizeAnalyticsData(analyticsData.data, params);
		
		// Apply computed metrics
		const dataWithComputedMetrics = addComputedMetrics(normalizedData, params.selectedMetrics);

		// Apply sorting and limiting
		const sortedData = applySortingAndLimiting(dataWithComputedMetrics, params.sortingLimiting);

		// Join listing data if requested
		let finalData = sortedData;
		if (params.outputOptions.joinListingData) {
			finalData = await joinListingData.call(this, sortedData, params.marketplaceIds);
		}

		// Apply currency normalization if requested
		if (params.outputOptions.currencyNormalization === 'normalize') {
			finalData = normalizeCurrency(finalData, params.outputOptions.baseCurrency, params.outputOptions.exchangeRates);
		}

		// Generate output based on format
		const result = await generateOutput.call(this, finalData, params, {
			usedMode,
			totalResults: analyticsData.data.length,
			executionTime: Date.now() - startTime,
			metadata: analyticsData.metadata,
		});

		metricsCollector.recordApiRequest('analytics', Date.now() - startTime, true);

		return result;

	} catch (error) {
		const duration = Date.now() - startTime;
		auditLogger.logError(nodeId, error instanceof Error ? error : new Error('Unknown error'), {
			operation: 'salesAndTrafficByAsin',
			duration,
		});
		metricsCollector.recordApiRequest('analytics', duration, false, 'OPERATION_ERROR');
		
		if (error instanceof NodeOperationError) {
			throw error;
		}
		
		throw new NodeOperationError(
			this.getNode(),
			`Analytics operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
		);
	}
}

// Parse and validate parameters
async function parseAnalyticsParameters(this: IExecuteFunctions, index: number) {
	const marketplaceIds = this.getNodeParameter('marketplaceIds', index) as string[];
	const dateRangeType = this.getNodeParameter('dateRangeType', index) as string;
	const granularity = this.getNodeParameter('granularity', index) as string;
	const timezone = this.getNodeParameter('timezone', index, DEFAULT_SETTINGS.timezone) as string;
	
	// Parse date range
	let startDate: string, endDate: string;
	if (dateRangeType === 'absolute') {
		startDate = new Date(this.getNodeParameter('startDate', index) as string).toISOString();
		endDate = new Date(this.getNodeParameter('endDate', index) as string).toISOString();
	} else {
		const datePreset = this.getNodeParameter('datePreset', index) as string;
		const customDays = this.getNodeParameter('customDays', index, 30) as number;
		const dateRange = calculateDateRange(datePreset, customDays, timezone);
		startDate = dateRange.startDate;
		endDate = dateRange.endDate;
	}

	// Parse metrics selection with safety fallback
	const metricsSelection = this.getNodeParameter('metricsSelection', index, {
		trafficMetrics: [{ metrics: ['sessions', 'pageViews'] }],
		salesMetrics: [{ metrics: ['unitsOrdered', 'orderedProductSales'] }],
		conversionMetrics: [{ metrics: ['unitSessionPercentage'] }],
	}) as any;
	const selectedMetrics = extractSelectedMetrics(metricsSelection);

	// Parse other parameters
	const filters = this.getNodeParameter('filters', index, {}) as any;
	const sortingLimiting = this.getNodeParameter('sortingLimiting', index, {}) as any;
	const outputOptions = this.getNodeParameter('outputOptions', index, {}) as any;
	const advancedOptions = this.getNodeParameter('advancedOptions', index, {}) as any;

	return {
		marketplaceIds,
		startDate,
		endDate,
		granularity,
		timezone,
		selectedMetrics,
		filters,
		sortingLimiting: {
			sortBy: sortingLimiting.sortBy || 'orderedProductSales',
			sortDirection: sortingLimiting.sortDirection || 'desc',
			topN: sortingLimiting.topN || 100,
			secondarySort: sortingLimiting.secondarySort || '',
		},
		outputOptions: {
			format: outputOptions.format || 'jsonFlat',
			csvDelimiter: outputOptions.csvDelimiter || ',',
			csvDecimalSeparator: outputOptions.csvDecimalSeparator || '.',
			csvFilename: outputOptions.csvFilename || 'analytics_sales_traffic_{marketplace}_{start}_{end}.csv',
			includeHeaders: outputOptions.includeHeaders !== false,
			pivot: outputOptions.pivot || 'none',
			currencyNormalization: outputOptions.currencyNormalization || 'native',
			baseCurrency: outputOptions.baseCurrency || 'USD',
			exchangeRates: parseExchangeRates(outputOptions.exchangeRates),
			joinListingData: outputOptions.joinListingData || false,
			outputProperty: outputOptions.outputProperty || 'data',
		},
		advancedOptions: {
			analyticsMode: advancedOptions.analyticsMode || 'auto',
			schemaVersion: advancedOptions.schemaVersion || DEFAULT_SETTINGS.schemaVersion,
			rawQueryOverride: parseRawQuery(advancedOptions.rawQueryOverride),
			returnAll: advancedOptions.returnAll !== false,
			pageSize: advancedOptions.pageSize || DEFAULT_SETTINGS.pageSize,
			maxResults: advancedOptions.maxResults || DEFAULT_SETTINGS.maxResults,
			enableChunking: advancedOptions.enableChunking !== false,
			chunkSizeDays: advancedOptions.chunkSizeDays || 30,
			maxRetries: advancedOptions.maxRetries || 3,
			retryBackoff: advancedOptions.retryBackoff || 1000,
			includeDiagnostics: advancedOptions.includeDiagnostics || false,
			strictValidation: advancedOptions.strictValidation || false,
		},
	};
}

// Validate analytics parameters
async function validateAnalyticsParameters(this: IExecuteFunctions, params: any, nodeId: string) {
	// Validate marketplace IDs
	const marketplaceValidation = securityValidator.validateMarketplaceIds(params.marketplaceIds, nodeId);
	if (!marketplaceValidation.isValid) {
		throw new NodeOperationError(this.getNode(), `Invalid marketplace IDs: ${marketplaceValidation.errors.join(', ')}`);
	}

	// Validate date range
	const dateValidation = securityValidator.validateDateRange(params.startDate, params.endDate, nodeId);
	if (!dateValidation.isValid) {
		throw new NodeOperationError(this.getNode(), `Invalid date range: ${dateValidation.errors.join(', ')}`);
	}

	// Validate schema version
	if (!SCHEMA_VERSIONS[params.advancedOptions.schemaVersion]) {
		throw new NodeOperationError(this.getNode(), `Unsupported schema version: ${params.advancedOptions.schemaVersion}`);
	}

	// Validate metrics
	if (params.selectedMetrics.length === 0) {
		throw new NodeOperationError(this.getNode(), 'At least one metric must be selected');
	}

	// Validate date range against schema limits
	const schemaVersion = SCHEMA_VERSIONS[params.advancedOptions.schemaVersion];
	const daysDiff = Math.ceil((new Date(params.endDate).getTime() - new Date(params.startDate).getTime()) / (1000 * 60 * 60 * 24));
	if (daysDiff > schemaVersion.maxDateRange) {
		if (!params.advancedOptions.enableChunking) {
			throw new NodeOperationError(
				this.getNode(),
				`Date range exceeds maximum of ${schemaVersion.maxDateRange} days. Enable chunking or reduce date range.`
			);
		}
	}
}

// Execute Data Kiosk mode
async function executeDataKioskMode(this: IExecuteFunctions, params: any): Promise<AnalyticsResponse> {
	const endpoint = buildDataKioskEndpoint(params.advancedOptions.schemaVersion, 'salesAndTraffic');
	
	const requestPayload: AnalyticsRequest = {
		marketplaceIds: params.marketplaceIds,
		startDate: params.startDate,
		endDate: params.endDate,
		granularity: params.granularity,
		metrics: params.selectedMetrics.filter((m: string) => !ANALYTICS_METRICS[m]?.computedFormula),
		dimensions: ['asin', 'date'],
		filters: buildFilters(params.filters),
		sort: params.sortingLimiting.sortBy ? {
			metric: params.sortingLimiting.sortBy,
			direction: params.sortingLimiting.sortDirection,
		} : undefined,
		limit: params.sortingLimiting.topN,
	};

	// Apply raw query override if provided
	if (params.advancedOptions.rawQueryOverride) {
		Object.assign(requestPayload, params.advancedOptions.rawQueryOverride);
	}

	// Handle chunking if needed
	if (params.advancedOptions.enableChunking) {
		return await executeWithChunking.call(this, endpoint, requestPayload, params);
	}

	// Single request
	const response = await SpApiRequest.makeRequest(this, {
		method: 'POST',
		endpoint,
		body: requestPayload,
	});

	return {
		data: response.data.results || response.data,
		nextToken: response.data.nextToken,
		metadata: response.data.metadata,
	};
}

// Execute Reports mode (fallback)
async function executeReportsMode(this: IExecuteFunctions, params: any): Promise<AnalyticsResponse> {
	const reportType = REPORTS_FALLBACK_MAPPING.salesAndTrafficByAsin.reportType;
	
	// Create report
	const createReportResponse = await SpApiRequest.makeRequest(this, {
		method: 'POST',
		endpoint: '/reports/2021-06-30/reports',
		body: {
			reportType,
			marketplaceIds: params.marketplaceIds,
			dataStartTime: params.startDate,
			dataEndTime: params.endDate,
		},
	});

	const reportId = createReportResponse.data.reportId;

	// Poll for completion
	let reportStatus;
	let attempts = 0;
	const maxAttempts = 60; // 5 minutes max

	do {
		await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
		
		const statusResponse = await SpApiRequest.makeRequest(this, {
			method: 'GET',
			endpoint: `/reports/2021-06-30/reports/${reportId}`,
		});
		
		reportStatus = statusResponse.data;
		attempts++;
		
		if (attempts >= maxAttempts) {
			throw new NodeOperationError(this.getNode(), 'Report generation timeout');
		}
	} while (reportStatus.processingStatus !== 'DONE' && reportStatus.processingStatus !== 'FATAL');

	if (reportStatus.processingStatus === 'FATAL') {
		throw new NodeOperationError(this.getNode(), 'Report generation failed');
	}

	// Get report document
	const documentResponse = await SpApiRequest.makeRequest(this, {
		method: 'GET',
		endpoint: `/reports/2021-06-30/documents/${reportStatus.reportDocumentId}`,
	});

	// Download and parse report
	const reportData = await ReportDownloader.downloadReportDocument(documentResponse.data);
	const parsedResult = parseReportCSV(reportData.toString(), params);

	// Handle both array and object return types
	const parsedData = Array.isArray(parsedResult) ? parsedResult : parsedResult.data;
	const csvDiagnostics = Array.isArray(parsedResult) ? null : parsedResult.diagnostics;

	return {
		data: parsedData,
		metadata: {
			reportId,
			reportType,
			generatedAt: reportStatus.createdTime,
			...(csvDiagnostics && { csvParsing: csvDiagnostics }),
		},
	};
}

// Helper functions
function calculateDateRange(preset: string, customDays: number, _timezone: string): { startDate: string; endDate: string } {
	const now = new Date();
	let startDate: Date, endDate: Date;

	switch (preset) {
		case 'today':
			startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			endDate = new Date(startDate);
			endDate.setDate(endDate.getDate() + 1);
			break;
		case 'yesterday':
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			startDate = new Date(endDate);
			startDate.setDate(startDate.getDate() - 1);
			break;
		case 'last7days':
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			startDate = new Date(endDate);
			startDate.setDate(startDate.getDate() - 7);
			break;
		case 'last30days':
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			startDate = new Date(endDate);
			startDate.setDate(startDate.getDate() - 30);
			break;
		case 'last90days':
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			startDate = new Date(endDate);
			startDate.setDate(startDate.getDate() - 90);
			break;
		case 'mtd':
			startDate = new Date(now.getFullYear(), now.getMonth(), 1);
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
			break;
		case 'qtd':
			const quarter = Math.floor(now.getMonth() / 3);
			startDate = new Date(now.getFullYear(), quarter * 3, 1);
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
			break;
		case 'ytd':
			startDate = new Date(now.getFullYear(), 0, 1);
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
			break;
		case 'custom':
			endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			startDate = new Date(endDate);
			startDate.setDate(startDate.getDate() - customDays);
			break;
		default:
			throw new Error(`Unknown date preset: ${preset}`);
	}

	return {
		startDate: startDate.toISOString(),
		endDate: endDate.toISOString(),
	};
}

function extractSelectedMetrics(metricsSelection: any): string[] {
	if (!metricsSelection || typeof metricsSelection !== 'object') return [];

	const metrics: string[] = [];

	Object.values(metricsSelection).forEach((category: any) => {
		if (!category) return;

		if (Array.isArray(category)) {
			for (const entry of category) {
				if (entry?.metrics && Array.isArray(entry.metrics)) {
					metrics.push(...entry.metrics);
				} else if (typeof entry === 'string') {
					metrics.push(entry);
				}
			}
		} else if (category?.metrics && Array.isArray(category.metrics)) {
			metrics.push(...category.metrics);
		}
	});

	return metrics;
}

function parseExchangeRates(ratesJson: string): Record<string, number> {
	if (!ratesJson) return {};
	
	try {
		return JSON.parse(ratesJson);
	} catch {
		return {};
	}
}

function parseRawQuery(rawQuery: string): any {
	if (!rawQuery) return null;
	
	try {
		return JSON.parse(rawQuery);
	} catch {
		return null;
	}
}

function buildFilters(filters: any): Record<string, any> {
	const apiFilters: Record<string, any> = {};
	
	if (filters.asins?.length > 0) {
		apiFilters.asin = filters.asins;
	}
	
	if (filters.parentAsin) {
		apiFilters.parentAsin = filters.parentAsin;
		if (filters.includeChildAsins) {
			apiFilters.includeChildAsins = true;
		}
	}
	
	if (filters.brands?.length > 0) {
		apiFilters.brand = filters.brands;
	}
	
	if (filters.fulfillmentChannel?.length > 0) {
		apiFilters.fulfillmentChannel = filters.fulfillmentChannel;
	}
	
	if (filters.minSessions > 0) {
		apiFilters.minSessions = filters.minSessions;
	}
	
	if (filters.minSales > 0) {
		apiFilters.minSales = filters.minSales;
	}
	
	return apiFilters;
}

async function executeWithChunking(this: IExecuteFunctions, endpoint: string, basePayload: AnalyticsRequest, params: any): Promise<AnalyticsResponse> {
	const startDate = new Date(basePayload.startDate);
	const endDate = new Date(basePayload.endDate);
	const chunkSizeDays = params.advancedOptions.chunkSizeDays;
	
	const allData: AnalyticsDataPoint[] = [];
	let currentStart = new Date(startDate);
	
	while (currentStart < endDate) {
		const currentEnd = new Date(currentStart);
		currentEnd.setDate(currentEnd.getDate() + chunkSizeDays);
		
		if (currentEnd > endDate) {
			currentEnd.setTime(endDate.getTime());
		}
		
		const chunkPayload = {
			...basePayload,
			startDate: currentStart.toISOString(),
			endDate: currentEnd.toISOString(),
		};
		
		const response = await SpApiRequest.makeRequest(this, {
			method: 'POST',
			endpoint,
			body: chunkPayload,
		});
		
		if (response.data.results) {
			allData.push(...response.data.results);
		}
		
		currentStart = new Date(currentEnd);
	}
	
	return {
		data: allData,
		metadata: {
			chunked: true,
			totalChunks: Math.ceil((endDate.getTime() - startDate.getTime()) / (chunkSizeDays * 24 * 60 * 60 * 1000)),
		},
	};
}

function normalizeAnalyticsData(data: AnalyticsDataPoint[], params: any): NormalizedRow[] {
	return data.map(item => {
		const row: NormalizedRow = {
			asin: item.asin,
			marketplaceId: item.marketplaceId,
			date: item.date,
			granularity: params.granularity,
		};
		
		// Add all metrics
		Object.entries(item.metrics).forEach(([metric, value]) => {
			row[metric] = value;
		});
		
		return row;
	});
}

function addComputedMetrics(data: NormalizedRow[], selectedMetrics: string[]): NormalizedRow[] {
	const computedMetrics = selectedMetrics.filter(metric => ANALYTICS_METRICS[metric]?.computedFormula);
	
	if (computedMetrics.length === 0) return data;
	
	return data.map(row => {
		const newRow = { ...row };
		
		computedMetrics.forEach(metric => {
			const formula = ANALYTICS_METRICS[metric].computedFormula;
			if (formula) {
				try {
					// Simple formula evaluation (extend as needed)
					if (formula === 'orderedProductSales / unitsOrdered') {
						const sales = row.orderedProductSales || 0;
						const units = row.unitsOrdered || 0;
						newRow[metric] = units > 0 ? sales / units : 0;
					} else if (formula === 'unitsOrdered / sessions') {
						const units = row.unitsOrdered || 0;
						const sessions = row.sessions || 0;
						newRow[metric] = sessions > 0 ? units / sessions : 0;
					} else if (formula === 'orderedProductSales / sessions') {
						const sales = row.orderedProductSales || 0;
						const sessions = row.sessions || 0;
						newRow[metric] = sessions > 0 ? sales / sessions : 0;
					}
				} catch {
					newRow[metric] = null;
				}
			}
		});
		
		return newRow;
	});
}

function applySortingAndLimiting(data: NormalizedRow[], sortingLimiting: any): NormalizedRow[] {
	let sortedData = [...data];
	
	// Primary sort
	if (sortingLimiting.sortBy) {
		sortedData.sort((a, b) => {
			const aVal = a[sortingLimiting.sortBy] || 0;
			const bVal = b[sortingLimiting.sortBy] || 0;
			
			if (sortingLimiting.sortDirection === 'asc') {
				return aVal - bVal;
			} else {
				return bVal - aVal;
			}
		});
	}
	
	// Secondary sort
	if (sortingLimiting.secondarySort) {
		sortedData.sort((a, b) => {
			const primaryA = a[sortingLimiting.sortBy] || 0;
			const primaryB = b[sortingLimiting.sortBy] || 0;
			
			if (primaryA === primaryB) {
				const secondaryA = a[sortingLimiting.secondarySort] || 0;
				const secondaryB = b[sortingLimiting.secondarySort] || 0;
				return secondaryB - secondaryA; // Always desc for secondary
			}
			
			return 0;
		});
	}
	
	// Apply limit
	if (sortingLimiting.topN > 0) {
		sortedData = sortedData.slice(0, sortingLimiting.topN);
	}
	
	return sortedData;
}

async function resolveSKUsToASINs(this: IExecuteFunctions, skus: string[], _marketplaceIds: string[]): Promise<string[]> {
	// This would use the Listings API to resolve SKUs to ASINs
	// For now, return the SKUs as-is (implement full resolution as needed)
	return skus;
}

async function joinListingData(this: IExecuteFunctions, data: NormalizedRow[], _marketplaceIds: string[]): Promise<NormalizedRow[]> {
	// This would join with Listings API data to add title, brand, category
	// For now, return data as-is (implement full join as needed)
	return data;
}

function normalizeCurrency(data: NormalizedRow[], _baseCurrency: string, _exchangeRates: Record<string, number>): NormalizedRow[] {
	// This would normalize currency values using exchange rates
	// For now, return data as-is (implement full normalization as needed)
	return data;
}

function parseReportCSV(csvData: string, params: any): AnalyticsDataPoint[] | { data: AnalyticsDataPoint[], diagnostics: any } {
	// Try JSON first (Business Reports often return JSON now)
	const trimmed = csvData.replace(/^\uFEFF/, '').trim();
	const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[') || /salesAndTrafficByAsin|reportSpecification/.test(trimmed.slice(0, 2048));

	const buildJsonDiagnostics = (json: any, rows: AnalyticsDataPoint[]) => ({
		jsonParsing: {
			rawDataLength: csvData.length,
			hasSalesAndTrafficByAsin: Array.isArray(json?.salesAndTrafficByAsin),
			asinGranularity: json?.reportSpecification?.reportOptions?.asinGranularity,
			dateGranularity: json?.reportSpecification?.reportOptions?.dateGranularity,
			dateRange: { start: json?.reportSpecification?.dataStartTime, end: json?.reportSpecification?.dataEndTime },
			marketplaceIds: json?.reportSpecification?.marketplaceIds,
			asinCount: Array.isArray(json?.salesAndTrafficByAsin) ? json.salesAndTrafficByAsin.length : 0,
			totalRows: rows.length,
			sampleAsin: Array.isArray(json?.salesAndTrafficByAsin) && json.salesAndTrafficByAsin[0] ? (json.salesAndTrafficByAsin[0].asin || json.salesAndTrafficByAsin[0].parentAsin || json.salesAndTrafficByAsin[0].childAsin) : null,
		},
	});

	const mapNumber = (v: any): number | null => {
		if (v === null || v === undefined) return null;
		if (typeof v === 'number') return v;
		const n = parseFloat(String(v));
		return Number.isFinite(n) ? n : null;
	};

	if (looksLikeJson) {
		try {
			const json = JSON.parse(trimmed);
			const items: any[] = Array.isArray(json?.salesAndTrafficByAsin) ? json.salesAndTrafficByAsin : [];
			const rows: AnalyticsDataPoint[] = items
				.map((item: any) => {
					const asinId = item?.asin || item?.childAsin || item?.parentAsin || '';
					const traffic = item?.trafficByAsin || {};
					const sales = item?.salesByAsin || {};
					const metrics: Record<string, number | null> = {};

					metrics.sessions = mapNumber(traffic.sessions);
					metrics.pageViews = mapNumber(traffic.pageViews);
					metrics.unitSessionPercentage = mapNumber(traffic.unitSessionPercentage);
					metrics.buyBoxPercentage = mapNumber(traffic.buyBoxPercentage);

					metrics.unitsOrdered = mapNumber(sales.unitsOrdered);
					metrics.unitsOrderedB2B = mapNumber(sales.unitsOrderedB2B);
					metrics.orderedProductSales = mapNumber(sales?.orderedProductSales?.amount ?? sales.orderedProductSales);
					metrics.orderedProductSalesB2B = mapNumber(sales?.orderedProductSalesB2B?.amount ?? sales.orderedProductSalesB2B);

					return {
						asin: asinId,
						marketplaceId: Array.isArray(params?.marketplaceIds) && params.marketplaceIds.length ? params.marketplaceIds[0] : '',
						date: params?.endDate || new Date().toISOString(),
						metrics,
					} as AnalyticsDataPoint;
				})
				.filter((r) => !!r.asin);

			if (params?.advancedOptions?.includeDiagnostics) {
				return { data: rows, diagnostics: buildJsonDiagnostics(json, rows) };
			}
			return rows;
		} catch {
			// fall through to CSV parsing
		}
	}

	// CSV fallback
	const text = csvData.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	const delimiter = text.includes('\t') ? '\t' : ',';
	const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

	function split(line: string): string[] {
		if (delimiter === '\t') return line.split('\t');
		const out: string[] = [];
		let cur = '';
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (ch === '"') {
				if (inQuotes && line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = !inQuotes;
				}
			} else if (ch === delimiter && !inQuotes) {
				out.push(cur);
				cur = '';
			} else {
				cur += ch;
			}
		}
		out.push(cur);
		return out.map((s) => s.trim());
	}

	let headerIdx = lines.findIndex((l) => /asin/i.test(l) && (/(^|[^a-z])sessions([^a-z]|$)/i.test(l) || /page[\s-]*views/i.test(l)));
	if (headerIdx === -1 && lines.length > 0) headerIdx = 0;
	if (headerIdx === -1) return [];

	const rawHeaders = split(lines[headerIdx]);
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
	const headers = rawHeaders.map((h) => norm(h));

	const idx = (...cands: string[]) => {
		for (const c of cands) {
			const i = headers.indexOf(c);
			if (i !== -1) return i;
		}
		return -1;
	};

	const asinIdx = idx('asin', 'childasin');
	const dateIdx = idx('date');

	const col = {
		sessions: idx('sessions'),
		pageViews: idx('pageviews'),
		pageViewsPerSession: idx('pageviewspersession', 'pageviewspervisit'),
		sessionsPercent: idx('sessionspercent', 'sessionpercentage'),
		pageViewsPercent: idx('pageviewspercent', 'pageviewspercentage'),
		unitsOrdered: idx('unitsordered'),
		unitsOrderedB2B: idx('unitsorderedb2b'),
		orderedProductSales: idx('orderedproductsales'),
		orderedProductSalesB2B: idx('orderedproductsalesb2b'),
		unitSessionPercentage: idx('unitsessionpercentage'),
		unitSessionPercentageB2B: idx('unitsessionpercentageb2b'),
		buyBoxPercentage: idx('buyboxpercentage', 'featuredbuyboxpercentage', 'buyboxwins'),
		sku: idx('sku'),
		parentAsin: idx('parentasin'),
	};

	const toNum = (v?: string) => {
		if (!v) return null;
		let s = v.replace(/[\s]/g, '').replace(/[^\d.,-]/g, '');
		if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) s = s.replace(/,/g, '');
		else if (delimiter === ',' && s.indexOf(',') !== -1 && s.indexOf('.') === -1) s = s.replace(/,/g, '.');
		else s = s.replace(/,/g, '');
		const n = parseFloat(s);
		return Number.isFinite(n) ? n : null;
	};
	const toPercent = (v?: string) => {
		if (!v) return null;
		const hasPct = v.includes('%');
		const n = toNum(v);
		if (n === null) return null;
		return hasPct ? n : n <= 1 ? n * 100 : n;
	};
	const toCurrency = (v?: string) => toNum(v);

	const out: AnalyticsDataPoint[] = [];
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const rowStr = lines[i];
		if (!rowStr) continue;
		if (/^total\b/i.test(rowStr) || /^grand\s*total\b/i.test(rowStr)) continue;

		const vals = split(rowStr);
		const get = (i: number) => (i >= 0 && i < vals.length ? vals[i] : '');

		const asin = asinIdx !== -1 ? get(asinIdx) : '';
		if (!asin || /^total$/i.test(asin)) continue;

		const dateRaw = dateIdx !== -1 ? get(dateIdx) : '';
		const dateIso = dateRaw ? new Date(dateRaw).toISOString() : params?.endDate || new Date().toISOString();

		const metrics: Record<string, number | null> = {};
		if (col.sessions !== -1) metrics.sessions = toNum(get(col.sessions));
		if (col.pageViews !== -1) metrics.pageViews = toNum(get(col.pageViews));
		if (col.pageViewsPerSession !== -1) metrics.pageViewsPerSession = toNum(get(col.pageViewsPerSession));
		if (col.sessionsPercent !== -1) metrics.sessionsPercent = toPercent(get(col.sessionsPercent));
		if (col.pageViewsPercent !== -1) metrics.pageViewsPercent = toPercent(get(col.pageViewsPercent));
		if (col.unitsOrdered !== -1) metrics.unitsOrdered = toNum(get(col.unitsOrdered));
		if (col.unitsOrderedB2B !== -1) metrics.unitsOrderedB2B = toNum(get(col.unitsOrderedB2B));
		if (col.orderedProductSales !== -1) metrics.orderedProductSales = toCurrency(get(col.orderedProductSales));
		if (col.orderedProductSalesB2B !== -1) metrics.orderedProductSalesB2B = toCurrency(get(col.orderedProductSalesB2B));
		if (col.unitSessionPercentage !== -1) metrics.unitSessionPercentage = toPercent(get(col.unitSessionPercentage));
		if (col.unitSessionPercentageB2B !== -1) metrics.unitSessionPercentageB2B = toPercent(get(col.unitSessionPercentageB2B));
		if (col.buyBoxPercentage !== -1) metrics.buyBoxPercentage = toPercent(get(col.buyBoxPercentage));

		out.push({
			asin,
			marketplaceId: Array.isArray(params?.marketplaceIds) && params.marketplaceIds.length ? params.marketplaceIds[0] : '',
			date: dateIso,
			metrics,
			sku: col.sku !== -1 ? get(col.sku) : undefined,
			parentAsin: col.parentAsin !== -1 ? get(col.parentAsin) : undefined,
		});
	}

	if (params?.advancedOptions?.includeDiagnostics) {
		const diagnostics = {
			csvParsing: {
				rawDataLength: csvData.length,
				processedLines: lines.length,
				delimiter: delimiter === '\t' ? 'TAB' : 'COMMA',
				headerRowIndex: headerIdx,
				rawHeaders,
				normalizedHeaders: headers,
				columnMapping: col,
				totalRows: out.length,
				skippedRows: lines.length - headerIdx - 1 - out.length,
				sampleRows: lines.slice(headerIdx, Math.min(headerIdx + 3, lines.length)),
			},
		};
		return { data: out, diagnostics };
	}

	return out;
}

async function generateOutput(this: IExecuteFunctions, data: NormalizedRow[], params: any, metadata: any): Promise<INodeExecutionData[]> {
	const outputFormat = params.outputOptions.format;
	
	if (outputFormat === 'csv') {
		// Generate CSV binary
		const csv = generateCSV(data, params.outputOptions);
		const filename = params.outputOptions.csvFilename
			.replace('{marketplace}', params.marketplaceIds.join('-'))
			.replace('{start}', params.startDate.split('T')[0])
			.replace('{end}', params.endDate.split('T')[0])
			.replace('{timestamp}', new Date().toISOString().split('T')[0]);
		
		return [{
			json: {
				success: true,
				mode: metadata.usedMode,
				totalResults: metadata.totalResults,
				executionTime: metadata.executionTime,
				filename,
			},
			binary: {
				data: {
					data: Buffer.from(csv).toString('base64'),
					mimeType: 'text/csv',
					fileName: filename,
				},
			},
		}];
	} else if (outputFormat === 'json') {
		// Raw JSON format
		return [{
			json: {
				success: true,
				mode: metadata.usedMode,
				data,
				metadata: {
					totalResults: metadata.totalResults,
					executionTime: metadata.executionTime,
					...metadata.metadata,
				},
			},
		}];
	} else {
		// Flattened JSON (default)
		const result: any = {
			success: true,
			mode: metadata.usedMode,
			totalResults: metadata.totalResults,
			executionTime: metadata.executionTime,
		};
		
		result[params.outputOptions.outputProperty] = data;
		
		if (params.advancedOptions.includeDiagnostics) {
			result.diagnostics = metadata;
		}
		
		return [{ json: result }];
	}
}

function generateCSV(data: NormalizedRow[], options: any): string {
	if (data.length === 0) return '';
	
	const delimiter = options.csvDelimiter;
	const decimalSeparator = options.csvDecimalSeparator;
	const includeHeaders = options.includeHeaders;
	
	const headers = Object.keys(data[0]);
	let csv = '';
	
	if (includeHeaders) {
		csv += headers.join(delimiter) + '\n';
	}
	
	data.forEach(row => {
		const values = headers.map(header => {
			let value = row[header];
			
			if (typeof value === 'number') {
				value = value.toString().replace('.', decimalSeparator);
			} else if (value === null || value === undefined) {
				value = '';
			} else {
				value = String(value);
			}
			
			// Escape quotes and wrap in quotes if contains delimiter
			if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
				value = '"' + value.replace(/"/g, '""') + '"';
			}
			
			return value;
		});
		
		csv += values.join(delimiter) + '\n';
	});
	
	return csv;
}
