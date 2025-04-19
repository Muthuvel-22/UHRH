export class AuditLog {
    constructor() {
      this.logs = [];
    }
  
    async log(userId, actionType, metadata = {}) {
      const timestamp = new Date().toISOString();
  
      const entry = {
        timestamp,
        userId,
        actionType,
        metadata
      };
  
      // In production, you'd store this in a secure DB or blockchain
      this.logs.push(entry);
  
      // For now, just log to console
      console.log(`[AUDIT] ${timestamp} | ${userId} | ${actionType}`, metadata);
    }
  
    // Optional: retrieve logs (for testing or admin view)
    getLogs() {
      return this.logs;
    }
  }
  