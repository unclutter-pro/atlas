# Audio, Voiceover & Music

## Basic Audio

```tsx
import { Audio, staticFile } from 'remotion';

// Background music
<Audio src={staticFile('audio/background.mp3')} volume={0.3} loop />

// Voiceover at specific time
<Sequence from={30} durationInFrames={120}>
  <Audio src={staticFile('audio/voiceover.mp3')} volume={1} />
</Sequence>
```

**Audio props:**
- `volume` — number (0-1) or function `(frame) => number`
- `loop` — repeat audio
- `playbackRate` — speed (0.5 = half, 2 = double)
- `muted` — mute without removing
- `startFrom` / `endAt` — trim in frames

## Audio Ducking

Lower background music when voiceover plays:

```tsx
const AudioMix: React.FC<{
  voiceoverStart: number;
  voiceoverDuration: number;
}> = ({ voiceoverStart, voiceoverDuration }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeFrames = 10; // fade duration

  const voiceoverEnd = voiceoverStart + voiceoverDuration;

  // Duck music: 0.4 → 0.08 during voiceover
  const musicVolume = interpolate(
    frame,
    [
      0,
      voiceoverStart - fadeFrames,
      voiceoverStart,
      voiceoverEnd,
      voiceoverEnd + fadeFrames,
      durationInFrames,
    ],
    [0.4, 0.4, 0.08, 0.08, 0.4, 0.4],
    { extrapolateRight: 'clamp' }
  );

  return (
    <>
      <Audio
        src={staticFile('audio/music.mp3')}
        volume={musicVolume}
        loop
      />
      <Sequence from={voiceoverStart} durationInFrames={voiceoverDuration}>
        <Audio src={staticFile('audio/voiceover.mp3')} volume={0.95} />
      </Sequence>
    </>
  );
};
```

## Multi-Scene Audio

For videos with scene-based voiceover, define timing configs:

```tsx
interface SceneTiming {
  id: string;
  audioFile: string;
  durationFrames: number;
}

const scenes: SceneTiming[] = [
  { id: 'intro', audioFile: 'audio/scene1.mp3', durationFrames: 150 },
  { id: 'demo', audioFile: 'audio/scene2.mp3', durationFrames: 300 },
  { id: 'outro', audioFile: 'audio/scene3.mp3', durationFrames: 120 },
];

const VideoWithScenes: React.FC = () => {
  let currentFrame = 0;

  return (
    <>
      <Audio src={staticFile('audio/music.mp3')} volume={0.1} loop />
      {scenes.map((scene) => {
        const from = currentFrame;
        currentFrame += scene.durationFrames;
        return (
          <Sequence key={scene.id} from={from} durationInFrames={scene.durationFrames}>
            <Audio src={staticFile(scene.audioFile)} volume={0.9} />
            {/* Scene visual component here */}
          </Sequence>
        );
      })}
    </>
  );
};
```

## ElevenLabs TTS Integration

### Setup

```bash
npm install elevenlabs
```

### Generate Voiceover Script

Create a generation script that produces audio files for each scene:

```typescript
// scripts/generate-voiceover.ts
import { ElevenLabsClient } from 'elevenlabs';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';

const client = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

interface Scene {
  id: string;
  text: string;
  voice?: string;
}

const scenes: Scene[] = [
  { id: 'scene1', text: 'Welcome to our product demo.' },
  { id: 'scene2', text: 'Watch how easy it is to get started.' },
  { id: 'scene3', text: 'Try it today — link in the description.' },
];

async function generateScene(scene: Scene) {
  const audio = await client.textToSpeech.convert('JBFqnCBsd6RMkjVDRZzb', {
    text: scene.text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.3,
    },
  });

  const output = createWriteStream(`public/audio/${scene.id}.mp3`);
  const readable = Readable.from(audio);
  readable.pipe(output);
  await new Promise((resolve) => output.on('finish', resolve));
  console.log(`Generated: ${scene.id}.mp3`);
}

async function main() {
  for (const scene of scenes) {
    await generateScene(scene);
  }
}

main();
```

### Popular Voices

| Voice ID | Name | Character |
|----------|------|-----------|
| `JBFqnCBsd6RMkjVDRZzb` | George | Warm British, narrator |
| `ErXwobaYiN019PkySvjV` | Antoni | Professional, warm |
| `VR6AewLTigWG4xSOukaG` | Arnold | Authoritative, deep |
| `TxGEqnHWrfWFTfGW9XjX` | Josh | Friendly, conversational |

### Get Audio Duration

After generating audio files, get their duration to sync with video:

```bash
# Using ffprobe
ffprobe -v error -show_entries format=duration -of csv=p=0 public/audio/scene1.mp3
```

```typescript
// In Node.js
import { execSync } from 'child_process';

function getAudioDuration(path: string): number {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`
  ).toString().trim();
  return parseFloat(result);
}

// Convert to frames
const fps = 30;
const durationSec = getAudioDuration('public/audio/scene1.mp3');
const durationFrames = Math.ceil(durationSec * fps);
```

## Workflow: Video with Voiceover

1. **Write scene scripts** — define text for each scene
2. **Generate audio** — run the TTS script: `bun scripts/generate-voiceover.ts`
3. **Get durations** — measure each audio file with ffprobe
4. **Update timing config** — set frame counts based on audio durations
5. **Build scenes** — create visual components synced to audio
6. **Add background music** — loop with ducking during voiceover
7. **Preview** — `npx remotion studio`
8. **Render** — `npx remotion render MyVideo output.mp4`

## Background Music Tips

- **Volume:** Background music at 0.05-0.15 during voiceover, 0.3-0.5 without
- **Style:** "Upbeat but not distracting" — corporate/tech tends toward ambient electronic
- **Fade in/out:** Always fade music at video start (0→0.4 over 30 frames) and end
- **Loop:** Most background tracks should `loop` — Remotion handles seamless looping
- **Speaking rate:** Target ~3 words/second for voiceover pacing
- **Gaps:** Leave 0.5-1 second gaps between scenes for breathing room

## Sound Effects

```tsx
// UI sound on action
<Sequence from={45} durationInFrames={30}>
  <Audio src={staticFile('audio/click.mp3')} volume={0.5} />
</Sequence>

// Whoosh on transition
<Sequence from={89} durationInFrames={20}>
  <Audio src={staticFile('audio/whoosh.mp3')} volume={0.3} />
</Sequence>
```

Place sound effects in `<Sequence>` blocks aligned with visual events for satisfying sync.
