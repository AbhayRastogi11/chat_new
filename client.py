from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastmcp import Client
from openai import AzureOpenAI
from ag_ui.encoder import EventEncoder
from ag_ui.core import (
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    EventType,
)
import asyncio
import json
import os
import traceback
import sys
from dotenv import load_dotenv
import uvicorn

# NEW/CHANGED
import uuid
from contextlib import asynccontextmanager

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # prod me tighten karo
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# REMOVED global Client (race condition risk)
# client = Client("mcp_server.py")

llm = AzureOpenAI(
    api_key=os.getenv("subscription_key"),
    api_version=os.getenv("api_version"),
    azure_endpoint=os.getenv("endpoint"),
)

encoder = EventEncoder()


# NEW/CHANGED: per-request client builder (safer for concurrency)
@asynccontextmanager
async def build_client():
    # Agar aap HTTP transport use karte ho to yahan switch kar lo:
    # from fastmcp.client.transports import StreamableHttpTransport
    # transport = StreamableHttpTransport("http://127.0.0.1:8000/mcp")
    # client = Client(transport=transport)
    client = Client("mcp_server.py")
    async with client:
        yield client


# NEW/CHANGED: unique IDs per request
def new_ids():
    return (
        "thread_" + uuid.uuid4().hex,
        "run_" + uuid.uuid4().hex,
        "msg_" + uuid.uuid4().hex,
    )


# NEW/CHANGED: tool result normalizer (truncate to keep UI responsive)
def normalize_tool_result(result, limit=8000):
    try:
        if isinstance(result, (dict, list)):
            s = json.dumps(result, ensure_ascii=False)
        else:
            s = str(result)
    except Exception:
        s = str(result)
    return s[:limit] + ("… [truncated]" if len(s) > limit else "")


async def interact_with_server(user_prompt: str, client, thread_id: str, run_id: str, message_id: str):
    """Main orchestration generator that yields AG-UI events for streaming."""
    try:
        # Start the run
        yield encoder.encode(RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=thread_id,
            run_id=run_id
        ))

        # Start assistant message
        yield encoder.encode(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=message_id,
            role="assistant"
        ))

        # Discover tools from MCP server
        tool_descriptions = await client.list_tools()
        openai_tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.inputSchema,
                },
            }
            for tool in tool_descriptions
        ]

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a precise tool-using agent. "
                    "When a tool is relevant, call it with minimal arguments. "
                    "Prefer concise answers. Avoid leaking secrets."
                ),
            },
            {
                "role": "user",
                "content": f'The user says: "{user_prompt}"',
            },
        ]

        while True:
            # ---------- Phase 1: decide tool use (non-stream, same as your logic) ----------
            response = llm.chat.completions.create(
                model=os.getenv("deployment"),
                messages=messages,
                tool_choice="auto",
                tools=openai_tools if openai_tools else None,
                stream=False,  # keep non-stream to detect tool_calls
            )

            message = response.choices[0].message
            finish_reason = response.choices[0].finish_reason

            # === TOOL CALLING BRANCH ===
            if message.tool_calls:
                # Append assistant tool_calls message for context
                messages.append({
                    "role": "assistant",
                    "content": message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in message.tool_calls
                    ],
                })

                for tool_call in message.tool_calls:
                    tool_name = tool_call.function.name
                    # Robust parse
                    try:
                        tool_args = json.loads(tool_call.function.arguments or "{}")
                    except Exception:
                        tool_args = {}
                        # Emit error event but continue gracefully
                        yield encoder.encode(
                            RunErrorEvent(
                                type=EventType.RUN_ERROR,
                                message=f"Malformed tool arguments for {tool_name}"
                            )
                        )

                    # Tool start + args
                    yield encoder.encode(
                        ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=tool_call.id,
                            tool_call_name=tool_name,
                        )
                    )

                    yield encoder.encode(
                        ToolCallArgsEvent(
                            type=EventType.TOOL_CALL_ARGS,
                            tool_call_id=tool_call.id,
                            delta=json.dumps(tool_args),
                        )
                    )

                    # Call MCP tool
                    result = await client.call_tool(tool_name, tool_args)
                    result = getattr(result, "data", result)
                    result_content = normalize_tool_result(result)

                    yield encoder.encode(
                        ToolCallResultEvent(
                            type=EventType.TOOL_CALL_RESULT,
                            message_id=message_id,
                            tool_call_id=tool_call.id,
                            content=result_content,
                            role="tool",
                        )
                    )

                    # Feed result back to LLM
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result_content,
                    })

                # Loop continues: LLM will think again post tool results
                continue

            # === TEXT RESPONSE BRANCH (REAL STREAMING) ===
            else:
                # SECOND CALL with stream=True to stream final text in real-time
                stream = llm.chat.completions.create(
                    model=os.getenv("deployment"),
                    messages=messages,
                    tools=openai_tools if openai_tools else None,
                    tool_choice="none",   # ensure only text now
                    stream=True,          # <--- REAL STREAMING
                )

                # The SDK may be sync iterator; wrap in async if needed
                # We'll try naive iteration; if your SDK requires, adapt with anyio.to_thread.run_sync
                try:
                    for chunk in stream:
                        # Azure OpenAI returns choices[0].delta with content fragments
                        choice = chunk.choices[0]
                        delta = getattr(choice, "delta", None)
                        if delta and getattr(delta, "content", None):
                            yield encoder.encode(
                                TextMessageContentEvent(
                                    type=EventType.TEXT_MESSAGE_CONTENT,
                                    message_id=message_id,
                                    delta=delta.content,
                                )
                            )
                        # If finish, break
                        if getattr(choice, "finish_reason", None) in ("stop", "length"):
                            break
                except Exception as ste:
                    # If streaming fails for any reason, fallback to non-stream content
                    # to avoid breaking UX
                    resp2 = llm.chat.completions.create(
                        model=os.getenv("deployment"),
                        messages=messages,
                        tools=openai_tools if openai_tools else None,
                        tool_choice="none",
                        stream=False,
                    )
                    final_text = resp2.choices[0].message.content or ""
                    if final_text:
                        # Minimal chunking for UX parity
                        for i in range(0, len(final_text), 25):
                            yield encoder.encode(
                                TextMessageContentEvent(
                                    type=EventType.TEXT_MESSAGE_CONTENT,
                                    message_id=message_id,
                                    delta=final_text[i:i+25],
                                )
                            )
                            await asyncio.sleep(0)

                # End message + run finished
                yield encoder.encode(
                    TextMessageEndEvent(
                        type=EventType.TEXT_MESSAGE_END,
                        message_id=message_id
                    )
                )

                yield encoder.encode(
                    RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id=thread_id,
                        run_id=run_id
                    )
                )

                break

    except Exception as e:
        # Surface error to UI
        yield encoder.encode(
            RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e)
            )
        )
        traceback.print_exc()
    finally:
        # Optional: log tail
        pass


@app.post("/get_data")
async def stream_response(userprompt: str = Query(...)):
    # NOTE: aap chahe to body model use karke JSON body me bhi le sakte ho

    async def event_generator():
        try:
            thread_id, run_id, message_id = new_ids()
            async with build_client() as _client:
                # Stream events from orchestrator
                async for event in interact_with_server(userprompt, _client, thread_id, run_id, message_id):
                    # Ensure SSE framing: **double newline**
                    # If encoder already formats "data: ...\n\n", this will just be a safe guard.
                    if not event.endswith("\n\n"):
                        if event.endswith("\n"):
                            event = event + "\n"
                        else:
                            event = event + "\n\n"

                    yield event
                    await asyncio.sleep(0)  # force flush

                # (Optional) final heartbeat (comment frame)
                # yield ":hb\n\n"

        except Exception as e:
            # Emit a final RunErrorEvent frame if something breaks here
            err_evt = encoder.encode(
                RunErrorEvent(type=EventType.RUN_ERROR, message=str(e))
            )
            if not err_evt.endswith("\n\n"):
                err_evt += "\n\n"
            yield err_evt
            traceback.print_exc()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Type": "text/event-stream",
        },
    )


@app.get("/")
async def root():
    return {"status": "ok", "message": "AG-UI FastAPI server is running"}


if __name__ == "__main__":
    print("🚀 FastAPI AG-UI server starting on http://127.0.0.1:8001")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8001,
        log_level="info",
        access_log=True,
    )
