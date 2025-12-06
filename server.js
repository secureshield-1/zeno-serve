import { createClient } from '@supabase/supabase-js';
import WebSocket, { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// WebSocket server
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

// Map conversationId -> Set of WebSocket clients
const subscribers = new Map();

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
  const conversationId = url.searchParams.get('conversation_id');

  if (!conversationId) {
    ws.send(JSON.stringify({ error: 'Missing conversation_id' }));
    return ws.close();
  }

  const visitorId = verifyVisitorToken(token);
  if (!visitorId) {
    ws.send(JSON.stringify({ error: 'Invalid visitor token' }));
    return ws.close();
  }

  console.log(`[WS] Visitor connected: ${visitorId}, conversation: ${conversationId}`);

  // Add ws to subscribers map for the conversation
  if (!subscribers.has(conversationId)) subscribers.set(conversationId, new Set());
  subscribers.get(conversationId).add(ws);

  ws.on('close', () => {
    subscribers.get(conversationId).delete(ws);
    if (subscribers.get(conversationId).size === 0) subscribers.delete(conversationId);
    console.log(`[WS] Visitor disconnected: ${visitorId}, conversation: ${conversationId}`);
  });
});

// Broadcast helper per conversation
function broadcast(conversationId, message) {
  const clients = subscribers.get(conversationId);
  if (clients) {
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
}

// Listen to chats table inserts
supabase
  .channel('conversations-updates')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chats' }, (payload) => {
    broadcast(payload.new.conversations_id.toString(), { type: 'chat', data: payload.new });
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, (payload) => {
    broadcast(payload.new.id.toString(), { type: 'conversation', data: payload.new });
  })
  .subscribe();

console.log(`[WS] Server running on port ${process.env.PORT || 8080}`);
