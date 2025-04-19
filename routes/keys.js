import express from 'express';
import kms from '../kmsClient.js';
import crypto from 'crypto';
import { SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';

const router = express.Router();
const keyId = process.env.KMS_KEY_ID;

// POST /api/sign-jwt
router.post('/sign-jwt', async (req, res) => {
  try {
    const { payload } = req.body;
    const digest = crypto.createHash("sha256").update(payload).digest();

    const command = new SignCommand({
      KeyId: keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"
    });

    const result = await kms.send(command);
    res.json({ signature: result.Signature.toString('base64') });
  } catch (err) {
    console.error("Error signing JWT:", err);
    res.status(500).json({ error: "Failed to sign payload" });
  }
});

// GET /api/get-public-key
router.get('/get-public-key', async (req, res) => {
  try {
    const command = new GetPublicKeyCommand({ KeyId: keyId });
    const result = await kms.send(command);
    res.json({
      keyId: keyId,
      publicKeyPem: result.PublicKey.toString('base64'),
      algorithm: result.SigningAlgorithms
    });
  } catch (err) {
    console.error("Error retrieving public key:", err);
    res.status(500).json({ error: "Failed to get public key" });
  }
});

export default router;
