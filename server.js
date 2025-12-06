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

// Check if visitor is part of conversation
async function isVisitorInConversation(visitorId, conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('visitor_id', visitorId)
    .single();

  if (error || !data) return false;
  return true;
}

// Handle connections
wss.on('connection', async (ws, req) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const conversationId = url.searchParams.get('conversation_id');

    if (!token || !conversationId) {
      ws.send(JSON.stringify({ error: 'Token and conversation_id required' }));
      return ws.close();
    }

    const visitorId = verifyVisitorToken(token);
    if (!visitorId) {
      ws.send(JSON.stringify({ error: 'Invalid visitor token' }));
      return ws.close();
    }

    const authorized = await isVisitorInConversation(visitorId, conversationId);
    if (!authorized) {
      ws.send(JSON.stringify({ error: 'Not authorized for this conversation' }));
      return ws.close();
    }

    console.log(`[WS] Visitor ${visitorId} connected to conversation ${conversationId}`);

    // Add ws to subscribers map
    if (!subscribers.has(conversationId)) subscribers.set(conversationId, new Set());
    subscribers.get(conversationId).add(ws);

    ws.on('close', () => {
      subscribers.get(conversationId).delete(ws);
      if (subscribers.get(conversationId).size === 0) subscribers.delete(conversationId);
      console.log(`[WS] Visitor ${visitorId} disconnected from conversation ${conversationId}`);
    });
  } catch (err) {
    console.error('WS connection error:', err);
    ws.close();
  }
});

// Listen to chats and conversations
supabase
  .channel('conversation-chats')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, (payload) => {
    const conversationId = payload.new.conversations_id;
    const clients = subscribers.get(conversationId);
    if (clients) {
      for (const ws of clients) ws.send(JSON.stringify({ type: 'chat', data: payload.new }));
    }
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, (payload) => {
    const conversationId = payload.new.id;
    const clients = subscribers.get(conversationId);
    if (clients) {
      for (const ws of clients) ws.send(JSON.stringify({ type: 'conversation', data: payload.new }));
    }
  })
  .subscribe();

console.log(`[WS] Server running on port ${process.env.PORT || 8080}`);
