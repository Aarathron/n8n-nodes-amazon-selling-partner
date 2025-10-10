import { auditLogger } from './AuditLogger';

export interface ValidationRule {
	field: string;
	required?: boolean;
	type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'date';
	minLength?: number;
	maxLength?: number;
	pattern?: RegExp;
	allowedValues?: any[];
	sanitize?: boolean;
	customValidator?: (value: any) => boolean | string;
}

export interface ValidationResult {
	isValid: boolean;
	errors: string[];
	sanitizedData?: any;
}

export class SecurityValidator {
	private readonly suspiciousPatterns = [
		// SQL Injection patterns
		/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/i,
		// XSS patterns
		/<script[^>]*>.*?<\/script>/gi,
		/javascript:/gi,
		/on\w+\s*=/gi,
		// Command injection patterns
		/[;&|`$(){}[\]]/,
		// Directory traversal
		/\.\.\//,
		/\.\.\\/,
		// Null bytes
		// eslint-disable-next-line no-control-regex
		/\x00/,
	];

	private readonly marketplaceIdPattern = /^[A-Z0-9]{10,15}$/;
	private readonly datePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;

	/**
	 * Validate and sanitize input data
	 */
	validateInput(data: any, rules: ValidationRule[], nodeId: string): ValidationResult {
		const result: ValidationResult = {
			isValid: true,
			errors: [],
			sanitizedData: {},
		};

		try {
			for (const rule of rules) {
				const value = this.getNestedValue(data, rule.field);
				const fieldResult = this.validateField(value, rule, nodeId);

				if (!fieldResult.isValid) {
					result.isValid = false;
					result.errors.push(...fieldResult.errors);
				} else if (fieldResult.sanitizedValue !== undefined) {
					this.setNestedValue(result.sanitizedData, rule.field, fieldResult.sanitizedValue);
				}
			}

			// Log validation attempt
			auditLogger.logEvent({
				nodeId,
				action: 'input_validation',
				resource: 'data',
				details: {
					fieldsValidated: rules.map(r => r.field),
					isValid: result.isValid,
					errorCount: result.errors.length,
				},
				severity: result.isValid ? 'low' : 'medium',
				source: 'system',
				outcome: result.isValid ? 'success' : 'failure',
			});

		} catch (error) {
			result.isValid = false;
			result.errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
			
			auditLogger.logError(nodeId, error instanceof Error ? error : new Error('Validation failed'), {
				context: 'input_validation',
				rules: rules.map(r => r.field),
			});
		}

		return result;
	}

	/**
	 * Validate marketplace IDs
	 */
	validateMarketplaceIds(marketplaceIds: string[], nodeId: string): ValidationResult {
		const rules: ValidationRule[] = [
			{
				field: 'marketplaceIds',
				required: true,
				type: 'array',
				customValidator: (value: string[]) => {
					if (!Array.isArray(value) || value.length === 0) {
						return 'At least one marketplace ID is required';
					}
					for (const id of value) {
						if (!this.marketplaceIdPattern.test(id)) {
							return `Invalid marketplace ID format: ${id}`;
						}
					}
					return true;
				},
			},
		];

		return this.validateInput({ marketplaceIds }, rules, nodeId);
	}

	/**
	 * Validate date range
	 */
	validateDateRange(createdAfter: string, createdBefore: string, nodeId: string): ValidationResult {
		const rules: ValidationRule[] = [
			{
				field: 'createdAfter',
				required: true,
				pattern: this.datePattern,
			},
			{
				field: 'createdBefore',
				required: true,
				pattern: this.datePattern,
			},
		];

		const result = this.validateInput({ createdAfter, createdBefore }, rules, nodeId);

		if (result.isValid) {
			// Additional date range validation
			const afterDate = new Date(createdAfter);
			const beforeDate = new Date(createdBefore);
			const daysDiff = Math.ceil((beforeDate.getTime() - afterDate.getTime()) / (1000 * 60 * 60 * 24));

			if (afterDate >= beforeDate) {
				result.isValid = false;
				result.errors.push('Created After date must be before Created Before date');
			}

			if (daysDiff > 30) {
				result.isValid = false;
				result.errors.push('Date range cannot exceed 30 days');
			}

			// Check for suspiciously old dates (more than 2 years)
			const twoYearsAgo = new Date();
			twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
			
			if (afterDate < twoYearsAgo) {
				auditLogger.logSuspiciousActivity(nodeId, 'old_date_range_request', {
					createdAfter,
					createdBefore,
					daysDiff,
					yearsAgo: (Date.now() - afterDate.getTime()) / (1000 * 60 * 60 * 24 * 365),
				});
			}
		}

		return result;
	}

	/**
	 * Sanitize string input
	 */
	sanitizeString(input: string): string {
		if (typeof input !== 'string') {
			return String(input);
		}

		// Remove null bytes
		// eslint-disable-next-line no-control-regex
		let sanitized = input.replace(/\x00/g, '');

		// Encode HTML entities
		sanitized = sanitized
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#x27;');

		// Remove control characters except tabs, newlines, and carriage returns
		// eslint-disable-next-line no-control-regex
		sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

		return sanitized.trim();
	}

	/**
	 * Check for suspicious patterns in input
	 */
	detectSuspiciousPatterns(input: string, nodeId: string): boolean {
		if (typeof input !== 'string') {
			return false;
		}

		for (const pattern of this.suspiciousPatterns) {
			if (pattern.test(input)) {
				auditLogger.logSuspiciousActivity(nodeId, 'malicious_input_detected', {
					input: input.substring(0, 100), // Log first 100 chars only
					pattern: pattern.toString(),
					attackVector: 'input_injection',
				});
				return true;
			}
		}

		return false;
	}

	/**
	 * Validate credentials format
	 */
	validateCredentials(credentials: any, nodeId: string, useAwsSigning: boolean = false): ValidationResult {
		const rules: ValidationRule[] = [
			// LWA credentials (always required)
			{
				field: 'lwaClientId',
				required: true,
				type: 'string',
				minLength: 10,
				maxLength: 100,
				sanitize: true,
			},
			{
				field: 'lwaClientSecret',
				required: true,
				type: 'string',
				minLength: 10,
				maxLength: 200,
				sanitize: true,
			},
			{
				field: 'lwaRefreshToken',
				required: true,
				type: 'string',
				minLength: 10,
				maxLength: 500,
				sanitize: true,
			},
			// Environment and region (always required)
			{
				field: 'awsRegion',
				required: true,
				type: 'string',
				allowedValues: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2'],
			},
			{
				field: 'environment',
				required: true,
				type: 'string',
				allowedValues: ['sandbox', 'production'],
			},
		];

		// Add AWS credential validation only if AWS signing is enabled
		if (useAwsSigning) {
			const advancedOptions = credentials.advancedOptions || {};
			const awsAccessKeyId = credentials.awsAccessKeyId || advancedOptions.awsAccessKeyId;
			const awsSecretAccessKey = credentials.awsSecretAccessKey || advancedOptions.awsSecretAccessKey;

			// Validate AWS Access Key ID
			if (!awsAccessKeyId) {
				return {
					isValid: false,
					errors: ['AWS Access Key ID is required when AWS signing is enabled'],
				};
			}

			// Validate AWS Secret Access Key
			if (!awsSecretAccessKey) {
				return {
					isValid: false,
					errors: ['AWS Secret Access Key is required when AWS signing is enabled'],
				};
			}

			// Validate AWS Access Key ID format
			if (typeof awsAccessKeyId === 'string') {
				if (awsAccessKeyId.length < 16 || awsAccessKeyId.length > 30) {
					return {
						isValid: false,
						errors: ['AWS Access Key ID must be between 16 and 30 characters'],
					};
				}
				if (!/^[A-Z0-9]+$/.test(awsAccessKeyId)) {
					return {
						isValid: false,
						errors: ['AWS Access Key ID contains invalid characters'],
					};
				}
			}

			// Validate AWS Secret Access Key format
			if (typeof awsSecretAccessKey === 'string') {
				if (awsSecretAccessKey.length < 20 || awsSecretAccessKey.length > 100) {
					return {
						isValid: false,
						errors: ['AWS Secret Access Key must be between 20 and 100 characters'],
					};
				}
			}
		}

		return this.validateInput(credentials, rules, nodeId);
	}

	/**
	 * Validate API endpoint parameters
	 */
	validateApiParameters(params: Record<string, any>, nodeId: string): ValidationResult {
		const result: ValidationResult = {
			isValid: true,
			errors: [],
			sanitizedData: {},
		};

		for (const [key, value] of Object.entries(params)) {
			// Check for suspicious patterns
			if (typeof value === 'string' && this.detectSuspiciousPatterns(value, nodeId)) {
				result.isValid = false;
				result.errors.push(`Suspicious pattern detected in parameter: ${key}`);
				continue;
			}

			// Sanitize string values
			if (typeof value === 'string') {
				result.sanitizedData[key] = this.sanitizeString(value);
			} else {
				result.sanitizedData[key] = value;
			}
		}

		return result;
	}

	/**
	 * Check rate limiting compliance
	 */
	checkRateLimitCompliance(endpoint: string, nodeId: string): boolean {
		// This would integrate with the RateLimiter to check if request is allowed
		// For now, we'll just log the check
		auditLogger.logEvent({
			nodeId,
			action: 'rate_limit_check',
			resource: endpoint,
			details: { endpoint },
			severity: 'low',
			source: 'system',
			outcome: 'success',
		});

		return true;
	}

	/**
	 * Validate environment isolation
	 */
	validateEnvironmentIsolation(credentials: any, nodeId: string): ValidationResult {
		const result: ValidationResult = {
			isValid: true,
			errors: [],
		};

		// Check for mixed environment credentials
		if (credentials.environment === 'production') {
			// Production credentials should not contain 'sandbox' or 'test' in any field
			const credentialString = JSON.stringify(credentials).toLowerCase();
			if (credentialString.includes('sandbox') || credentialString.includes('test')) {
				result.isValid = false;
				result.errors.push('Production environment contains test/sandbox references');
				
				auditLogger.logSecurityEvent({
					nodeId,
					action: 'environment_isolation_violation',
					resource: 'credentials',
					details: {
						environment: credentials.environment,
						violation: 'mixed_environment_credentials',
					},
					severity: 'high',
					source: 'system',
					outcome: 'failure',
					threatLevel: 'medium',
				});
			}
		}

		return result;
	}

	private validateField(value: any, rule: ValidationRule, nodeId: string): { isValid: boolean; errors: string[]; sanitizedValue?: any } {
		const result: { isValid: boolean; errors: string[]; sanitizedValue?: any } = { 
			isValid: true, 
			errors: [], 
			sanitizedValue: value 
		};

		// Check if field is required
		if (rule.required && (value === undefined || value === null || value === '')) {
			result.isValid = false;
			result.errors.push(`${rule.field} is required`);
			return result;
		}

		// Skip validation if field is not required and empty
		if (!rule.required && (value === undefined || value === null || value === '')) {
			return result;
		}

		// Type validation
		if (rule.type) {
			const typeValid = this.validateType(value, rule.type);
			if (!typeValid) {
				result.isValid = false;
				result.errors.push(`${rule.field} must be of type ${rule.type}`);
				return result;
			}
		}

		// String-specific validations
		if (typeof value === 'string') {
			// Check for suspicious patterns
			if (this.detectSuspiciousPatterns(value, nodeId)) {
				result.isValid = false;
				result.errors.push(`${rule.field} contains suspicious patterns`);
				return result;
			}

			// Length validation
			if (rule.minLength && value.length < rule.minLength) {
				result.isValid = false;
				result.errors.push(`${rule.field} must be at least ${rule.minLength} characters long`);
			}

			if (rule.maxLength && value.length > rule.maxLength) {
				result.isValid = false;
				result.errors.push(`${rule.field} must not exceed ${rule.maxLength} characters`);
			}

			// Pattern validation
			if (rule.pattern && !rule.pattern.test(value)) {
				result.isValid = false;
				result.errors.push(`${rule.field} does not match required pattern`);
			}

			// Sanitization
			if (rule.sanitize) {
				result.sanitizedValue = this.sanitizeString(value);
			}
		}

		// Allowed values validation
		if (rule.allowedValues && !rule.allowedValues.includes(value)) {
			result.isValid = false;
			result.errors.push(`${rule.field} must be one of: ${rule.allowedValues.join(', ')}`);
		}

		// Custom validation
		if (rule.customValidator) {
			const customResult = rule.customValidator(value);
			if (customResult !== true) {
				result.isValid = false;
				result.errors.push(typeof customResult === 'string' ? customResult : `${rule.field} failed custom validation`);
			}
		}

		return result;
	}

	private validateType(value: any, type: string): boolean {
		switch (type) {
			case 'string':
				return typeof value === 'string';
			case 'number':
				return typeof value === 'number' && !isNaN(value);
			case 'boolean':
				return typeof value === 'boolean';
			case 'array':
				return Array.isArray(value);
			case 'object':
				return typeof value === 'object' && value !== null && !Array.isArray(value);
			case 'date':
				return typeof value === 'string' && !isNaN(Date.parse(value));
			default:
				return true;
		}
	}

	private getNestedValue(obj: any, path: string): any {
		return path.split('.').reduce((current, key) => current && current[key], obj);
	}

	private setNestedValue(obj: any, path: string, value: any): void {
		const keys = path.split('.');
		const lastKey = keys.pop()!;
		const target = keys.reduce((current, key) => {
			if (!current[key]) current[key] = {};
			return current[key];
		}, obj);
		target[lastKey] = value;
	}
}

// Singleton instance
export const securityValidator = new SecurityValidator(); 