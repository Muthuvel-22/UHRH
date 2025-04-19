import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('🧩 New WebSocket client connected');

  ws.send(JSON.stringify({ type: 'connected', message: 'Welcome to UHRH stream' }));
});

function broadcast(topic, data) {
  const payload = {
    topic,
    data,
  };

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(payload));
    }
  });
}

export { wss, broadcast };
