import http from "http";
import crypto from "crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { buildTelesalesInstructions } from "./telesalesPrompt.js";

dotenv.config();

const cfg = loadConfig();
const log = pino({ level: process.env.LOG_LEVEL || "info" });

const streamTokens = new Map(); // token -> { expiresAtMs }

function issueStreamToken(ttlSeconds) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  streamTokens.set(token, { expiresAtMs });
  return token;
}

function validateE164(value) {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function makeXaiRealtimeUrl() {
  const u = new URL("wss://api.x.ai/v1/realtime");
  u.searchParams.set("model", cfg.XAI_MODEL);
  return u.toString();
}

function requireAdminApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== cfg.ADMIN_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(pinoHttp({ logger: log }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post(
  "/telnyx/call",
  requireAdminApiKey,
  rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    if (streamTokens.size >= cfg.MAX_CONCURRENT_CALLS) {
      return res.status(429).json({ error: "Too many concurrent calls" });
    }

    const to = req.body?.to;
    const from = req.body?.from || cfg.TELNYX_FROM_NUMBER;
    const connectionId = req.body?.connection_id || cfg.TELNYX_CONNECTION_ID;

    if (!validateE164(to)) return res.status(400).json({ error: "Invalid 'to' (must be E.164, e.g. +49123456789)" });
    if (!validateE164(from)) return res.status(400).json({ error: "Invalid 'from' (must be E.164, e.g. +49123456789)" });
    if (!connectionId) return res.status(400).json({ error: "Missing 'connection_id'" });

    const token = issueStreamToken(cfg.STREAM_TOKEN_TTL_SECONDS);

    // Telnyx will connect to this WS URL; we also include our token as a query param so
    // the server can reliably authenticate the stream.
    const streamWsUrl = new URL("/telnyx/stream", cfg.PUBLIC_BASE_URL);
    streamWsUrl.searchParams.set("token", token);

    try {
      const r = await fetch("https://api.telnyx.com/v2/calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${cfg.TELNYX_API_KEY}`
        },
        body: JSON.stringify({
          connection_id: connectionId,
          to,
          from,
          sip_region: cfg.TELNYX_SIP_REGION,
          stream_url: streamWsUrl.toString(),
          stream_track: "inbound_track",
          stream_bidirectional_mode: "rtp",
          stream_bidirectional_codec: "PCMU",
          stream_bidirectional_sampling_rate: 8000,
          // Also set Telnyx' stream_auth_token for defense in depth (how it is delivered
          // to the WS server may vary by implementation).
          stream_auth_token: token
        })
      });

      const text = await r.text();
      const json = safeJsonParse(text) || { raw: text };
      if (!r.ok) return res.status(r.status).json(json);
      return res.status(200).json({ ...json, stream_token: token });
    } catch (err) {
      streamTokens.delete(token);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

// Optional: TeXML entrypoint (kept for convenience/testing). Protect it.
app.post("/telnyx/texml", requireAdminApiKey, (_req, res) => {
  const wsUrl = new URL("/telnyx/stream", cfg.PUBLIC_BASE_URL);
  wsUrl.searchParams.set("token", issueStreamToken(cfg.STREAM_TOKEN_TTL_SECONDS));

  const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream
      url="${wsUrl.toString()}"
      track="inbound_track"
      codec="PCMU"
      bidirectionalMode="rtp"
      bidirectionalCodec="PCMU"
      bidirectionalSamplingRate="8000"
    />
  </Start>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(texml);
});

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/telnyx/stream") return socket.destroy();

  const token = url.searchParams.get("token");
  const rec = token ? streamTokens.get(token) : null;
  if (!token || !rec || rec.expiresAtMs < Date.now()) {
    socket.destroy();
    return;
  }

  // Token is one-time use for the initial WS connection.
  streamTokens.delete(token);

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (telnyxWs) => {
  let streamId = null;
  let telnyxStarted = false;

  let xaiWs = null;
  let xaiReady = false;
  let greeted = false;

  const instructions = buildTelesalesInstructions({
    companyName: cfg.AGENT_COMPANY_NAME,
    productName: cfg.AGENT_PRODUCT_NAME,
    targetMarket: cfg.AGENT_TARGET_MARKET
  });

  const maybeGreet = () => {
    if (greeted) return;
    if (!telnyxStarted) return;
    if (!xaiReady || !xaiWs || xaiWs.readyState !== WebSocket.OPEN) return;

    greeted = true;
    xaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Der Anruf ist verbunden. Starte jetzt mit Begrüßung, KI-Offenlegung und der Frage, ob es gerade kurz passt."
            }
          ]
        }
      })
    );
    xaiWs.send(JSON.stringify({ type: "response.create" }));
  };

  function connectXai() {
    xaiWs = new WebSocket(makeXaiRealtimeUrl(), {
      headers: { Authorization: `Bearer ${cfg.XAI_API_KEY}` }
    });

    xaiWs.on("open", () => {
      xaiReady = true;
      xaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice: cfg.XAI_VOICE,
            instructions,
            turn_detection: { type: "server_vad" },
            audio: {
              input: { format: { type: "audio/pcmu", rate: 8000 } },
              output: { format: { type: "audio/pcmu", rate: 8000 } }
            }
          }
        })
      );

      maybeGreet();
    });

    xaiWs.on("message", (data) => {
      const msg = typeof data === "string" ? data : data.toString("utf8");
      const event = safeJsonParse(msg);
      if (!event?.type) return;

      if (event.type === "response.output_audio.delta") {
        // For Telnyx bidirectional RTP streaming, send base64 RTP payload bytes (no headers).
        telnyxWs.send(JSON.stringify({ event: "media", media: { payload: event.delta } }));
      }
    });

    xaiWs.on("close", () => {
      xaiReady = false;
      try {
        telnyxWs.close();
      } catch {}
    });

    xaiWs.on("error", () => {
      xaiReady = false;
      try {
        telnyxWs.close();
      } catch {}
    });
  }

  connectXai();

  telnyxWs.on("message", (data) => {
    const msg = typeof data === "string" ? data : data.toString("utf8");
    const event = safeJsonParse(msg);
    if (!event) return;

    if (event.event === "start") {
      streamId = event.stream_id || event.streamId || null;
      telnyxStarted = true;
      maybeGreet();
      return;
    }

    if (event.event === "media") {
      const track = event.media?.track;
      if (track && track !== "inbound") return;

      const payload = event.media?.payload;
      if (!payload) return;

      if (xaiReady && xaiWs?.readyState === WebSocket.OPEN) {
        xaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      }
      return;
    }

    if (event.event === "stop") {
      try {
        telnyxWs.close();
      } catch {}
    }
  });

  const shutdown = () => {
    try {
      telnyxWs.close();
    } catch {}
    try {
      xaiWs?.close();
    } catch {}
  };

  telnyxWs.on("close", shutdown);
  telnyxWs.on("error", shutdown);
});

setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of streamTokens.entries()) {
    if (rec.expiresAtMs < now) streamTokens.delete(token);
  }
}, 15_000).unref();

server.listen(cfg.PORT, () => log.info({ port: cfg.PORT }, "xaioutbound listening"));

const shutdownSignals = ["SIGINT", "SIGTERM"];
for (const sig of shutdownSignals) {
  process.on(sig, () => {
    log.info({ sig }, "shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
