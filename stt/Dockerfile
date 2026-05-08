# Atlas STT sidecar — Parakeet TDT 0.6B v3 with FP16 weights.
#
# Builds on top of the upstream achetronic/parakeet binary (Go, ONNX Runtime,
# ffmpeg pre-installed) and replaces the baked-in INT8 model with the FP16
# variant from grikdotnet/parakeet-tdt-0.6b-fp16 on Hugging Face.
#
# Why FP16 instead of upstream FP32 or INT8:
#   - INT8 has a TDT-decoder bug that returns empty output on non-English
#     speech (verified on a 27 s German Signal voice message).
#   - FP32 transcribes correctly but the upstream image is ~2.5 GB and peaks
#     at ~4-5 GB RAM during inference.
#   - FP16 weights are half the size on disk (~1.2 GB) and produce identical
#     transcriptions to FP32 across all 25 supported languages. ONNX Runtime
#     on CPU still upcasts the weights internally during inference, so peak
#     RAM during a single transcription is still ~3-4 GB — but idle and
#     image footprint are noticeably smaller than FP32.

FROM ghcr.io/achetronic/parakeet:0.3.0-int8

USER root

# Replace the int8 weights with fp16 weights, renamed to the unsuffixed
# filenames the parakeet binary's loader falls back to when *.int8.onnx is
# absent (see internal/asr/transcriber.go in the upstream repo).
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -f /models/encoder-model.int8.onnx /models/decoder_joint-model.int8.onnx && \
    curl -fL --retry 3 -o /models/encoder-model.onnx \
      "https://huggingface.co/grikdotnet/parakeet-tdt-0.6b-fp16/resolve/main/encoder-model.fp16.onnx" && \
    curl -fL --retry 3 -o /models/decoder_joint-model.onnx \
      "https://huggingface.co/grikdotnet/parakeet-tdt-0.6b-fp16/resolve/main/decoder_joint-model.fp16.onnx" && \
    apt-get remove -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/* && \
    chown -R 1000:1000 /models

USER 1000

# Inherit ENTRYPOINT/CMD/EXPOSE/healthcheck from the upstream image:
#   ENTRYPOINT ["/app/parakeet"]
#   CMD        ["-port", "5092", "-models", "/models"]
#   EXPOSE     5092
