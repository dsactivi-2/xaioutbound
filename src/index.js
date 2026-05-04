import http from "http";
import crypto from "crypto";
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import { buildTelesalesInstructions } from "./telesalesPrompt.js";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_MODEL = process.env.XAI_MODEL || "grok-voice-think-fast-1.0";
const XAI_VOICE = process.env.XAI_VOICE || "eve";

const AGENT_COMPANY_NAME = process.env.AGENT_COMPANY_NAME;
const AGENT_PRODUCT_NAME = process.env.AGENT_PRODUCT_NAME;
const AGENT_TARGET_MARKET = process.env.AGENT_TARGET_MARKET;

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;

if (!PUBLIC_BASE_URL) {
  // eslint-disable-next-line no-console
  console.warn("Missing PUBLIC_BASE_URL; Telnyx will not be able to reach your /telnyx/stream websocket.");
}
if (!XAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn("Missing XAI_API_KEY; xAI realtime connection will fail.");
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/telnyx/call", async (req, res) => {
  if (!PUBLIC_BASE_URL) return res.status(400).json({ error: "Missing PUBLIC_BASE_URL" });
  if (!TELNYX_API_KEY) return res.status(400).json({ error: "Missing TELNYX_API_KEY" });

  const to = req.body?.to;
  const from = req.body?.from || TELNYX_FROM_NUMBER;
  const connectionId = req.body?.connection_id || TELNYX_CONNECTION_ID;

  if (!to) return res.status(400).json({ error: "Missing 'to'" });
  if (!from) return res.status(400).json({ error: "Missing 'from' (or TELNYX_FROM_NUMBER)" });
  if (!connectionId) return res.status(400).json({ error: "Missing 'connection_id' (or TELNYX_CONNECTION_ID)" });

  const streamUrl = new URL("/telnyx/stream", PUBLIC_BASE_URL).toString();

  try {
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`
      },
      body: JSON.stringify({
        connection_id: connectionId,
        to,
        from,
        stream_url: streamUrl,
        stream_track: "inbound_track",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "PCMU",
        stream_bidirectional_sampling_rate: 8000
      })
    });

    const text = await r.text();
    const json = safeJsonParse(text) || { raw: text };
    if (!r.ok) return res.status(r.status).json(json);
    return res.status(200).json(json);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post("/telnyx/texml", (_req, res) => {
  const wsUrl = new URL("/telnyx/stream", PUBLIC_BASE_URL);
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

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/telnyx/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  socket.destroy();
});

function makeXaiRealtimeUrl() {
  const base = "wss://api.x.ai/v1/realtime";
  const u = new URL(base);
  u.searchParams.set("model", XAI_MODEL);
  return u.toString();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

wss.on("connection", (telnyxWs) => {
  const connectionId = crypto.randomBytes(6).toString("hex");
  let streamId = null;

  let xaiWs = null;
  let xaiReady = false;
  let greeted = false;

  const instructions = buildTelesalesInstructions({
    companyName: AGENT_COMPANY_NAME,
    productName: AGENT_PRODUCT_NAME,
    targetMarket: AGENT_TARGET_MARKET
  });

  function connectXai() {
    xaiWs = new WebSocket(makeXaiRealtimeUrl(), {
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`
      }
    });

    xaiWs.on("open", () => {
      xaiReady = true;
      xaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice: XAI_VOICE,
            instructions,
            turn_detection: { type: "server_vad" },
            audio: {
              input: { format: { type: "audio/pcmu", rate: 8000 } },
              output: { format: { type: "audio/pcmu", rate: 8000 } }
            }
          }
        })
      );
    });

    xaiWs.on("message", (data) => {
      const msg = typeof data === "string" ? data : data.toString("utf8");
      const event = safeJsonParse(msg);
      if (!event?.type) return;

      // Stream audio from model back to Telnyx
      if (event.type === "response.output_audio.delta") {
        // For Telnyx bidirectional RTP streaming, send base64 RTP payload bytes (no headers).
        // Telnyx docs show outbound "media" messages without stream_id.
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

    // Telnyx WebSocket events: connected, start, media, stop
    if (event.event === "start") {
      streamId = event.stream_id || event.streamId || null;
      return;
    }

    if (event.event === "media") {
      // Only forward inbound audio to the model (avoid feeding back assistant audio).
      const track = event.media?.track;
      if (track && track !== "inbound") return;

      const payload = event.media?.payload;
      if (!payload) return;

      if (xaiReady && xaiWs?.readyState === WebSocket.OPEN) {
        xaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));

        // Kick off the first assistant turn once we have audio flowing.
        if (!greeted) {
          greeted = true;
          xaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "The call is connected. Greet the prospect and start the conversation now." }]
              }
            })
          );
          xaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      }
      return;
    }

    if (event.event === "stop") {
      try {
        telnyxWs.close();
      } catch {}
      return;
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

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`telesales-call-agent listening on :${PORT}`);
});
