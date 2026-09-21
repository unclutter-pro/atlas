#!/usr/bin/env bash
# stt — Transcribe audio files to text via Whisper-compatible API
# Usage: stt [--language LANG] <file-or-url>
set -euo pipefail

CHUNK_SIZE=120   # seconds
OVERLAP=5        # seconds overlap between chunks
CONFIG_FILE="${HOME}/config.yml"

die() { echo "ERROR: $*" >&2; exit 1; }

# Read STT config: env var > config.yml > default
resolve_stt_url() {
  # Check both ATLAS_STT_URL (Unclutter cluster convention) and STT_URL
  if [[ -n "${ATLAS_STT_URL:-}" ]]; then
    echo "$ATLAS_STT_URL"
    return
  fi
  if [[ -n "${STT_URL:-}" ]]; then
    echo "$STT_URL"
    return
  fi

  # Parse config.yml for stt.url
  if [[ -f "$CONFIG_FILE" ]] && command -v python3 >/dev/null 2>&1; then
    local url
    url=$(python3 -c "
import yaml, sys
try:
    with open('$CONFIG_FILE') as f:
        cfg = yaml.safe_load(f) or {}
    stt = cfg.get('stt', {})
    if not stt.get('enabled', True):
        sys.exit(1)
    print(stt.get('url', ''))
except:
    pass
" 2>/dev/null)
    if [[ -n "$url" ]]; then
      echo "$url"
      return
    fi
  fi

  echo "http://stt:5092/v1/audio/transcriptions"
}

STT_URL=$(resolve_stt_url)
language=""
file=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --language|-l) language="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: stt [--language LANG] <audio-file-or-url>"
      echo ""
      echo "Transcribe audio to text using the STT API."
      echo "Supports: wav, mp3, ogg, m4a, aac, flac, webm, mp4"
      echo ""
      echo "Options:"
      echo "  --language, -l  Language hint (e.g. 'de', 'en')"
      echo "  --help, -h      Show this help"
      echo ""
      echo "STT endpoint: $STT_URL"
      exit 0
      ;;
    *) file="$1"; shift ;;
  esac
done

[[ -z "$file" ]] && die "No audio file specified. Usage: stt <file-or-url>"
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is required but not installed"

# Download URL if needed
if [[ "$file" =~ ^https?:// ]]; then
  tmpfile=$(mktemp --suffix=.audio)
  trap "rm -f '$tmpfile'" EXIT
  echo "Downloading $file..." >&2
  curl -fsSL -o "$tmpfile" "$file" || die "Failed to download $file"
  file="$tmpfile"
fi

[[ -f "$file" ]] || die "File not found: $file"

# Convert to WAV (16kHz mono)
wavfile=$(mktemp --suffix=.wav)
cleanup_files=("$wavfile")
[[ -n "${tmpfile:-}" ]] && cleanup_files+=("$tmpfile")
trap 'rm -f "${cleanup_files[@]}"' EXIT

ffmpeg -i "$file" -ar 16000 -ac 1 -y "$wavfile" 2>/dev/null \
  || die "ffmpeg conversion failed"

# Get duration
duration=$(ffprobe -v quiet -print_format json -show_format "$wavfile" 2>/dev/null \
  | python3 -c "import json,sys; print(float(json.load(sys.stdin)['format']['duration']))" 2>/dev/null \
  || echo "0")

transcribe_chunk() {
  local chunk_file="$1"
  local extra_args=""
  [[ -n "$language" ]] && extra_args="-F language=$language"

  response=$(curl -fsS -X POST "$STT_URL" \
    -F "file=@${chunk_file}" \
    -F "response_format=json" \
    $extra_args 2>&1) || die "STT API request failed"

  echo "$response" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if not isinstance(data.get('text'), str):
        raise ValueError('STT response has no text field')
    print(data['text'])
except:
    sys.exit(1)
" 2>/dev/null || die "Failed to parse STT response: $response"
}

# Short audio: single request
if python3 -c "import sys; sys.exit(not (float(sys.argv[1]) < int(sys.argv[2])))" "$duration" "$CHUNK_SIZE"; then
  transcribe_chunk "$wavfile"
  exit 0
fi

# Long audio: split into overlapping chunks
echo "Audio is ${duration}s — splitting into ${CHUNK_SIZE}s chunks..." >&2
full_text=""
start=0

while python3 -c "import sys; sys.exit(not (float(sys.argv[1]) < float(sys.argv[2])))" "$start" "$duration"; do
  chunk=$(mktemp --suffix=.wav)
  cleanup_files+=("$chunk")

  ffmpeg -i "$wavfile" -ss "$start" -t "$CHUNK_SIZE" -y "$chunk" 2>/dev/null

  chunk_text=$(transcribe_chunk "$chunk")
  if [[ -n "$chunk_text" ]]; then
    [[ -n "$full_text" ]] && full_text+=" "
    full_text+="$chunk_text"
  fi

  start=$((start + CHUNK_SIZE - OVERLAP))
done

echo "$full_text"
