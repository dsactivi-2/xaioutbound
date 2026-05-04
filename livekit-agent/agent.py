import os

from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import xai

from prompt import build_instructions


async def entrypoint(ctx: JobContext) -> None:
    load_dotenv()

    instructions = build_instructions(
        os.getenv("COMPANY_NAME", ""),
        os.getenv("OFFER_NAME", ""),
        os.getenv("TARGET_CUSTOMERS", ""),
    )

    session = AgentSession(llm=xai.realtime.RealtimeModel(voice="Ara"))

    await session.start(
        room=ctx.room,
        agent=Agent(instructions=instructions),
    )


def main() -> None:
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()

