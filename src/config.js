import { cleanEnv, num, str } from "envalid";

export function loadConfig() {
  return cleanEnv(process.env, {
    PORT: num({ default: 3000 }),
    PUBLIC_BASE_URL: str(),

    // Protect outbound dialing endpoint.
    ADMIN_API_KEY: str(),

    // Telnyx (outbound dialing + media streaming)
    TELNYX_API_KEY: str(),
    TELNYX_CONNECTION_ID: str(),
    TELNYX_FROM_NUMBER: str(),
    TELNYX_SIP_REGION: str({ default: "Europe" }),

    // xAI
    XAI_API_KEY: str(),
    XAI_MODEL: str({ default: "grok-voice-think-fast-1.0" }),
    XAI_VOICE: str({ default: "ara" }),

    // Agent behavior
    AGENT_COMPANY_NAME: str({ default: "Deine Firma" }),
    AGENT_PRODUCT_NAME: str({ default: "Jobanzeigen auf StepStone/Indeed" }),
    AGENT_TARGET_MARKET: str({ default: "HR/Recruiting-Verantwortliche" }),

    // Limits
    MAX_CONCURRENT_CALLS: num({ default: 20 }),
    STREAM_TOKEN_TTL_SECONDS: num({ default: 600 })
  });
}

