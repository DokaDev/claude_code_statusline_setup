# Claude Code Statusline Setup

<img width="573" height="136" alt="image" src="https://github.com/user-attachments/assets/92602e38-ba58-4200-ae0f-a5275a4ab593" />


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
