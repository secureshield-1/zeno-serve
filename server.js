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

// Map visitorId -> Set of WebSocket clients
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
  // Expect visitor token in query string: ?token=...
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const visitorId = verifyVisitorToken(token);

  if (!visitorId) {
    ws.send(JSON.stringify({ error: 'Invalid visitor token' }));
    return ws.close();
  }

  console.log(`[WS] Visitor connected: ${visitorId}`);

  // Add ws to subscribers map
  if (!subscribers.has(visitorId)) subscribers.set(visitorId, new Set());
  subscribers.get(visitorId).add(ws);

  ws.on('close', () => {
    subscribers.get(visitorId).delete(ws);
    if (subscribers.get(visitorId).size === 0) subscribers.delete(visitorId);
    console.log(`[WS] Visitor disconnected: ${visitorId}`);
  });
});

// Listen to all chats
supabase
  .channel('all-chats')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, (payload) => {
    const visitorId = payload.new.visitor_id;
    const clients = subscribers.get(visitorId);
    if (clients) {
      for (const ws of clients) ws.send(JSON.stringify({ type: 'chat', data: payload.new }));
    }
  })
  .on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'conversations' },
    (payload) => {
      const visitorId = payload.new.visitor_id;
      const clients = subscribers.get(visitorId);
      if (clients) {
        for (const ws of clients)
          ws.send(JSON.stringify({ type: 'conversation', data: payload.new }));
      }
    }
  )
  .subscribe();

console.log(`[WS] Server running on port ${process.env.PORT || 8080}`);
