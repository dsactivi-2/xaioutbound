# Telesales Call Agent (Telnyx ↔ xAI Grok Voice)

Minimal bridge server that:

- Answers an inbound Telnyx call with TeXML that starts Telnyx Media Streaming
- Bridges the audio stream to xAI's realtime Voice Agent API over WebSocket
- Streams the model's audio back to the ongoing Telnyx call (bidirectional RTP)

## 1) Setup

```bash
cd telesales-call-agent
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

Expose locally (example):

```bash
ngrok http 3000
```

## 2) Telnyx configuration (TeXML)

Create/choose a Telnyx number + TeXML application/bin and set the webhook to:

- `POST {PUBLIC_BASE_URL}/telnyx/texml`

## 3) Outbound dialing (optional)

If you want this server to *place* calls (typical telesales), set `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, and `TELNYX_FROM_NUMBER`, then:

```bash
curl -sS -X POST "$PUBLIC_BASE_URL/telnyx/call" \
  -H 'content-type: application/json' \
  -d '{"to":"+15551230000"}'
```

## Notes

- This MVP uses `audio/pcmu` at 8kHz (G.711 μ-law) to match Telnyx bidirectional RTP streaming defaults.
- Add your compliance flow (TCPA/consent, DNC, opt-out language, recording notice) in `src/telesalesPrompt.js`.
- If you want the model to respond in German (or any other language), mention that explicitly in `src/telesalesPrompt.js` instructions.
