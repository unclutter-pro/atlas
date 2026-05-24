# FFmpeg EDL Render Recipes

Detailed FFmpeg patterns for rendering an Edit Decision List (EDL) into a final video, used by the `video-edit` skill.

## EDL schema (canonical)

```json
{
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "clips": [
    {
      "src": "clip_01.mp4",
      "in_seconds": 0.00,
      "out_seconds": 1.30,
      "fade_in_ms": 0,
      "fade_out_ms": 30,
      "speed": 1.0,
      "color": {"saturation": 1.05, "contrast": 1.02}
    }
  ],
  "subtitles_srt": "subs.srt",
  "output": "final.mp4"
}
```

## Strategy 1 — Concat demuxer + filter_complex (preferred)

Build per-clip pre-cuts as intermediate files, then concat.

```bash
# Step 1: cut each EDL entry with frame-accurate seek and re-encode
for i, clip in enumerate(edl.clips):
  ffmpeg -ss $clip.in_seconds -to $clip.out_seconds \
         -i $clip.src \
         -c:v libx264 -preset slow -crf 18 \
         -c:a aac -b:a 192k \
         -af "afade=in:st=0:d=$(clip.fade_in_ms/1000),afade=out:st=$(clip.out_seconds-clip.in_seconds-clip.fade_out_ms/1000):d=$(clip.fade_out_ms/1000)" \
         segment_$i.mp4

# Step 2: write playlist.txt
echo "file 'segment_0.mp4'" > playlist.txt
echo "file 'segment_1.mp4'" >> playlist.txt
# ...

# Step 3: concat without re-encoding (fast)
ffmpeg -f concat -safe 0 -i playlist.txt \
       -vf "subtitles=subs.srt:force_style='FontName=Inter,FontSize=24'" \
       -c:a copy \
       final.mp4
```

## Strategy 2 — Single filter_complex (faster, harder to debug)

```bash
ffmpeg \
  -i clip_01.mp4 \
  -i clip_02.mp4 \
  -filter_complex "\
    [0:v]trim=start=0:end=1.3,setpts=PTS-STARTPTS[v0];\
    [0:a]atrim=start=0:end=1.3,asetpts=PTS-STARTPTS,afade=out:st=1.27:d=0.03[a0];\
    [0:v]trim=start=1.89:end=12.4,setpts=PTS-STARTPTS,fade=in:0:1[v1];\
    [0:a]atrim=start=1.89:end=12.4,asetpts=PTS-STARTPTS,afade=in:st=0:d=0.03[a1];\
    [v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]" \
  -map "[outv]" -map "[outa]" \
  -c:v libx264 -preset slow -crf 18 \
  -c:a aac \
  final.mp4
```

Use Strategy 2 only if you have ≤5 segments. For more, Strategy 1 is more maintainable.

## SRT generation from EDL + transcript

```python
def edl_to_srt(edl, transcripts):
    """Generate SRT with cumulative output timestamps."""
    srt_lines = []
    out_t = 0.0
    for i, clip in enumerate(edl["clips"]):
        words = [w for w in transcripts[clip["src"]]
                 if clip["in_seconds"] <= w["start"] < clip["out_seconds"]]
        if not words:
            out_t += clip["out_seconds"] - clip["in_seconds"]
            continue

        # Group ~3-5 words per subtitle line
        for chunk_start in range(0, len(words), 4):
            chunk = words[chunk_start:chunk_start + 4]
            local_start = chunk[0]["start"] - clip["in_seconds"]
            local_end = chunk[-1]["end"] - clip["in_seconds"]
            srt_start = format_srt_time(out_t + local_start)
            srt_end = format_srt_time(out_t + local_end)
            text = " ".join(w["word"] for w in chunk)
            srt_lines.append(f"{len(srt_lines) + 1}\n{srt_start} --> {srt_end}\n{text}\n\n")

        out_t += clip["out_seconds"] - clip["in_seconds"]

    return "".join(srt_lines)

def format_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")
```

## Color grade per segment

`-vf "eq=saturation=1.05:contrast=1.02:brightness=0.02"` applied per segment in Strategy 1.

## Audio normalization

Run `loudnorm` filter once at the end to even out perceived loudness across segments:

```bash
ffmpeg -i final.mp4 -af "loudnorm=I=-16:LRA=11:TP=-1.5" final_normalized.mp4
```

EBU R128 target is `I=-23`, but `-16` works better for YouTube/Social viewing.

## Watermark / logo overlay

```bash
ffmpeg -i final.mp4 -i logo.png \
  -filter_complex "[1:v]scale=120:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20" \
  -c:a copy final_branded.mp4
```

## Performance notes

- `-preset slow` + `-crf 18` is the sweet spot for delivery quality. `-preset ultrafast` for previews.
- Always re-encode in Strategy 1 step 1, then `-c:a copy` in step 3 to avoid double-transcode.
- For long videos (>5 min), use `-tune film` for better x264 motion handling.
- GPU encode via `-c:v h264_nvenc` (NVIDIA) or `-c:v h264_videotoolbox` (macOS) — 5-10× faster but slightly lower quality at same CRF.
