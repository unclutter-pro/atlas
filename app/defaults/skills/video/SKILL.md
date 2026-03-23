---
name: video
description: "Use this skill whenever the user wants to create animated videos, motion graphics, screencasts, product demos, or explainer videos programmatically. Triggers include: any mention of 'video', 'animation', 'screencast', 'demo video', 'explainer', 'motion graphics', 'Remotion', or requests to produce MP4/WebM output with animated content. Also use when combining visuals with voiceover (ElevenLabs, TTS) or background music. Do NOT use for simple video file conversion, trimming, or ffmpeg-only tasks."
---

# Video Production with Remotion

Create animated videos, screencasts, and motion graphics programmatically using React Remotion. Combine with ElevenLabs TTS for voiceover and background music for professional results.

## Quick Reference

| Task | Guide |
|------|-------|
| Project setup & core APIs | This file |
| Animation patterns & effects | [references/animations.md](references/animations.md) |
| Audio, voiceover & music | [references/audio.md](references/audio.md) |

## Project Setup

```bash
# New project
npx create-video@latest

# Or add to existing project
npm install remotion @remotion/cli @remotion/transitions
```

### Project Structure

```
remotion/
  index.ts          # registerRoot(RemotionRoot)
  Root.tsx           # <Composition> registrations
  scenes/            # Individual scene components
public/
  audio/             # Music, voiceover files
  images/            # Static assets
```

### Entry Point

```ts
// remotion/index.ts
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
```

### Root Component

```tsx
// remotion/Root.tsx
import { Composition } from 'remotion';
import { MyVideo } from './scenes/MyVideo';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="MyVideo"
    component={MyVideo}
    durationInFrames={300}  // 10 seconds at 30fps
    fps={30}
    width={1920}
    height={1080}
  />
);
```

## Core APIs

### Frame & Config

```tsx
import { useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion';

const MyScene: React.FC = () => {
  const frame = useCurrentFrame();                    // current frame number
  const { width, height, fps, durationInFrames } = useVideoConfig();

  return <AbsoluteFill style={{ backgroundColor: '#111' }} />;
};
```

### interpolate() — Map Values

```tsx
import { interpolate, Easing } from 'remotion';

// Fade in over 30 frames
const opacity = interpolate(frame, [0, 30], [0, 1], {
  extrapolateRight: "clamp",
});

// Slide in from left
const translateX = interpolate(frame, [0, 30], [-100, 0], {
  extrapolateRight: "clamp",
  easing: Easing.out(Easing.cubic),
});

// Multi-point (fade in, hold, fade out)
const alpha = interpolate(frame, [0, 30, 90, 120], [0, 1, 1, 0]);
```

### spring() — Physics-Based

```tsx
import { spring } from 'remotion';

const scale = spring({
  frame,
  fps,
  config: { damping: 10, mass: 1, stiffness: 100 },
  durationInFrames: 40,
});

<div style={{ transform: `scale(${scale})` }}>
```

### Sequence — Time Shifting

```tsx
import { Sequence } from 'remotion';

// Children see frame 0 at the Sequence's `from`
<Sequence from={30} durationInFrames={60} name="Intro">
  <IntroScene />
</Sequence>
<Sequence from={90} durationInFrames={120} name="Main">
  <MainScene />
</Sequence>
```

### TransitionSeries — Scene Transitions

```tsx
import { TransitionSeries } from '@remotion/transitions';
import { slide } from '@remotion/transitions/slide';
import { fade } from '@remotion/transitions/fade';
import { linearTiming } from '@remotion/transitions';

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={90}>
    <Scene1 />
  </TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={slide({ direction: 'from-left' })}
    timing={linearTiming({ durationInFrames: 20 })}
  />
  <TransitionSeries.Sequence durationInFrames={120}>
    <Scene2 />
  </TransitionSeries.Sequence>
</TransitionSeries>
```

Total duration = `90 + 120 - 20 = 190` frames (transitions overlap).

## Rendering

```bash
# Render to MP4
npx remotion render MyVideo output.mp4

# With options
npx remotion render MyVideo output.mp4 \
  --codec h264 \
  --crf 18 \
  --concurrency 4

# Render a still frame (thumbnail)
npx remotion still MyVideo thumbnail.png --frame 60

# Audio only
npx remotion render MyVideo voiceover.mp3

# Preview in browser
npx remotion studio
```

**Codec options:** h264 (default, best compatibility), h265, vp8, vp9, prores (MOV)

**Key flags:**
- `--crf`: Quality (lower = better, 18 is visually lossless for h264)
- `--fps`: Override frame rate
- `--scale`: Multiply dimensions (0.5 for half-size preview)
- `--concurrency`: Parallel rendering threads
- `--props`: Pass JSON config to composition

## Video Architecture

Structure videos as **scenes** — modular React components:

```
remotion/
  Root.tsx
  scenes/
    Intro.tsx         # Title card, branding
    Problem.tsx       # Problem statement
    Solution.tsx      # Product demo / screencast
    Features.tsx      # Feature highlights
    CTA.tsx           # Call to action
  components/
    TypingText.tsx    # Reusable typing animation
    CodeBlock.tsx     # Animated code reveal
    FadeIn.tsx        # Fade-in wrapper
```

### Scene Template

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

export const IntroScene: React.FC<{ title: string }> = ({ title }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      backgroundColor: '#0f172a',
      justifyContent: 'center',
      alignItems: 'center',
    }}>
      <h1 style={{
        color: 'white',
        fontSize: 72,
        fontFamily: 'Inter, sans-serif',
        opacity,
      }}>
        {title}
      </h1>
    </AbsoluteFill>
  );
};
```

## Common Video Formats

| Use Case | Resolution | FPS | Duration |
|----------|-----------|-----|----------|
| Product demo | 1920x1080 | 30 | 60-120s |
| Social media (landscape) | 1920x1080 | 30 | 15-60s |
| Social media (portrait) | 1080x1920 | 30 | 15-60s |
| Square (Instagram) | 1080x1080 | 30 | 15-60s |
| Screencast | 1920x1080 | 30 | 120-300s |
| GIF preview | 800x600 | 15 | 3-10s |

## Design Guidelines

- **Keep it simple.** Terminal typing, text on screen, images in frames — these work clean
- **Don't overload animations.** Complex overlapping animations get messy fast
- **Structure as scenes.** Each scene = one idea, one visual concept
- **Vary layouts.** Alternate between text-heavy and visual slides
- **Use consistent typography.** Pick 1-2 fonts, stick with them
- **Dark backgrounds work well** for tech content and screencasts
- **Leave breathing room.** 48-64px margins from edges
- **Timing matters.** ~3 words/second for voiceover, hold text 2-3 seconds minimum

## Dependencies

- `remotion`, `@remotion/cli` — Core + rendering
- `@remotion/transitions` — Scene transitions
- `@remotion/animation-utils` — CSS animation helpers (optional)
- `react`, `react-dom` — Required peer deps
