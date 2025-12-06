import { createClient } from '@supabase/supabase-js';
import WebSocket, { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

// Supabase client with service-role (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// WebSocket server
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

// Set of all connected WebSocket clients
const clients = new Set();

// Authenticate visitor token
function verifyVisitorToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.sub; // visitor_id
  } catch (err) {
    return null;
  }
}

// Handle connections
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  const visitorId = verifyVisitorToken(token);
  if (!visitorId) {
    ws.send(JSON.stringify({ error: 'Invalid visitor token' }));
    return ws.close();
  }

  console.log(`[WS] Visitor connected: ${visitorId}`);
  clients.add(ws);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Visitor disconnected: ${visitorId}`);
  });
});

// Broadcast helper to all connected clients
function broadcast(message) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(message));
      } catch (err) {
        console.error('Failed to send message:', err);
      }
    }
  });
}

// Listen to chats table inserts
supabase
  .channel('chats-and-conversations')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chats' }, (payload) => {
    broadcast({ type: 'chat', data: payload.new });
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, (payload) => {
    broadcast({ type: 'conversation', data: payload.new });
  })
  .subscribe();

console.log(`[WS] Server running on port ${process.env.PORT || 8080}`);
