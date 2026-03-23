---
name: background-music
description: Adding background music with audio ducking for voiceover in Remotion
metadata:
  tags: audio, music, ducking, voiceover, volume, background
---

# Background Music & Audio Ducking

## Adding Background Music

Loop background music throughout the entire video:

```tsx
import { Audio } from "@remotion/media";
import { staticFile } from "remotion";

export const BackgroundMusic: React.FC = () => {
  return <Audio src={staticFile("music/background.mp3")} volume={0.3} loop />;
};
```

## Audio Ducking

Lower background music volume when voiceover is playing, then restore it:

```tsx
import { Audio } from "@remotion/media";
import { staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "remotion";

export const AudioMix: React.FC<{
  voiceoverStart: number;
  voiceoverDuration: number;
}> = ({ voiceoverStart, voiceoverDuration }) => {
  const { durationInFrames } = useVideoConfig();
  const fadeFrames = 10;
  const voiceoverEnd = voiceoverStart + voiceoverDuration;

  return (
    <>
      <Audio
        src={staticFile("music/background.mp3")}
        volume={(f) =>
          interpolate(
            f,
            [
              0,
              voiceoverStart - fadeFrames,
              voiceoverStart,
              voiceoverEnd,
              voiceoverEnd + fadeFrames,
              durationInFrames,
            ],
            [0.4, 0.4, 0.08, 0.08, 0.4, 0.4],
            { extrapolateRight: "clamp" },
          )
        }
        loop
      />
    </>
  );
};
```

## Multi-Scene Ducking

For videos with multiple voiceover scenes, create ducking keyframes dynamically:

```tsx
import { Audio, Sequence } from "@remotion/media";
import { staticFile, useVideoConfig } from "remotion";
import { interpolate } from "remotion";

interface Scene {
  id: string;
  audioFile: string;
  startFrame: number;
  durationFrames: number;
}

export const MultiSceneAudio: React.FC<{ scenes: Scene[] }> = ({ scenes }) => {
  const { durationInFrames } = useVideoConfig();
  const fadeFrames = 10;

  // Build ducking keyframes from scenes
  const buildMusicVolume = (frame: number): number => {
    let volume = 0.4; // base volume
    for (const scene of scenes) {
      const start = scene.startFrame;
      const end = start + scene.durationFrames;
      if (frame >= start - fadeFrames && frame <= end + fadeFrames) {
        const duck = interpolate(
          frame,
          [start - fadeFrames, start, end, end + fadeFrames],
          [0.4, 0.08, 0.08, 0.4],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        volume = Math.min(volume, duck);
      }
    }
    return volume;
  };

  return (
    <>
      <Audio
        src={staticFile("music/background.mp3")}
        volume={(f) => buildMusicVolume(f)}
        loop
      />
      {scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationFrames}
        >
          <Audio src={staticFile(scene.audioFile)} volume={0.95} />
        </Sequence>
      ))}
    </>
  );
};
```

## Volume Guidelines

| Element | Volume | Notes |
|---------|--------|-------|
| Background music (solo) | 0.3–0.5 | When no voiceover is playing |
| Background music (ducked) | 0.05–0.10 | During voiceover |
| Voiceover | 0.9–1.0 | Always dominant |
| Sound effects | 0.3–0.5 | Brief, punchy |
| Fade duration | 8–15 frames | Smooth transitions (~0.3–0.5s at 30fps) |

## Tips

- **Always fade in music** at video start (silence → 0.4 over 30 frames) to avoid jarring starts
- **Fade out at video end** (0.4 → 0 over 30 frames)
- **Duck aggressively** — music at 0.08-0.10 during speech is usually right. If you can hear the music clearly during voiceover, it's too loud
- **Leave gaps** — 0.5-1s silence between voiceover scenes gives breathing room
- **Loop property** handles seamless repetition — no need to manually tile audio
