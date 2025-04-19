const { Pool } = require('pg');
const { encrypt, decrypt } = require('./services/encryption/aesService');
const logger = require('../utils/logger');
const FHIR = require('fhir').Fhir;

// HIPAA-compliant connection configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'uhrh-database.cjowim6kkmwt.eu-north-1.rds.amazonaws.com',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'admin2304',
  password: process.env.DB_PASSWORD || 'Krithik_Farthin_Mahesh',
  database: process.env.DB_NAME || 'uhrh-database',
  ssl: {
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CA, // PEM-encoded CA cert
    cert: process.env.DB_SSL_CERT,
    key: process.env.DB_SSL_KEY
  },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20 // Connection pool size
});

// FHIR database utilities
const fhir = new FHIR();

/**
 * PHI-aware query executor with audit logging
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @param {Object} user - User context for audit
 * @returns {Promise<QueryResult>}
 */
async function query(text, params, user = null) {
  const start = Date.now();
  const client = await pool.connect();
  
  try {
    // Encrypt PHI fields before insertion
    const processedParams = params.map(p => 
      typeof p === 'string' && isPHI(p) ? encrypt(p) : p
    );

    const res = await client.query(text, processedParams);
    const duration = Date.now() - start;

    // HIPAA audit logging
    if (user) {
      await logDatabaseAccess({
        user: user.id,
        query: maskPHI(text),
        duration,
        timestamp: new Date()
      });
    }

    // Decrypt PHI fields in results
    const decryptedRows = res.rows.map(row => 
      Object.fromEntries(
        Object.entries(row).map(([key, val]) => 
          [key, isPHIColumn(key) ? decrypt(val) : val]
      )
    ));

    return { ...res, rows: decryptedRows };
  } catch (err) {
    logger.error(`Database error: ${err.message}`, {
      query: maskPHI(text),
      params: maskPHI(params),
      stack: err.stack
    });
    throw new DatabaseError(err.message);
  } finally {
    client.release();
  }
}

// FHIR-specific helpers
async function storeFHIRResource(resource) {
  const validation = fhir.validate(resource);
  if (!validation.valid) {
    throw new Error(`Invalid FHIR resource: ${validation.messages.join(', ')}`);
  }

  const { resourceType, id } = resource;
  const queryText = `
    INSERT INTO fhir_resources (resource_type, resource_id, data)
    VALUES ($1, $2, $3)
    ON CONFLICT (resource_type, resource_id) 
    DO UPDATE SET data = $3
    RETURNING *`;
  
  return await query(queryText, [resourceType, id, JSON.stringify(resource)]);
}

// Security utilities
function isPHI(value) {
  const phiPatterns = [
    /\d{3}-\d{2}-\d{4}/, // SSN
    /\(\d{3}\) \d{3}-\d{4}/, // Phone
    /\b[A-Za-z0-9]{10,20}\b/ // MRN
  ];
  return phiPatterns.some(pattern => pattern.test(value));
}

function isPHIColumn(columnName) {
  const phiColumns = new Set([
    'ssn', 'mrn', 'phone', 'address', 
    'birth_date', 'email', 'insurance_id'
  ]);
  return phiColumns.has(columnName.toLowerCase());
}

function maskPHI(input) {
  if (typeof input === 'string') {
    return input.replace(/\d{3}-\d{2}-\d{4}/g, '***-**-****');
  }
  return JSON.stringify(input, (key, value) => 
    isPHIColumn(key) ? '**REDACTED**' : value
  );
}

// Audit logging
async function logDatabaseAccess(entry) {
  const auditQuery = `
    INSERT INTO audit_logs (
      user_id, action, entity_type, 
      entity_id, timestamp, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6)`;
  
  await pool.query(auditQuery, [
    entry.user,
    'database_query',
    null,
    null,
    entry.timestamp,
    {
      query: entry.query,
      duration_ms: entry.duration
    }
  ]);
}

class DatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseError';
    this.isOperational = true;
  }
}

module.exports = {
  query,
  storeFHIRResource,
  pool, // For transactions
  DatabaseError
};