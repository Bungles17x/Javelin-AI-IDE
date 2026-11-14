#!/usr/bin/env bash
# Start the Javelin model server.
#
# Refuses to run without an API key: an open endpoint that spends GPU money is how
# a hobby project becomes someone else's free inference provider.
set -euo pipefail

: "${JAVELIN_API_KEY:?set JAVELIN_API_KEY — every request must present this as a Bearer token}"
MODEL_ID="${MODEL_ID:-/models/javelin-cloud}"
SERVED_NAME="${SERVED_NAME:-javelin-cloud}"
PORT="${PORT:-8000}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
# 14B in bf16 is ~28GB of weights: it needs a 40GB card, or two 24GB cards here.
TP_SIZE="${TP_SIZE:-1}"

echo "serving ${MODEL_ID} as '${SERVED_NAME}' on 0.0.0.0:${PORT}"

exec python3 -m vllm.entrypoints.openai.api_server \
  --model "${MODEL_ID}" \
  --served-model-name "${SERVED_NAME}" \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --dtype bfloat16 \
  --max-model-len "${MAX_MODEL_LEN}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
  --tensor-parallel-size "${TP_SIZE}" \
  --api-key "${JAVELIN_API_KEY}" \
  --disable-log-requests
