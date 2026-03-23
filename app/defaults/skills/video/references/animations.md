# Animation Patterns & Effects

## Easing Functions

Use with `interpolate()` for non-linear motion:

```tsx
import { Easing } from 'remotion';

// Smooth deceleration (most common for entrances)
easing: Easing.out(Easing.cubic)

// Smooth acceleration (for exits)
easing: Easing.in(Easing.cubic)

// Both (for move/transform)
easing: Easing.inOut(Easing.cubic)

// Custom bezier (CSS transition-timing-function equivalent)
easing: Easing.bezier(0.25, 0.1, 0.25, 1)

// Bounce
easing: Easing.out(Easing.bounce)

// Elastic
easing: Easing.out(Easing.elastic(1))
```

**Available:** `linear`, `ease`, `quad`, `cubic`, `poly(n)`, `sin`, `circle`, `exp`, `elastic()`, `bounce`, `back()`

## Text Animations

### Typing Effect

```tsx
const TypingText: React.FC<{ text: string; startFrame?: number }> = ({
  text,
  startFrame = 0,
}) => {
  const frame = useCurrentFrame();
  const elapsed = frame - startFrame;
  const charsPerFrame = 0.4; // ~12 chars/sec at 30fps
  const charsToShow = Math.floor(
    interpolate(elapsed, [0, text.length / charsPerFrame], [0, text.length], {
      extrapolateRight: 'clamp',
      extrapolateLeft: 'clamp',
    })
  );
  const showCursor = Math.round(frame / 15) % 2 === 0;

  return (
    <span style={{ fontFamily: 'monospace', fontSize: 24 }}>
      {text.slice(0, charsToShow)}
      <span style={{ opacity: showCursor ? 1 : 0 }}>|</span>
    </span>
  );
};
```

### Word-by-Word Reveal

```tsx
const WordReveal: React.FC<{ text: string; framesPerWord?: number }> = ({
  text,
  framesPerWord = 8,
}) => {
  const frame = useCurrentFrame();
  const words = text.split(' ');

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {words.map((word, i) => {
        const delay = i * framesPerWord;
        const opacity = interpolate(frame, [delay, delay + 10], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const y = interpolate(frame, [delay, delay + 10], [20, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        });
        return (
          <span key={i} style={{ opacity, transform: `translateY(${y}px)` }}>
            {word}
          </span>
        );
      })}
    </div>
  );
};
```

### Character Stagger

```tsx
const StaggerText: React.FC<{ text: string; staggerFrames?: number }> = ({
  text,
  staggerFrames = 2,
}) => {
  const frame = useCurrentFrame();

  return (
    <span>
      {text.split('').map((char, i) => {
        const delay = i * staggerFrames;
        const spring_val = spring({
          frame: frame - delay,
          fps: 30,
          config: { damping: 12, stiffness: 200 },
        });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: spring_val,
              transform: `translateY(${(1 - spring_val) * 30}px)`,
            }}
          >
            {char === ' ' ? '\u00A0' : char}
          </span>
        );
      })}
    </span>
  );
};
```

## Layout Animations

### Fade In with Slide

```tsx
const FadeSlideIn: React.FC<{
  children: React.ReactNode;
  direction?: 'up' | 'down' | 'left' | 'right';
  delay?: number;
  distance?: number;
}> = ({ children, direction = 'up', delay = 0, distance = 40 }) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - delay);

  const opacity = interpolate(elapsed, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  const translate = interpolate(elapsed, [0, 20], [distance, 0], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const transforms: Record<string, string> = {
    up: `translateY(${translate}px)`,
    down: `translateY(${-translate}px)`,
    left: `translateX(${translate}px)`,
    right: `translateX(${-translate}px)`,
  };

  return (
    <div style={{ opacity, transform: transforms[direction] }}>
      {children}
    </div>
  );
};
```

### Scale Pop

```tsx
const ScalePop: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const scale = spring({
    frame: frame - delay,
    fps: 30,
    config: { damping: 8, stiffness: 200 },
  });

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>
      {children}
    </div>
  );
};
```

## Code Block Animation

```tsx
const AnimatedCodeBlock: React.FC<{
  code: string;
  language?: string;
  charsPerFrame?: number;
}> = ({ code, charsPerFrame = 0.8 }) => {
  const frame = useCurrentFrame();
  const charsToShow = Math.floor(frame * charsPerFrame);
  const visibleCode = code.slice(0, charsToShow);

  return (
    <div style={{
      backgroundColor: '#1e1e2e',
      borderRadius: 12,
      padding: '24px 32px',
      fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
      fontSize: 18,
      lineHeight: 1.6,
      color: '#cdd6f4',
      whiteSpace: 'pre',
      overflow: 'hidden',
    }}>
      {visibleCode}
      <span style={{
        opacity: Math.round(frame / 15) % 2,
        color: '#89b4fa',
      }}>
        |
      </span>
    </div>
  );
};
```

## Number Counter

```tsx
const Counter: React.FC<{
  from?: number;
  to: number;
  suffix?: string;
  prefix?: string;
  durationFrames?: number;
}> = ({ from = 0, to, suffix = '', prefix = '', durationFrames = 60 }) => {
  const frame = useCurrentFrame();
  const value = interpolate(frame, [0, durationFrames], [from, to], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {prefix}{Math.round(value).toLocaleString()}{suffix}
    </span>
  );
};
```

## Progress Bar

```tsx
const ProgressBar: React.FC<{
  progress: number; // 0-1
  color?: string;
  height?: number;
}> = ({ progress, color = '#3b82f6', height = 8 }) => {
  const frame = useCurrentFrame();
  const width = spring({
    frame,
    fps: 30,
    config: { damping: 15, stiffness: 80 },
    from: 0,
    to: progress * 100,
  });

  return (
    <div style={{
      width: '100%',
      height,
      backgroundColor: '#1e293b',
      borderRadius: height / 2,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${width}%`,
        height: '100%',
        backgroundColor: color,
        borderRadius: height / 2,
      }} />
    </div>
  );
};
```

## Transition Catalog

Available from `@remotion/transitions`:

| Transition | Import | Effect |
|-----------|--------|--------|
| `fade()` | `@remotion/transitions/fade` | Crossfade |
| `slide()` | `@remotion/transitions/slide` | Slide in direction |
| `wipe()` | `@remotion/transitions/wipe` | Wipe reveal |
| `flip()` | `@remotion/transitions/flip` | 3D flip |
| `clockWipe()` | `@remotion/transitions/clock-wipe` | Clock sweep |
| `none()` | `@remotion/transitions/none` | Cut (no animation) |

```tsx
// slide with direction
slide({ direction: 'from-left' })  // from-left, from-right, from-top, from-bottom

// Custom timing
linearTiming({ durationInFrames: 20 })
springTiming({ config: { damping: 12 } })
```

## Best Practices

- **Use `extrapolateRight: "clamp"`** on almost every interpolation — prevents values overshooting
- **Prefer `spring()`** for interactive-feeling motion (buttons, popups, emphasis)
- **Prefer `interpolate()` with easing** for smooth continuous motion (slides, fades)
- **Stagger delays** make groups feel organic — 3-5 frame offsets between items
- **Don't animate everything at once** — sequential reveals guide attention
- **Keep animations under 1 second** (30 frames at 30fps) — longer feels sluggish
- **Test at 1x speed** — animations that look good frame-by-frame can feel wrong in realtime
