import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { } from '../sockets/websocketServer.js';

// Load certs from /certs directory
const CERT_DIR = path.resolve(__dirname, '../certs');

const client = mqtt.connect('mqtts://arn:aws:iot:eu-north-1:590183953473:domainconfiguration/iot:Data-ATS', {
  key: fs.readFileSync(path.join(CERT_DIR, 'private.pem.key')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'certificate.pem.crt')),
  ca: fs.readFileSync(path.join(CERT_DIR, 'AmazonRootCA1.pem')),
  clientId: 'UHRH_ECG_Thing',
  protocol: 'mqtts',
  rejectUnauthorized: true,
});

client.on('connect', () => {
  console.log('✅ Connected to AWS IoT MQTT Broker');

  // Example topic subscriptions
  client.subscribe('uhrh/ecg');
  client.subscribe('uhrh/vitals');
});

client.on('message', (topic, message) => {
  console.log(`📡 ${topic}: ${message.toString()}`);

  // Example: Forward to WebSocket clients or trigger alerts
  // forwardToWebsocketClients(topic, message);
});

client.on('error', (err) => {
  console.error('❌ MQTT Connection Error:', err);
});

export default client;
