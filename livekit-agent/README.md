# LiveKit Cloud Agent (optional)

This folder is only needed if you want to run the same German telesales agent inside LiveKit Cloud rooms (WebRTC).

## Local dev

```bash
cd xaioutbound/livekit-agent
cp .env.template .env
python -m pip install -e .
python agent.py dev
```

## LiveKit Cloud deploy (CLI)

From this folder:

```bash
lk agent create
```

