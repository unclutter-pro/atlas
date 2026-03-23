# Video Recording

Capture browser automation as video for debugging, documentation, or verification.

**Related**: [commands.md](commands.md) for full command reference, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Basic Recording](#basic-recording)
- [Recording Commands](#recording-commands)
- [Use Cases](#use-cases)
- [Best Practices](#best-practices)
- [Output Format](#output-format)
- [Limitations](#limitations)

## Basic Recording

```bash
# Start recording
browser record start ./demo.webm

# Perform actions
browser open https://example.com
browser snapshot -i
browser click @e1
browser fill @e2 "test input"

# Stop and save
browser record stop
```

## Recording Commands

```bash
# Start recording to file
browser record start ./output.webm

# Stop current recording
browser record stop

# Restart with new file (stops current + starts new)
browser record restart ./take2.webm
```

## Use Cases

### Debugging Failed Automation

```bash
#!/bin/bash
# Record automation for debugging

browser record start ./debug-$(date +%Y%m%d-%H%M%S).webm

# Run your automation
browser open https://app.example.com
browser snapshot -i
browser click @e1 || {
    echo "Click failed - check recording"
    browser record stop
    exit 1
}

browser record stop
```

### Documentation Generation

```bash
#!/bin/bash
# Record workflow for documentation

browser record start ./docs/how-to-login.webm

browser open https://app.example.com/login
browser wait 1000  # Pause for visibility

browser snapshot -i
browser fill @e1 "demo@example.com"
browser wait 500

browser fill @e2 "password"
browser wait 500

browser click @e3
browser wait --load networkidle
browser wait 1000  # Show result

browser record stop
```

### CI/CD Test Evidence

```bash
#!/bin/bash
# Record E2E test runs for CI artifacts

TEST_NAME="${1:-e2e-test}"
RECORDING_DIR="./test-recordings"
mkdir -p "$RECORDING_DIR"

browser record start "$RECORDING_DIR/$TEST_NAME-$(date +%s).webm"

# Run test
if run_e2e_test; then
    echo "Test passed"
else
    echo "Test failed - recording saved"
fi

browser record stop
```

## Best Practices

### 1. Add Pauses for Clarity

```bash
# Slow down for human viewing
browser click @e1
browser wait 500  # Let viewer see result
```

### 2. Use Descriptive Filenames

```bash
# Include context in filename
browser record start ./recordings/login-flow-2024-01-15.webm
browser record start ./recordings/checkout-test-run-42.webm
```

### 3. Handle Recording in Error Cases

```bash
#!/bin/bash
set -e

cleanup() {
    browser record stop 2>/dev/null || true
    browser close 2>/dev/null || true
}
trap cleanup EXIT

browser record start ./automation.webm
# ... automation steps ...
```

### 4. Combine with Screenshots

```bash
# Record video AND capture key frames
browser record start ./flow.webm

browser open https://example.com
browser screenshot ./screenshots/step1-homepage.png

browser click @e1
browser screenshot ./screenshots/step2-after-click.png

browser record stop
```

## Output Format

- Default format: WebM (VP8/VP9 codec)
- Compatible with all modern browsers and video players
- Compressed but high quality

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
- Some headless environments may have codec limitations
