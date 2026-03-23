---
name: browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(browser:*), Bash(agent-browser:*)
---

# Browser Automation with browser

The `browser` CLI uses Chrome/Chromium via CDP directly. It is powered by [agent-browser](https://github.com/vercel-labs/agent-browser).

## Core Workflow

Every browser automation follows this pattern:

1. **Navigate**: `browser open <url>`
2. **Snapshot**: `browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
browser open https://example.com/form
browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

browser fill @e1 "user@example.com"
browser fill @e2 "password123"
browser click @e3
browser wait --load networkidle
browser snapshot -i  # Check result
```

## Command Chaining

Commands can be chained with `&&` in a single shell invocation. The browser persists between commands via a background daemon, so chaining is safe and more efficient than separate calls.

```bash
# Chain open + wait + snapshot in one call
browser open https://example.com && browser wait --load networkidle && browser snapshot -i

# Chain multiple interactions
browser fill @e1 "user@example.com" && browser fill @e2 "password123" && browser click @e3

# Navigate and capture
browser open https://example.com && browser wait --load networkidle && browser screenshot page.png
```

**When to chain:** Use `&&` when you don't need to read the output of an intermediate command before proceeding (e.g., open + wait + screenshot). Run commands separately when you need to parse output between steps (e.g., snapshot to discover refs, then interact using those refs).

## Handling Authentication

When automating a site that requires login, choose the approach that fits:

**Option 1: Import auth from the user's browser (fastest for one-off tasks)**

```bash
browser --auto-connect state save ./auth.json
browser --state ./auth.json open https://app.example.com/dashboard
```

**Option 2: Persistent profile (simplest for recurring tasks)**

```bash
browser --profile ~/.myapp open https://app.example.com/login
# ... fill credentials, submit ...
# All future runs: already authenticated
browser --profile ~/.myapp open https://app.example.com/dashboard
```

**Option 3: Session name (auto-save/restore cookies + localStorage)**

```bash
browser --session-name myapp open https://app.example.com/login
# ... login flow ...
browser close  # State auto-saved
# Next time: state auto-restored
browser --session-name myapp open https://app.example.com/dashboard
```

**Option 4: Auth vault (credentials stored encrypted, login by name)**

```bash
echo "$PASSWORD" | browser auth save myapp --url https://app.example.com/login --username user --password-stdin
browser auth login myapp
```

**Option 5: State file (manual save/load)**

```bash
browser state save ./auth.json
browser state load ./auth.json
browser open https://app.example.com/dashboard
```

See [references/authentication.md](references/authentication.md) for OAuth, 2FA, cookie-based auth, and token refresh patterns.

## Credentials & Secrets Convention

**Never read secret files directly into your context.** Always pipe them via shell commands so credentials stay out of the conversation.

```bash
# Correct: pipe secret into a command (value never visible to the agent)
cat ~/secrets/github_pat | browser auth save github --url https://github.com/login --username max --password-stdin

# Correct: use in a command without reading
curl -H "Authorization: Bearer $(cat ~/secrets/api_key)" https://api.example.com

# Wrong: reading the file content into the conversation
# cat ~/secrets/api_key  ← NEVER do this
```

**For browser logins, prefer the auth vault.** When saving credentials for a website:

1. Store them directly in the auth vault (not in ~/secrets)
2. Create a reference file in ~/secrets so it's discoverable:

```bash
# Save login to auth vault
echo "$PASSWORD" | browser auth save servicename --url https://app.example.com/login --username user --password-stdin

# Create reference (not the actual secret)
echo "Managed by browser auth vault. Use: browser auth login servicename" > ~/secrets/servicename-browser
```

This way `ls ~/secrets/` shows all available credentials at a glance, but browser logins are managed securely by browser.

## Essential Commands

```bash
# Navigation
browser open <url>              # Navigate (aliases: goto, navigate)
browser close                   # Close browser

# Snapshot
browser snapshot -i             # Interactive elements with refs (recommended)
browser snapshot -i -C          # Include cursor-interactive elements
browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
browser click @e1               # Click element
browser click @e1 --new-tab     # Click and open in new tab
browser fill @e2 "text"         # Clear and type text
browser type @e2 "text"         # Type without clearing
browser select @e1 "option"     # Select dropdown option
browser check @e1               # Check checkbox
browser press Enter             # Press key
browser keyboard type "text"    # Type at current focus
browser keyboard inserttext "text"  # Insert without key events
browser scroll down 500         # Scroll page
browser scroll down 500 --selector "div.content"  # Scroll within container

# Get information
browser get text @e1            # Get element text
browser get url                 # Get current URL
browser get title               # Get page title
browser get cdp-url             # Get CDP WebSocket URL

# Wait
browser wait @e1                # Wait for element
browser wait --load networkidle # Wait for network idle
browser wait --url "**/page"    # Wait for URL pattern
browser wait 2000               # Wait milliseconds
browser wait --text "Welcome"   # Wait for text to appear
browser wait --fn "!document.body.innerText.includes('Loading...')"  # Wait for text to disappear
browser wait "#spinner" --state hidden  # Wait for element to disappear

# Downloads
browser download @e1 ./file.pdf          # Click element to trigger download
browser wait --download ./output.zip     # Wait for any download to complete
browser --download-path ./downloads open <url>  # Set default download directory

# Network
browser network requests                 # Inspect tracked requests
browser network route "**/api/*" --abort  # Block matching requests
browser network har start                # Start HAR recording
browser network har stop ./capture.har   # Stop and save HAR file

# Viewport & Device Emulation
browser set viewport 1920 1080          # Set viewport size (default: 1280x720)
browser set viewport 1920 1080 2        # 2x retina
browser set device "iPhone 14"          # Emulate device

# Capture
browser screenshot              # Screenshot to temp dir
browser screenshot --full       # Full page screenshot
browser screenshot --annotate   # Annotated screenshot with numbered element labels
browser pdf output.pdf          # Save as PDF

# Clipboard
browser clipboard read          # Read text from clipboard
browser clipboard write "text"  # Write text to clipboard
browser clipboard copy          # Copy current selection
browser clipboard paste         # Paste from clipboard

# Diff (compare page states)
browser diff snapshot                          # Compare current vs last snapshot
browser diff snapshot --baseline before.txt    # Compare current vs saved file
browser diff screenshot --baseline before.png  # Visual pixel diff
browser diff url <url1> <url2>                 # Compare two pages
```

## Batch Execution

Execute multiple commands in a single invocation:

```bash
echo '[
  ["open", "https://example.com"],
  ["snapshot", "-i"],
  ["click", "@e1"],
  ["screenshot", "result.png"]
]' | browser batch --json

# Stop on first error
browser batch --bail < commands.json
```

## Common Patterns

### Form Submission

```bash
browser open https://example.com/signup
browser snapshot -i
browser fill @e1 "Jane Doe"
browser fill @e2 "jane@example.com"
browser select @e3 "California"
browser check @e4
browser click @e5
browser wait --load networkidle
```

### Data Extraction

```bash
browser open https://example.com/products
browser snapshot -i
browser get text @e5           # Get specific element text
browser get text body > page.txt  # Get all page text
browser snapshot -i --json     # JSON output for parsing
```

### Parallel Sessions

```bash
browser --session site1 open https://site-a.com
browser --session site2 open https://site-b.com
browser session list
```

### Working with Iframes

Iframe content is automatically inlined in snapshots. Refs inside iframes carry frame context, so you can interact with them directly.

```bash
browser open https://example.com/checkout
browser snapshot -i
# @e3 [input] "Card number" (inside iframe)
browser fill @e3 "4111111111111111"  # No frame switch needed
```

### Local Files (PDFs, HTML)

```bash
browser --allow-file-access open file:///path/to/document.pdf
browser screenshot output.png
```

### Visual Browser (Debugging)

```bash
browser --headed open https://example.com
browser highlight @e1
browser inspect
browser record start demo.webm
```

## Security

### Content Boundaries (Recommended for AI Agents)

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
browser snapshot
```

### Domain Allowlist

```bash
export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"
```

### Output Limits

```bash
export AGENT_BROWSER_MAX_OUTPUT=50000
```

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

## Annotated Screenshots (Vision Mode)

```bash
browser screenshot --annotate
# Output: [1] @e1 button "Submit", [2] @e2 link "Home", ...
browser click @e2
```

Use when: unlabeled icon buttons, visual layout verification, canvas/chart elements, spatial reasoning needed.

## Semantic Locators (Alternative to Refs)

```bash
browser find text "Sign In" click
browser find label "Email" fill "user@test.com"
browser find role button click --name "Submit"
browser find placeholder "Search" type "query"
browser find testid "submit-btn" click
```

## JavaScript Evaluation

```bash
# Simple expressions
browser eval 'document.title'

# Complex JS: use --stdin with heredoc (recommended)
browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF

# Base64 encoding (avoids all shell escaping issues)
browser eval -b "$(echo -n 'Array.from(document.querySelectorAll("a")).map(a => a.href)' | base64)"
```

## Session Management and Cleanup

Always close your browser session when done:

```bash
browser close                    # Close default session
browser --session agent1 close   # Close specific session
```

Auto-shutdown after inactivity:

```bash
AGENT_BROWSER_IDLE_TIMEOUT_MS=60000 browser open example.com
```

## Deep-Dive Documentation

| Reference                                                            | When to Use                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| [references/commands.md](references/commands.md)                     | Full command reference with all options                   |
| [references/snapshot-refs.md](references/snapshot-refs.md)           | Ref lifecycle, invalidation rules, troubleshooting        |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md)         | Login flows, OAuth, 2FA handling, state reuse             |
| [references/video-recording.md](references/video-recording.md)       | Recording workflows for debugging and documentation       |
| [references/profiling.md](references/profiling.md)                   | Chrome DevTools profiling for performance analysis        |
| [references/proxy-support.md](references/proxy-support.md)           | Proxy configuration, geo-testing, rotating proxies        |

## Ready-to-Use Templates

| Template                                                                 | Description                         |
| ------------------------------------------------------------------------ | ----------------------------------- |
| [templates/form-automation.sh](templates/form-automation.sh)             | Form filling with validation        |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) | Login once, reuse state             |
| [templates/capture-workflow.sh](templates/capture-workflow.sh)           | Content extraction with screenshots |
