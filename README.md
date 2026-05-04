# xAI Outbound (Telnyx ↔ xAI Grok Voice) – Production Bridge

Minimal bridge server that:

- Places outbound calls via Telnyx Voice API v2 (`/v2/calls`)
- Bridges Telnyx Media Streaming (bidirectional RTP) ↔ xAI realtime Voice Agent API
- Runs a German-only telesales agent for job portal ads (StepStone/Indeed)

## 1) Setup

```bash
cd xaioutbound
cp .env.example .env
```

Set `PUBLIC_BASE_URL` to your public HTTPS URL (e.g., from `ngrok http 3000`).

Install deps:

```bash
npm i
```

Run:

```bash
npm start
```

## Outbound dialing

Set `ADMIN_API_KEY` in `.env`, then call:

```bash
curl -sS -X POST "https://YOUR_PUBLIC_URL/telnyx/call" \
  -H 'content-type: application/json' \
  -H "x-api-key: $ADMIN_API_KEY" \
  -d '{"to":"+49123456789"}'
```

## Notes

- This MVP uses `audio/pcmu` at 8kHz (G.711 μ-law) to match Telnyx bidirectional RTP streaming defaults.
- Adjust the German sales behavior/compliance language in `src/telesalesPrompt.js`.
- The Telnyx stream WebSocket is authenticated with a one-time token in the `stream_url` query string; don’t expose `/telnyx/call` publicly without `ADMIN_API_KEY`.
