# Javelin Cloud model — your weights, your endpoint
# ================================================
#
# vLLM serves an OpenAI-compatible API, so the IDE needs no special client: it talks
# to https://your-host/v1 exactly like it talks to any hosted provider. Nothing in
# this path calls another vendor's model — the weights in the container are yours.
#
# Build:
#   docker build -t javelin-cloud ./cloud-model
#
# Run locally (if you have a GPU box):
#   docker run --gpus all -p 8000:8000 \
#     -e MODEL_ID=/models/javelin-cloud \
#     -e JAVELIN_API_KEY=change-me \
#     -v "$PWD/models/javelin-cloud:/models/javelin-cloud:ro" \
#     javelin-cloud

FROM vllm/vllm-openai:latest

ENV HF_HOME=/models \
    MODEL_ID=/models/javelin-cloud \
    SERVED_NAME=javelin-cloud \
    MAX_MODEL_LEN=8192 \
    GPU_MEMORY_UTILIZATION=0.90 \
    PORT=8000

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/start.sh"]
