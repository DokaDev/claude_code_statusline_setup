# Claude Code Statusline Setup

<img width="564" height="132" alt="image" src="https://github.com/user-attachments/assets/b5457da5-6f02-4c85-be25-63244c38ee79" />


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
