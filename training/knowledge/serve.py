"""
Serve the trained Javelin Chatting Knowledge adapter as an OpenAI-compatible endpoint.
=============================================================================

Javelin's IDE can talk to any OpenAI-shaped endpoint, so this is all it takes to use
the model you trained yourself: no Ollama, no cloud, no key.

    .venv/Scripts/python.exe training/knowledge/serve.py
    # then Settings -> Provider -> Custom
    #   base URL: http://127.0.0.1:8787/v1
    #   model:    javelin-knowledge
    #   key:      anything (it is ignored locally)

Endpoints:
    GET  /v1/models
    POST /v1/chat/completions     (stream=true and stream=false)

Honest note: a 135M model with a LoRA adapter is a *small* model. It reproduces the
style and the policy it was trained on; it is not a substitute for a large model on
novel reasoning. That is why the default provider in the IDE stays a hosted one and
this is opt-in.
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Two models, one endpoint. The chat model is the original 0.5B adapter; the coder is
# the 1.5B one. They are loaded lazily, so starting the server is instant and only the
# model you actually talk to costs memory.
MODEL_DIRS = {
    "javelin-knowledge": "training/knowledge/out",
    "javelin-coder-1.5b": "training/knowledge/out-1.5b",
}

STATE = {
    "models": {},       # id -> (model, tokenizer), filled on first use
    "adapters": {},     # id -> adapter directory
    "default": "javelin-knowledge",
    "lock": threading.Lock(),       # generation: one at a time, CPU
    "load_lock": threading.Lock(),  # loading: never twice for the same id
}

SYSTEM_PROMPT = (
    "You are Javelin, a senior software engineer working inside a code editor. "
    "You answer with a concrete method, state uncertainty plainly, and never claim "
    "work you did not do."
)


def base_of(adapter, fallback):
    """
    Read the base model the adapter was actually trained on.

    Serving an adapter on the wrong base does not error — it silently produces
    garbage, because the LoRA weights are applied to tensors of the same shape with
    different meanings. The adapter config records the truth, so prefer it.
    """
    import json

    config = os.path.join(adapter, "adapter_config.json")
    if os.path.isfile(config):
        try:
            with open(config, "r", encoding="utf-8") as f:
                found = json.load(f).get("base_model_name_or_path")
            if found:
                return found
        except Exception:
            pass
    return fallback


def load(base, adapter):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    base = base_of(adapter, base)
    print(f"loading base {base} ...", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(adapter if os.path.isdir(adapter) else base)
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float32)
    if os.path.isdir(adapter):
        print(f"applying adapter {adapter} ...", flush=True)
        model = PeftModel.from_pretrained(model, adapter)
        model = model.merge_and_unload()
    model.eval()
    # Dynamic int8 quantisation: faster, but measured on this model it broke tool
    # adherence (a write_file request came back as `obj['code']`), so it is opt-in
    # rather than the default. JAVELIN_QUANTIZE=1 trades accuracy for roughly 1.5x.
    if os.environ.get("JAVELIN_QUANTIZE", "0") == "1":
        try:
            import torch.nn as nn

            model = torch.quantization.quantize_dynamic(model, {nn.Linear}, dtype=torch.qint8)
            print("quantised: int8 dynamic (Linear)", flush=True)
        except Exception as exc:
            print(f"quantisation unavailable ({exc}); continuing in fp32", flush=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    return model, tokenizer


def ensure_model(model_id):
    """Load a model on first use and keep it. Unknown ids fall back to the default."""
    model_id = model_id if model_id in STATE["adapters"] else STATE["default"]
    if model_id in STATE["models"]:
        return model_id, STATE["models"][model_id]
    with STATE["load_lock"]:
        if model_id not in STATE["models"]:
            adapter = STATE["adapters"][model_id]
            print(f"loading {model_id} from {adapter} ...", flush=True)
            STATE["models"][model_id] = load(None, adapter)
            print(f"{model_id} ready", flush=True)
    return model_id, STATE["models"][model_id]


def tool_prompt(tools):
    """Describe the tools compactly enough that a 1.5B model can follow them."""
    lines = []
    for entry in tools:
        fn = entry.get("function") or entry
        name = fn.get("name")
        if not name:
            continue
        desc = (fn.get("description") or "").strip().replace("\n", " ")[:140]
        params = fn.get("parameters") or {}
        props = params.get("properties") or {}
        required = params.get("required") or []
        fields = ", ".join(f"{key}{'*' if key in required else ''}" for key in props)
        lines.append(f"- {name}({fields}): {desc}")
    return (
        "You can act on the workspace with these tools:\n"
        + "\n".join(lines)
        + "\n\nReply with exactly ONE JSON object and no other text.\n"
        'To use a tool:  {"tool": "<name>", "arguments": {...}}\n'
        'To answer:  {"answer": "<your message>"}\n'
        "\nRules, in order:\n"
        "1. For any task about the files, the code, or running a command, your FIRST reply MUST be a tool call. "
        "Never answer from memory about a workspace you have not inspected.\n"
        '2. Example: {"tool": "list_files", "arguments": {"path": "."}}\n'
        "3. Use {\"answer\"} only for pure conversation, or when the tool results you already received answer the task.\n"
        "4. Put real file contents in arguments. Do not describe a change instead of making it.\n\n"
        "Examples:\n"
        'User: "List the files in the workspace."\n'
        'You: {"tool": "list_files", "arguments": {"path": "."}}\n'
        'User: "Create hello.txt containing hi."\n'
        'You: {"tool": "write_file", "arguments": {"path": "hello.txt", "content": "hi"}}\n'
        'User: "Thanks!"\n'
        'You: {"answer": "Anytime."}'
    )


def json_objects(text):
    """Yield every balanced JSON object found in a reply."""
    starts = [i for i, ch in enumerate(text) if ch == "{"]
    for start in starts:
        depth, in_string, escaped, end = 0, False, False, -1
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end == -1:
            continue
        try:
            obj = json.loads(text[start:end + 1])
        except Exception:
            continue
        if isinstance(obj, dict):
            yield obj


def extract_action(text, allowed=None):
    """Find the first JSON object that looks like a tool call.

    Two shapes are accepted, because models use both: the documented
    `{"tool": "name", "arguments": {...}}` and the compact
    `{"name": {...}}` form, which a 1.5B model reaches for often.
    """
    for obj in json_objects(text):
        name = obj.get("tool") or obj.get("name")
        if isinstance(name, str) and (allowed is None or name in allowed):
            return name, obj.get("arguments", obj.get("args"))
        if allowed:
            keys = [key for key in obj if key in allowed]
            if len(obj) == 1 and keys:
                # `{"write_file": [...]}` and `{"write_file": "path"}` are common
                # enough to accept; the schema decides what the values mean.
                return keys[0], obj[keys[0]]
    return None


def extract_answer(text):
    """The text of `{"answer": "..."}` if the model used that envelope."""
    for obj in json_objects(text):
        if isinstance(obj.get("answer"), str):
            return obj["answer"]
    return None


def normalize_args(raw, param_names):
    """Turn whatever the model produced into a named argument object."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        return {name: value for name, value in zip(param_names, raw)}
    if isinstance(raw, str) and param_names:
        return {param_names[0]: raw}
    return None


def normalize(messages):
    """Flatten tool traffic into plain chat turns the template can render.

    The agent loop sends assistant turns carrying `tool_calls` and `tool` result turns.
    Qwen's template only partly understands those, and a dropped tool result means the
    model never learns what its last action returned — it then repeats the same call.
    """
    out = []
    for message in messages:
        role = message.get("role")
        content = message.get("content") or ""
        if role == "assistant" and message.get("tool_calls"):
            calls = []
            for call in message["tool_calls"]:
                fn = call.get("function") or {}
                calls.append(f"{fn.get('name')}({fn.get('arguments')})")
            content = ((content + "\n") if content else "") + "[tool call] " + "; ".join(calls)
        if role == "tool":
            out.append({"role": "user", "content": f"[tool result] {content}"})
        elif role in ("system", "user", "assistant"):
            out.append({"role": role, "content": content})
    return out


def generate(messages, model_id, max_tokens, temperature, top_p, tools=None, on_token=None):
    import torch

    used_id, (model, tokenizer) = ensure_model(model_id)
    # Keep the trained persona regardless of what the caller sends as a system prompt,
    # but preserve any extra context the IDE attached after it.
    cleaned = normalize(messages)
    if not cleaned or cleaned[0].get("role") != "system":
        cleaned = [{"role": "system", "content": SYSTEM_PROMPT}] + cleaned
    else:
        cleaned[0] = {"role": "system", "content": SYSTEM_PROMPT}
    if tools:
        # The model has no native tool channel, so the protocol is described in the
        # prompt and the reply is parsed back into a real tool call below. It goes in
        # the FIRST system message: a second one is easy for a small model to skip.
        cleaned[0] = dict(cleaned[0])
        cleaned[0]["content"] = (cleaned[0].get("content") or "") + "\n\n" + tool_prompt(tools)

    # Drop the OLDEST turns until the prompt fits. Tokenizer truncation trims the
    # *end* of the string, which is where the user's newest message lives — that
    # makes the model answer a conversation from ten turns ago and looks like the
    # model ignoring instructions.
    limit = 2048
    while len(cleaned) > 2:
        text = tokenizer.apply_chat_template(cleaned, tokenize=False, add_generation_prompt=True)
        if len(tokenizer(text, add_special_tokens=False)["input_ids"]) <= limit:
            break
        for index, message in enumerate(cleaned):
            if message["role"] != "system":
                del cleaned[index]
                break

    text = tokenizer.apply_chat_template(cleaned, tokenize=False, add_generation_prompt=True)
    ids = tokenizer(text, return_tensors="pt", add_special_tokens=False, truncation=True, max_length=limit)
    # Stop where an answer ends, not where the token budget ends.
    #
    # A small model rarely emits the chat end token cleanly, so without these it
    # keeps talking past the answer until it hits max_new_tokens — which reads as
    # the assistant "never finishing typing". Both the special token and the visible
    # markers are handled: the token stops generation, the markers trim text.
    stops = ["<|im_end|>", "<|endoftext|>", "\n\nuser>", "\n\nUser:", "\n\nQ:", "\n\nQuestion:"]
    eos_ids = [tokenizer.eos_token_id]
    im_end = tokenizer.convert_tokens_to_ids("<|im_end|>")
    if isinstance(im_end, int) and im_end >= 0 and im_end != tokenizer.unk_token_id:
        eos_ids.append(im_end)

    settings = dict(
        max_new_tokens=max(16, min(int(max_tokens or 250), 600)),
        do_sample=temperature > 0,
        temperature=max(temperature, 0.01),
        top_p=top_p,
        repetition_penalty=1.12,
        eos_token_id=eos_ids,
        stop_strings=stops,
        tokenizer=tokenizer,
        pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
    )

    if on_token is None:
        with STATE["lock"], torch.no_grad():
            out = model.generate(**ids, **settings)
        new = out[0][ids["input_ids"].shape[1]:]
        text = tokenizer.decode(new, skip_special_tokens=True)
    else:
        # Stream tokens as they are produced. Waiting for the whole answer is what
        # made a 4 tokens/second model feel broken: 20 s of silence, then text.
        from transformers import TextIteratorStreamer

        streamer = TextIteratorStreamer(
            tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=120
        )
        pieces = []

        def run():
            with torch.no_grad():
                model.generate(**ids, **settings, streamer=streamer)

        with STATE["lock"]:
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                for piece in streamer:
                    if piece:
                        pieces.append(piece)
                        on_token(piece)
            finally:
                thread.join(timeout=5)
        text = "".join(pieces)

    for marker in stops:
        cut = text.find(marker)
        if cut != -1:
            text = text[:cut]
    return text.strip()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        sys.stderr.write("  %s\n" % (fmt % a))

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/").endswith("/v1/models"):
            return self._json(200, {
                "object": "list",
                "data": [
                {"id": model_id, "object": "model", "owned_by": "javelin"}
                for model_id in STATE["adapters"]
            ],
            })
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            return self._json(400, {"error": {"message": f"bad request: {exc}"}})

        messages = body.get("messages") or []
        requested = body.get("model")
        model_id = requested if requested in STATE["adapters"] else STATE["default"]
        tools = body.get("tools") or []
        tool_specs = {}
        for entry in tools:
            fn = entry.get("function") or entry
            if fn.get("name"):
                props = (fn.get("parameters") or {}).get("properties") or {}
                tool_specs[fn["name"]] = list(props)
        tool_names = set(tool_specs)
        max_tokens = body.get("max_tokens") or body.get("max_completion_tokens")
        temperature = float(body.get("temperature", 0.7))
        top_p = float(body.get("top_p", 0.9))

        # Plain chat can start typing immediately; tool turns must be buffered because
        # the whole reply has to parse as one JSON object before anything can run.
        if body.get("stream") and not tools:
            created_stream = int(time.time())
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            def send_delta(piece):
                chunk = {
                    "id": "chatcmpl-local",
                    "object": "chat.completion.chunk",
                    "created": created_stream,
                    "model": model_id,
                    "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.flush()

            try:
                generate(messages, model_id, max_tokens, temperature, top_p, on_token=send_delta)
            except Exception as exc:
                send_delta(f"\n\nThe local model failed: {exc}")
            done_stream = {
                "id": "chatcmpl-local",
                "object": "chat.completion.chunk",
                "created": created_stream,
                "model": model_id,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(done_stream)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            try:
                self.connection.shutdown(1)
            except OSError:
                pass
            return

        started = time.time()
        try:
            text = generate(
                messages,
                model_id,
                max_tokens,
                temperature,
                top_p,
                tools=tools or None,
            )
        except Exception as exc:  # a real failure, reported as one
            return self._json(500, {"error": {"message": f"generation failed: {exc}"}})

        created = int(time.time())
        try:
            completion_tokens = len(STATE["models"][model_id][1](text, add_special_tokens=False)["input_ids"])
        except Exception:
            completion_tokens = 0

        if tools and os.environ.get("JAVELIN_DEBUG"):
            # ASCII only: the Windows console codec is cp1252 and raises on emoji,
            # which would kill the request from inside a debug line.
            safe = text[:400].encode("ascii", "replace").decode("ascii")
            print(f"\n[tool turn] model said: {safe!r}\n", flush=True)

        # A local model has no native tool channel. If it answered with a tool object,
        # turn that into a real OpenAI tool_call so the agent loop can act on it.
        action = extract_action(text, tool_names) if tools else None
        arguments = normalize_args(action[1], tool_specs.get(action[0], [])) if action else None
        if action and arguments is not None and str(arguments.get("path", "")).strip() in (".", "./", "/"):
            # Models say "." for "the project root"; the tool wants it omitted.
            arguments.pop("path", None)
        if not action:
            # Never show the user the protocol envelope instead of the answer.
            answer = extract_answer(text)
            if answer is not None:
                text = answer
        if action and arguments is not None:
            name = action[0]
            call_id = f"call_local_{created}_{int(time.time() * 1000) % 100000}"
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.close_connection = True
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                chunk = {
                    "id": "chatcmpl-local",
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_id,
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "tool_calls": [{
                                "index": 0,
                                "id": call_id,
                                "type": "function",
                                "function": {"name": name, "arguments": json.dumps(arguments)},
                            }],
                        },
                        "finish_reason": None,
                    }],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                done = {
                    "id": "chatcmpl-local",
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_id,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                }
                self.wfile.write(f"data: {json.dumps(done)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                try:
                    self.connection.shutdown(1)
                except OSError:
                    pass
                return
            return self._json(200, {
                "id": "chatcmpl-local",
                "object": "chat.completion",
                "created": created,
                "model": model_id,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            # The stream must END by closing the connection.
            #
            # With keep-alive the socket stays open after `[DONE]`, so a client that
            # waits for the response body to finish — which is how a fetch reader
            # works — waits forever and shows the assistant as still typing. Sending
            # `Connection: close` and telling the handler to close is what makes the
            # end of the answer observable.
            self.send_header("Connection", "close")
            self.close_connection = True
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # Emit in small pieces so the IDE renders progressively instead of
            # waiting for the whole answer.
            step = 24
            for i in range(0, len(text), step):
                chunk = {
                    "id": "chatcmpl-local",
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_id,
                    "choices": [{"index": 0, "delta": {"content": text[i:i + step]}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.flush()
            done = {
                "id": "chatcmpl-local",
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_id,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            # Half-close the write side so the client sees EOF immediately rather
            # than waiting for a socket timeout.
            try:
                self.wfile.flush()
                self.connection.shutdown(1)
            except OSError:
                pass
            return

        self._json(200, {
            "id": "chatcmpl-local",
            "object": "chat.completion",
            "created": created,
            "model": model_id,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": completion_tokens,
                "total_tokens": completion_tokens,
                "elapsed_seconds": round(time.time() - started, 2),
            },
        })


def already_serving(host, port, timeout=1.5):
    """Is a Javelin server already answering on this port? Not just any process."""
    import json as _json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{host}:{port}/v1/models", timeout=timeout) as r:
            return "javelin-knowledge" in _json.dumps(_json.loads(r.read().decode("utf-8")))
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="HuggingFaceTB/SmolLM2-135M-Instruct",
                    help="overridden by the adapter's own recorded base when one exists")
    ap.add_argument("--adapter", default=None,
                    help="override the adapter directory served as javelin-knowledge")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    adapters = {model_id: directory for model_id, directory in MODEL_DIRS.items() if os.path.isdir(directory)}
    if args.adapter:
        adapters["javelin-knowledge"] = args.adapter
    if not adapters:
        print("No trained adapters found. Run:  npm run train:knowledge:run", flush=True)
        sys.exit(1)
    STATE["adapters"] = adapters
    if STATE["default"] not in adapters:
        STATE["default"] = next(iter(adapters))

    # If a previous run is still holding the port, that is not a crash — the model
    # is already being served. Say so and exit 0 instead of raising WinError 10048,
    # which reads as a failure and sends people looking for a second machine.
    if already_serving(args.host, args.port):
        print(
            f"A Javelin model server is already running on http://{args.host}:{args.port}/v1 — reusing it.\n"
            "Stop that one first if you want to load different weights:  "
            f"netstat -ano | findstr :{args.port}",
            flush=True,
        )
        return

    # Bind before loading weights: a port conflict should cost two seconds, not two
    # gigabytes of model download and RAM.
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer.daemon_threads = True
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(
            f"Could not bind {args.host}:{args.port} ({exc}).\n"
            f"Something else is using that port and it is not a Javelin server.\n"
            f"Find it:  netstat -ano | findstr :{args.port}\n"
            f"Or pick another port:  npm run serve:knowledge -- --port {args.port + 1}",
            flush=True,
        )
        sys.exit(1)

    print("models    " + ", ".join(f"{model_id} ({path})" for model_id, path in adapters.items()), flush=True)
    try:
        ensure_model(STATE["default"])
    except Exception as exc:
        # Keep serving: the other model may still work, and a dead port is worse.
        print(f"warning: could not preload {STATE['default']}: {exc}", flush=True)
    print(f"listening on http://{args.host}:{args.port}/v1  (default: {STATE['default']})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
