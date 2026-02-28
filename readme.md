# Claude Code Statusline Setup

![screenshot](./res/screenshot_iterm.png)

#### Requirements
- a Nerd Font(v3.0 or greater) (optional, but needed to display some icons)

> [1] move `statusline.sh` into `~/.claude` path

> [2] ~/.claude/settings.json

```json
"statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
},
```

> [3] chmod +x statusline.sh

> [4] enjoy!