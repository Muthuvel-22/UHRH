// smsService.js - Secure SMS Messaging Service for Healthcare
const twilio = require('twilio');
const { FHIR } = require('fhir-kit-client');
const { AuditLog } = require('./audit');
const { AesService } = require('./aesService');
const { validatePhone } = require('libphonenumber-js');

class SMSService {
  constructor() {
    // Initialize services
    this.twilio = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    this.fhir = new FHIR.Client({ baseUrl: process.env.FHIR_SERVER });
    this.audit = new AuditLog();
    this.crypto = new AesService();
    
    // Configuration
    this.config = {
      maxRetries: 3,
      deliveryTimeout: 30000, // 30 seconds
      compliance: {
        hipaaCompliant: true,
        messageRetentionDays: 30
      }
    };
  }

  // 1. Core Messaging
  async sendMessage(params) {
    const { 
      patientId, 
      phoneNumber, 
      message, 
      context, 
      priority = 'routine' 
    } = params;

    // Validate inputs
    this._validateInputs(patientId, phoneNumber, message);

    // Check consent
    await this._verifySMSConsent(patientId);

    // Prepare secure message
    const { encryptedMessage, keyId } = await this._encryptMessage(message, patientId);

    // Format for SMS (with secure link if needed)
    const smsBody = this._formatSMSContent(encryptedMessage, context);

    try {
      // Send via Twilio
      const result = await this.twilio.messages.create({
        body: smsBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: this._formatPhoneNumber(phoneNumber),
        statusCallback: `${process.env.API_BASE_URL}/sms/status`,
      });

      // Log the delivery
      await this._logMessage({
        patientId,
        messageId: result.sid,
        phoneNumber,
        keyId,
        context,
        status: 'sent',
        priority
      });

      return {
        messageId: result.sid,
        status: 'sent',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      await this._logMessage({
        patientId,
        messageId: `error-${Date.now()}`,
        phoneNumber,
        context,
        status: 'failed',
        error: error.message
      });
      throw this._handleError(error);
    }
  }

  // 2. Secure Message Retrieval
  async getSecureMessage(messageId) {
    const messageLog = await this.audit.getEvent('SMS_SENT', { messageId });
    if (!messageLog) throw new Error('Message not found');

    // Verify still within retention period
    this._checkRetentionPeriod(messageLog.timestamp);

    // Retrieve encryption key
    const decrypted = await this.crypto.decrypt(
      messageLog.encryptedMessage, 
      messageLog.keyId,
      { contextData: { messageId } }
    );

    return {
      ...messageLog,
      decryptedMessage: decrypted,
      decryptedAt: new Date().toISOString()
    };
  }

  // 3. Delivery Status Handling
  async handleStatusCallback(params) {
    const { 
      MessageSid, 
      MessageStatus, 
      ErrorCode 
    } = params;

    // Update message log
    await this.audit.updateEvent('SMS_SENT', MessageSid, {
      status: this._mapTwilioStatus(MessageStatus),
      error: ErrorCode || null,
      deliveredAt: MessageStatus === 'delivered' ? new Date().toISOString() : null
    });

    // If failed, trigger retry or alert
    if (MessageStatus === 'failed') {
      await this._handleFailedDelivery(MessageSid);
    }

    return { status: 'processed' };
  }

  // 4. Compliance Operations
  async purgeMessages(patientId) {
    // Check if patient has opted out
    const consent = await this._getSMSConsent(patientId);
    if (consent.status !== 'revoked') {
      throw new Error('Cannot purge - patient has not revoked consent');
    }

    // Get all messages for patient
    const messages = await this.audit.searchEvents('SMS_SENT', { patientId });

    // Securely purge each message
    for (const msg of messages) {
      await this._purgeSingleMessage(msg.messageId);
    }

    return { 
      status: 'purged',
      count: messages.length,
      patientId 
    };
  }

  // ========== PRIVATE METHODS ========== //

  // 1. Security & Validation
  async _verifySMSConsent(patientId) {
    const consent = await this._getSMSConsent(patientId);
    
    if (consent.status !== 'active') {
      throw new Error(`SMS consent status: ${consent.status}`);
    }

    if (new Date(consent.expiration) < new Date()) {
      throw new Error('SMS consent has expired');
    }

    return true;
  }

  async _getSMSConsent(patientId) {
    const result = await this.fhir.search({
      resourceType: 'Consent',
      params: {
        patient: `Patient/${patientId}`,
        category: 'sms-communication'
      }
    });

    if (!result.entry || result.entry.length === 0) {
      return { status: 'none', expiration: null };
    }

    const latestConsent = result.entry[0].resource;
    return {
      status: latestConsent.status,
      expiration: latestConsent.provision?.period?.end
    };
  }

  _validateInputs(patientId, phoneNumber, message) {
    if (!patientId || !phoneNumber || !message) {
      throw new Error('Missing required parameters');
    }

    if (message.length > 1600) {
      throw new Error('Message exceeds 1600 character limit');
    }

    const phoneValid = validatePhone(phoneNumber);
    if (!phoneValid.isValid) {
      throw new Error(`Invalid phone number: ${phoneValid.reason}`);
    }
  }

  // 2. Message Processing
  async _encryptMessage(message, patientId) {
    // Generate or retrieve patient-specific key
    const { keyId } = await this.crypto.generateKey({
      keyType: 'sms-encryption',
      ownerId: patientId
    });

    // Encrypt with context data
    const encrypted = await this.crypto.encrypt(message, keyId, {
      contextData: {
        resourceType: 'Communication',
        purpose: 'patient-sms'
      }
    });

    return { encryptedMessage: encrypted, keyId };
  }

  _formatSMSContent(encryptedMessage, context) {
    if (this.config.compliance.hipaaCompliant) {
      // For HIPAA, send a secure link instead of PHI
      return `New secure message from ${context.senderName}: ` +
             `${process.env.SECURE_SMS_URL}/${encryptedMessage.messageId}`;
    } else {
      // For non-PHI messages (appointments reminders, etc.)
      return encryptedMessage;
    }
  }

  _formatPhoneNumber(number) {
    // Format to E.164 standard
    const formatted = validatePhone(number);
    return formatted.number ? formatted.number : number;
  }

  // 3. Logging & Compliance
  async _logMessage(params) {
    const { 
      patientId, 
      messageId, 
      phoneNumber, 
      keyId, 
      context, 
      status, 
      priority,
      error 
    } = params;

    // Create FHIR Communication resource
    const communication = {
      resourceType: 'Communication',
      status: 'completed',
      category: [{
        coding: [{
          system: 'http://hl7.org/fhir/communication-category',
          code: 'sms'
        }]
      }],
      priority: this._mapPriority(priority),
      subject: { reference: `Patient/${patientId}` },
      payload: [{
        contentString: `SMS to ${phoneNumber} (${status})`
      }],
      sent: new Date().toISOString(),
      extension: [{
        url: 'http://hl7.org/fhir/sms-metadata',
        extension: [
          { url: 'messageId', valueString: messageId },
          { url: 'keyId', valueString: keyId },
          { url: 'context', valueString: JSON.stringify(context) }
        ]
      }]
    };

    if (error) {
      communication.status = 'failed';
      communication.payload[0].contentString += `: ${error}`;
    }

    await this.fhir.create({ resourceType: 'Communication', body: communication });

    // Audit log
    await this.audit.log('SMS_SENT', {
      patientId,
      messageId,
      phoneNumber,
      status,
      priority,
      encryptedMessage: params.encryptedMessage,
      keyId,
      context
    });
  }

  async _purgeSingleMessage(messageId) {
    // 1. Delete encryption key
    const messageLog = await this.audit.getEvent('SMS_SENT', { messageId });
    if (messageLog.keyId) {
      await this.crypto.revokeKey(messageLog.keyId, 'purge-requested');
    }

    // 2. Anonymize audit log
    await this.audit.updateEvent('SMS_SENT', messageId, {
      phoneNumber: 'PURGED',
      encryptedMessage: 'PURGED',
      keyId: 'PURGED',
      status: 'purged'
    });

    // 3. Update FHIR Communication
    const comms = await this.fhir.search({
      resourceType: 'Communication',
      params: { 'extension.messageId': messageId }
    });

    if (comms.entry?.length > 0) {
      const comm = comms.entry[0].resource;
      comm.payload[0].contentString = 'Message purged per request';
      await this.fhir.update(comm);
    }
  }

  _checkRetentionPeriod(timestamp) {
    const retentionDays = this.config.compliance.messageRetentionDays;
    const messageDate = new Date(timestamp);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    if (messageDate < cutoffDate) {
      throw new Error(`Message beyond retention period (${retentionDays} days)`);
    }
  }

  // 4. Delivery Management
  async _handleFailedDelivery(messageId) {
    const message = await this.audit.getEvent('SMS_SENT', { messageId });

    // Check retry count
    const retryCount = message.retryCount || 0;
    if (retryCount >= this.config.maxRetries) {
      await this._escalateDeliveryFailure(message);
      return;
    }

    // Queue retry
    setTimeout(async () => {
      try {
        await this.sendMessage({
          patientId: message.patientId,
          phoneNumber: message.phoneNumber,
          message: await this.crypto.decrypt(
            message.encryptedMessage, 
            message.keyId
          ),
          context: message.context,
          priority: message.priority
        });
      } catch (error) {
        console.error(`Retry failed for ${messageId}:`, error);
      }
    }, this.config.deliveryTimeout);

    // Update retry count
    await this.audit.updateEvent('SMS_SENT', messageId, {
      retryCount: retryCount + 1
    });
  }

  async _escalateDeliveryFailure(message) {
    // Create FHIR Flag for clinical staff
    const flag = {
      resourceType: 'Flag',
      status: 'active',
      code: { text: 'SMS Delivery Failure' },
      subject: { reference: `Patient/${message.patientId}` },
      extension: [{
        url: 'http://hl7.org/fhir/sms-failure-details',
        valueString: `Failed to deliver SMS after ${this.config.maxRetries} attempts`
      }]
    };

    await this.fhir.create({ resourceType: 'Flag', body: flag });

    // Log escalation
    await this.audit.log('SMS_ESCALATION', {
      messageId: message.messageId,
      patientId: message.patientId,
      action: 'created-clinical-alert'
    });
  }

  // 5. Utility Methods
  _mapTwilioStatus(status) {
    const statusMap = {
      'queued': 'sent',
      'sent': 'sent',
      'delivered': 'delivered',
      'failed': 'failed',
      'undelivered': 'failed'
    };
    return statusMap[status] || status;
  }

  _mapPriority(priority) {
    const priorityMap = {
      'routine': 'routine',
      'urgent': 'urgent',
      'emergency': 'stat'
    };
    return priorityMap[priority] || 'routine';
  }

  _handleError(error) {
    // Mask sensitive Twilio errors
    const safeErrors = [
      'Invalid phone number',
      'SMS capability is not enabled'
    ];

    if (safeErrors.some(e => error.message.includes(e))) {
      return error;
    }

    return new Error('Message delivery failed');
  }
}

module.exports = SMSService;