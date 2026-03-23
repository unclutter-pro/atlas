# Command Reference

Complete reference for all browser commands. For quick start and common patterns, see SKILL.md.

## Navigation

```bash
browser open <url>      # Navigate to URL (aliases: goto, navigate)
                              # Supports: https://, http://, file://, about:, data://
                              # Auto-prepends https:// if no protocol given
browser back            # Go back
browser forward         # Go forward
browser reload          # Reload page
browser close           # Close browser (aliases: quit, exit)
browser connect 9222    # Connect to browser via CDP port
```

## Snapshot (page analysis)

```bash
browser snapshot            # Full accessibility tree
browser snapshot -i         # Interactive elements only (recommended)
browser snapshot -c         # Compact output
browser snapshot -d 3       # Limit depth to 3
browser snapshot -s "#main" # Scope to CSS selector
```

## Interactions (use @refs from snapshot)

```bash
browser click @e1           # Click
browser click @e1 --new-tab # Click and open in new tab
browser dblclick @e1        # Double-click
browser focus @e1           # Focus element
browser fill @e2 "text"     # Clear and type
browser type @e2 "text"     # Type without clearing
browser press Enter         # Press key (alias: key)
browser press Control+a     # Key combination
browser keydown Shift       # Hold key down
browser keyup Shift         # Release key
browser hover @e1           # Hover
browser check @e1           # Check checkbox
browser uncheck @e1         # Uncheck checkbox
browser select @e1 "value"  # Select dropdown option
browser select @e1 "a" "b"  # Select multiple options
browser scroll down 500     # Scroll page (default: down 300px)
browser scrollintoview @e1  # Scroll element into view (alias: scrollinto)
browser drag @e1 @e2        # Drag and drop
browser upload @e1 file.pdf # Upload files
```

## Get Information

```bash
browser get text @e1        # Get element text
browser get html @e1        # Get innerHTML
browser get value @e1       # Get input value
browser get attr @e1 href   # Get attribute
browser get title           # Get page title
browser get url             # Get current URL
browser get cdp-url         # Get CDP WebSocket URL
browser get count ".item"   # Count matching elements
browser get box @e1         # Get bounding box
browser get styles @e1      # Get computed styles (font, color, bg, etc.)
```

## Check State

```bash
browser is visible @e1      # Check if visible
browser is enabled @e1      # Check if enabled
browser is checked @e1      # Check if checked
```

## Screenshots and PDF

```bash
browser screenshot          # Save to temporary directory
browser screenshot path.png # Save to specific path
browser screenshot --full   # Full page
browser pdf output.pdf      # Save as PDF
```

## Video Recording

```bash
browser record start ./demo.webm    # Start recording
browser click @e1                   # Perform actions
browser record stop                 # Stop and save video
browser record restart ./take2.webm # Stop current + start new
```

## Wait

```bash
browser wait @e1                     # Wait for element
browser wait 2000                    # Wait milliseconds
browser wait --text "Success"        # Wait for text (or -t)
browser wait --url "**/dashboard"    # Wait for URL pattern (or -u)
browser wait --load networkidle      # Wait for network idle (or -l)
browser wait --fn "window.ready"     # Wait for JS condition (or -f)
```

## Mouse Control

```bash
browser mouse move 100 200      # Move mouse
browser mouse down left         # Press button
browser mouse up left           # Release button
browser mouse wheel 100         # Scroll wheel
```

## Semantic Locators (alternative to refs)

```bash
browser find role button click --name "Submit"
browser find text "Sign In" click
browser find text "Sign In" click --exact      # Exact match only
browser find label "Email" fill "user@test.com"
browser find placeholder "Search" type "query"
browser find alt "Logo" click
browser find title "Close" click
browser find testid "submit-btn" click
browser find first ".item" click
browser find last ".item" click
browser find nth 2 "a" hover
```

## Browser Settings

```bash
browser set viewport 1920 1080          # Set viewport size
browser set viewport 1920 1080 2        # 2x retina (same CSS size, higher res screenshots)
browser set device "iPhone 14"          # Emulate device
browser set geo 37.7749 -122.4194       # Set geolocation (alias: geolocation)
browser set offline on                  # Toggle offline mode
browser set headers '{"X-Key":"v"}'     # Extra HTTP headers
browser set credentials user pass       # HTTP basic auth (alias: auth)
browser set media dark                  # Emulate color scheme
browser set media light reduced-motion  # Light mode + reduced motion
```

## Cookies and Storage

```bash
browser cookies                     # Get all cookies
browser cookies set name value      # Set cookie
browser cookies clear               # Clear cookies
browser storage local               # Get all localStorage
browser storage local key           # Get specific key
browser storage local set k v       # Set value
browser storage local clear         # Clear all
```

## Network

```bash
browser network route <url>              # Intercept requests
browser network route <url> --abort      # Block requests
browser network route <url> --body '{}'  # Mock response
browser network unroute [url]            # Remove routes
browser network requests                 # View tracked requests
browser network requests --filter api    # Filter requests
```

## Tabs and Windows

```bash
browser tab                 # List tabs
browser tab new [url]       # New tab
browser tab 2               # Switch to tab by index
browser tab close           # Close current tab
browser tab close 2         # Close tab by index
browser window new          # New window
```

## Frames

```bash
browser frame "#iframe"     # Switch to iframe by CSS selector
browser frame @e3           # Switch to iframe by element ref
browser frame main          # Back to main frame
```

### Iframe support

Iframes are detected automatically during snapshots. When the main-frame snapshot runs, `Iframe` nodes are resolved and their content is inlined beneath the iframe element in the output (one level of nesting; iframes within iframes are not expanded).

```bash
browser snapshot -i
# @e3 [Iframe] "payment-frame"
#   @e4 [input] "Card number"
#   @e5 [button] "Pay"

# Interact directly — refs inside iframes already work
browser fill @e4 "4111111111111111"
browser click @e5

# Or switch frame context for scoped snapshots
browser frame @e3               # Switch using element ref
browser snapshot -i             # Snapshot scoped to that iframe
browser frame main              # Return to main frame
```

The `frame` command accepts:
- **Element refs** — `frame @e3` resolves the ref to an iframe element
- **CSS selectors** — `frame "#payment-iframe"` finds the iframe by selector
- **Frame name/URL** — matches against the browser's frame tree

## Dialogs

```bash
browser dialog accept [text]  # Accept dialog
browser dialog dismiss        # Dismiss dialog
```

## JavaScript

```bash
browser eval "document.title"          # Simple expressions only
browser eval -b "<base64>"             # Any JavaScript (base64 encoded)
browser eval --stdin                   # Read script from stdin
```

Use `-b`/`--base64` or `--stdin` for reliable execution. Shell escaping with nested quotes and special characters is error-prone.

```bash
# Base64 encode your script, then:
browser eval -b "ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW3NyYyo9Il9uZXh0Il0nKQ=="

# Or use stdin with heredoc for multiline scripts:
cat <<'EOF' | browser eval --stdin
const links = document.querySelectorAll('a');
Array.from(links).map(a => a.href);
EOF
```

## State Management

```bash
browser state save auth.json    # Save cookies, storage, auth state
browser state load auth.json    # Restore saved state
```

## Global Options

```bash
browser --session <name> ...    # Isolated browser session
browser --json ...              # JSON output for parsing
browser --headed ...            # Show browser window (not headless)
browser --full ...              # Full page screenshot (-f)
browser --cdp <port> ...        # Connect via Chrome DevTools Protocol
browser -p <provider> ...       # Cloud browser provider (--provider)
browser --proxy <url> ...       # Use proxy server
browser --proxy-bypass <hosts>  # Hosts to bypass proxy
browser --headers <json> ...    # HTTP headers scoped to URL's origin
browser --executable-path <p>   # Custom browser executable
browser --extension <path> ...  # Load browser extension (repeatable)
browser --ignore-https-errors   # Ignore SSL certificate errors
browser --help                  # Show help (-h)
browser --version               # Show version (-V)
browser <command> --help        # Show detailed help for a command
```

## Debugging

```bash
browser --headed open example.com   # Show browser window
browser --cdp 9222 snapshot         # Connect via CDP port
browser connect 9222                # Alternative: connect command
browser console                     # View console messages
browser console --clear             # Clear console
browser errors                      # View page errors
browser errors --clear              # Clear errors
browser highlight @e1               # Highlight element
browser inspect                     # Open Chrome DevTools for this session
browser trace start                 # Start recording trace
browser trace stop trace.zip        # Stop and save trace
browser profiler start              # Start Chrome DevTools profiling
browser profiler stop trace.json    # Stop and save profile
```

## Environment Variables

```bash
AGENT_BROWSER_SESSION="mysession"            # Default session name
AGENT_BROWSER_EXECUTABLE_PATH="/path/chrome" # Custom browser path
AGENT_BROWSER_EXTENSIONS="/ext1,/ext2"       # Comma-separated extension paths
AGENT_BROWSER_PROVIDER="browserbase"         # Cloud browser provider
AGENT_BROWSER_STREAM_PORT="9223"             # WebSocket streaming port
AGENT_BROWSER_HOME="/path/to/browser"  # Custom install location
```
