// AuditLog.js - HIPAA-Compliant Audit Trail with Blockchain Anchoring
const { Sequelize, DataTypes } = require('sequelize');
const crypto = require('crypto');
const { Blockchain } = require('./blockchain');
const WebSocket = require('ws');

class AuditLog {
  constructor() {
    this.sequelize = new Sequelize(process.env.DB_URI, {
      logging: false,
      dialectOptions: { ssl: { require: true } }
    });

    this.LogEntry = this.sequelize.define('LogEntry', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      timestamp: { type: DataTypes.DATE(6), defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(6)') },
      userId: { type: DataTypes.STRING, allowNull: false },
      action: { type: DataTypes.ENUM('READ', 'WRITE', 'DELETE', 'PREDICT', 'LOGIN', 'EXPORT'), allowNull: false },
      resourceType: { type: DataTypes.STRING },
      resourceId: { type: DataTypes.STRING },
      ipAddress: { type: DataTypes.STRING(45) }, // Supports IPv6
      userAgent: { type: DataTypes.TEXT },
      queryParams: { type: DataTypes.JSONB },
      dataHash: { type: DataTypes.STRING(64) }, // SHA-256
      blockchainTxId: { type: DataTypes.STRING },
      verified: { type: DataTypes.BOOLEAN, defaultValue: false }
    }, {
      indexes: [
        { fields: ['userId'] },
        { fields: ['resourceType', 'resourceId'] },
        { fields: ['timestamp'] }
      ],
      hooks: {
        afterCreate: async (entry) => {
          await this._anchorToBlockchain(entry);
        }
      }
    });

    this.wss = new WebSocket.Server({ port: process.env.AUDIT_WS_PORT || 8081 });
    this._setupRealtimeNotifications();
    this.blockchain = new Blockchain(process.env.BLOCKCHAIN_NETWORK);
  }

  async initialize() {
    await this.sequelize.authenticate();
    await this.LogEntry.sync({ force: process.env.NODE_ENV === 'test' });
    console.log('AuditLog system ready');
  }

  // Core logging method
  async log(userId, action, metadata = {}) {
    const entry = await this.LogEntry.create({
      userId,
      action,
      resourceType: metadata.resourceType,
      resourceId: metadata.resourceId,
      ipAddress: metadata.ip,
      userAgent: metadata.userAgent,
      queryParams: metadata.query,
      dataHash: metadata.data ? this._hashData(metadata.data) : null
    });

    this._notifyClients('NEW_ENTRY', entry);
    return entry;
  }

  // Blockchain anchoring (batch every 10 minutes)
  async _anchorToBlockchain(entry) {
    if (process.env.BLOCKCHAIN_AUDIT === 'true') {
      const batch = await this._getUnverifiedBatch();
      if (batch.length >= 5 || (batch.length > 0 && Date.now() - batch[0].timestamp > 600000)) {
        const merkleRoot = this._calculateMerkleRoot(batch);
        const tx = await this.blockchain.submitAuditBatch({
          hospitalId: process.env.HOSPITAL_ID,
          merkleRoot,
          entries: batch.map(e => e.id)
        });
        
        await this.LogEntry.update(
          { blockchainTxId: tx.hash, verified: true },
          { where: { id: batch.map(e => e.id) } }
        );
      }
    }
  }

  // Real-time monitoring
  _setupRealtimeNotifications() {
    this.wss.on('connection', (ws) => {
      ws.on('message', (message) => {
        const { type, filters } = JSON.parse(message);
        if (type === 'SUBSCRIBE') {
          ws.filters = filters; // Store client's filter preferences
        }
      });
    });
  }

  _notifyClients(eventType, data) {
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && 
          (!client.filters || this._matchesFilters(data, client.filters))) {
        client.send(JSON.stringify({ eventType, data }));
      }
    });
  }

  _matchesFilters(entry, filters) {
    return Object.entries(filters).every(([key, value]) => 
      entry[key] === value || (Array.isArray(value) && value.includes(entry[key]))
    );
  }

  // Verification methods
  async verifyEntry(entryId) {
    const entry = await this.LogEntry.findByPk(entryId);
    if (!entry) throw new Error('Entry not found');
    
    if (entry.blockchainTxId) {
      return await this.blockchain.verifyTransaction(
        entry.blockchainTxId,
        this._hashEntry(entry)
      );
    }
    return false;
  }

  async verifyAllRecent() {
    const unverified = await this._getUnverifiedBatch();
    return Promise.all(unverified.map(entry => this.verifyEntry(entry.id)));
  }

  // Query methods
  async getAccessHistory(resourceType, resourceId) {
    return this.LogEntry.findAll({
      where: { resourceType, resourceId },
      order: [['timestamp', 'DESC']],
      limit: 100
    });
  }

  async getUserActivity(userId, hours = 24) {
    return this.LogEntry.findAll({
      where: {
        userId,
        timestamp: { [Sequelize.Op.gte]: new Date(Date.now() - hours * 60 * 60 * 1000) }
      }
    });
  }

  // Utility methods
  _hashData(data) {
    return crypto.createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  _hashEntry(entry) {
    return crypto.createHash('sha256')
      .update(`${entry.userId}|${entry.action}|${entry.resourceType}|${entry.timestamp}`)
      .digest('hex');
  }

  _calculateMerkleRoot(entries) {
    const hashes = entries.map(e => this._hashEntry(e));
    while (hashes.length > 1) {
      const newLevel = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const combined = hashes[i] + (hashes[i+1] || hashes[i]);
        newLevel.push(crypto.createHash('sha256').update(combined).digest('hex'));
      }
      hashes = newLevel;
    }
    return hashes[0];
  }

  async _getUnverifiedBatch() {
    return this.LogEntry.findAll({
      where: { verified: false },
      order: [['timestamp', 'ASC']],
      limit: 100
    });
  }
}

module.exports = AuditLog;