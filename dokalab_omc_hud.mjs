#!/usr/bin/env node
/**
 * statusline-combined-v2.mjs
 * Combined Claude Code statusline: Nerd Font icons + OMC orchestration state.
 * v2: Merges official OMC HUD features (permissions, PRD, skills, todos,
 *     agent tree, reasoning tokens, session summary, update notification)
 *     with the original gradient bar / git / runtime / cost design.
 * No external dependencies — only node:* built-ins.
 */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";

// ─── ANSI Colours ─────────────────────────────────────────────────────────────
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";
const WHITE = "\x1b[97m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ─── Nerd Font Icons ──────────────────────────────────────────────────────────
const ICON_WRENCH = String.fromCodePoint(0xf1322); // 󱌢 tool calls
const ICON_TIMER = String.fromCodePoint(0xf13ab); // 󱎫 session
const ICON_TOKEN = String.fromCodePoint(0xf0284); // 󰊄 tokens
const ICON_ROBOT = String.fromCodePoint(0xf167a); // 󱙺 agents
const ICON_FLASH = String.fromCodePoint(0xf0329); // 󰌩 skills
const ICON_SPEED = String.fromCodePoint(0xf04c5); // 󰓅 rate limit
const ICON_PROGRESS = String.fromCodePoint(0xf070e); // 󰜎 background
const ICON_COST = String.fromCodePoint(0xf0857); // 󰡗 cost
const ICON_THINKING = String.fromCodePoint(0xf0803); // 󰠃 thinking
const ICON_LOCK = String.fromCodePoint(0xf033e); // 󰌾 permission/approve
const ICON_TODO = String.fromCodePoint(0xf0306); // 󰌆 todos
const ICON_STORY = String.fromCodePoint(0xf0219); // 󰈙 PRD story
const ICON_UPDATE = String.fromCodePoint(0xf040d); // 󰐍 update available
// ICON_CLOCK removed — prompt time feature removed (polling incompatible)
const ICON_SUMMARY = String.fromCodePoint(0xf021b); // 󰈛 session summary
const ICON_KEY = String.fromCodePoint(0xf0340); // 󰍀 api key source

// 256-colour smooth gradient for context bar (cyan → green → yellow → orange → red)
const BAR_GRADIENT = [51, 50, 49, 48, 47, 46, 82, 118, 154, 190, 226, 226, 220, 214, 214, 208, 208, 202, 196, 196].map((c) => `\x1b[38;5;${c}m`);
const CEMPTY = "\x1b[38;5;237m";

const SEP = `${GRAY}|${RESET}`;

// ─── Permission Tools (from official OMC) ────────────────────────────────────
const PERMISSION_TOOLS = ["Edit", "Write", "Bash", "proxy_Edit", "proxy_Write", "proxy_Bash"];
const PERMISSION_THRESHOLD_MS = 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, cwd, timeout = 2000) {
    try {
        return execSync(cmd, { cwd, timeout, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
    } catch {
        return "";
    }
}

function readJson(path) {
    try {
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
}

function fileAgeMins(path) {
    try {
        return (Date.now() - statSync(path).mtimeMs) / 60000;
    } catch {
        return Infinity;
    }
}

function fileMtime(path) {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return null;
    }
}

function formatDuration(ms) {
    const totalMins = Math.floor(ms / 60000);
    if (totalMins < 60) return `${totalMins}m`;
    const totalHours = Math.floor(totalMins / 60);
    if (totalHours < 24) {
        const m = totalMins % 60;
        return m > 0 ? `${totalHours}h${m}m` : `${totalHours}h`;
    }
    const d = Math.floor(totalHours / 24);
    const h = totalHours % 24;
    return h > 0 ? `${d}d${h}h` : `${d}d`;
}

function formatResetIn(isoString, cycleName) {
    try {
        let resetAt = new Date(isoString).getTime();
        const now = Date.now();
        if (resetAt <= now) {
            const cycleMs = cycleName === "wk" ? 7 * 24 * 60 * 60 * 1000 : cycleName === "mo" ? 30 * 24 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000;
            while (resetAt <= now) resetAt += cycleMs;
        }
        return formatDuration(resetAt - now);
    } catch {
        return "";
    }
}

function fmtTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
}

// ─── OMC Version ──────────────────────────────────────────────────────────────
function getOmcVersion() {
    try {
        const cacheDir = join(homedir(), ".claude", "plugins", "cache", "omc", "oh-my-claudecode");
        if (!existsSync(cacheDir)) return null;
        const entries = readdirSync(cacheDir).filter((e) => /^\d+\.\d+\.\d+/.test(e));
        if (!entries.length) return null;
        entries.sort((a, b) => {
            const pa = a.split(".").map(Number);
            const pb = b.split(".").map(Number);
            for (let i = 0; i < 3; i++) {
                if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
            }
            return 0;
        });
        return entries[0];
    } catch {
        return null;
    }
}

// ─── Update Check ─────────────────────────────────────────────────────────────
function checkUpdateAvailable(installedVersion) {
    if (!installedVersion) return null;
    try {
        const cachePath = join(homedir(), ".claude", "plugins", "oh-my-claudecode", ".update-cache.json");
        const data = readJson(cachePath);
        const age = data?.timestamp ? Date.now() - data.timestamp : Infinity;
        if (data?.latestVersion && age < 3600_000) {
            return data.latestVersion !== installedVersion ? data.latestVersion : null;
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Context Bar ──────────────────────────────────────────────────────────────
const BAR_GRADIENT_BG = [51, 50, 49, 48, 47, 46, 82, 118, 154, 190, 226, 226, 220, 214, 214, 208, 208, 202, 196, 196].map((c) => `\x1b[48;5;${c}m`);
const CEMPTY_BG = "\x1b[48;5;237m";

function buildBar(pct) {
    const BAR_WIDTH = 20;
    const filledTenths = Math.floor((pct * BAR_WIDTH * 10) / 100);
    const fullBlocks = Math.floor(filledTenths / 10);
    const frac = filledTenths % 10;

    const pctText = `${pct}%`;
    const textStart = Math.floor((BAR_WIDTH - pctText.length) / 2);
    const textEnd = textStart + pctText.length;

    let bar = "";
    for (let i = 0; i < BAR_WIDTH; i++) {
        const isFilled = i < fullBlocks || (i === fullBlocks && frac > 0);
        const isText = i >= textStart && i < textEnd;

        if (isText) {
            const ch = pctText[i - textStart];
            if (isFilled) {
                const bg = BAR_GRADIENT_BG[i] || BAR_GRADIENT_BG[BAR_GRADIENT_BG.length - 1];
                bar += `${bg}${BOLD}\x1b[30m${ch}${RESET}`;
            } else {
                bar += `${CEMPTY_BG}${BOLD}\x1b[97m${ch}${RESET}`;
            }
        } else {
            const col = BAR_GRADIENT[i] || BAR_GRADIENT[BAR_GRADIENT.length - 1];
            if (i < fullBlocks) bar += `${col}█`;
            else if (i === fullBlocks && frac >= 5) bar += `${col}▌`;
            else bar += `${CEMPTY}░`;
        }
    }
    bar += RESET;
    return { bar };
}

// ─── OMC State ────────────────────────────────────────────────────────────────
const STATE_MAX_AGE_MINS = 120;

function resolveStatePath(baseDir, sessionId, filename) {
    if (sessionId) {
        const p = join(baseDir, "state", "sessions", sessionId, filename);
        if (existsSync(p)) return p;
    }
    const p2 = join(baseDir, "state", filename);
    if (existsSync(p2)) return p2;
    const p3 = join(baseDir, filename);
    if (existsSync(p3)) return p3;
    return null;
}

function loadState(path) {
    if (!path) return null;
    if (fileAgeMins(path) > STATE_MAX_AGE_MINS) return null;
    const data = readJson(path);
    if (!data || !data.active) return null;
    return data;
}

// ─── Enhanced Transcript Parsing ──────────────────────────────────────────────
function parseTranscript(transcriptPath) {
    const result = {
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        sessionTotalTokens: 0,
        agentCount: 0,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCount: 0,
        thinkingActive: false,
        lastSkill: null,
        todos: [],
        pendingPermission: null,
        agents: [],
        promptTime: null,
        _lastThinkingSeen: null,
        _sessionStart: null,
    };

    try {
        if (!transcriptPath || !existsSync(transcriptPath)) return result;

        // Always read full file for accurate token/cost accumulation
        const allLines = readFileSync(transcriptPath, "utf8").split("\n");

        // For state parsing (agents, thinking, skills, etc.), use tail for large files
        const stat = statSync(transcriptPath);
        const MAX_TAIL = 512 * 1024;
        let lines;

        if (stat.size > MAX_TAIL) {
            const startOffset = Math.max(0, stat.size - MAX_TAIL);
            const fd = openSync(transcriptPath, "r");
            const buf = Buffer.alloc(stat.size - startOffset);
            const bytesRead = readSync(fd, buf, 0, buf.length, startOffset);
            closeSync(fd);
            lines = buf.toString("utf8", 0, bytesRead).split("\n");
            if (startOffset > 0) lines.shift();
        } else {
            lines = allLines;
        }

        // First pass: accumulate tokens/cost from ALL lines
        for (const line of allLines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.costUSD) result.costUSD += entry.costUSD;
                if (entry.type === "assistant" && entry.message?.usage) {
                    const u = entry.message.usage;
                    result.inputTokens += u.input_tokens || 0;
                    result.outputTokens += u.output_tokens || 0;
                    result.cacheCreateTokens += u.cache_creation_input_tokens || 0;
                    result.cacheReadTokens += u.cache_read_input_tokens || 0;
                    result.reasoningTokens += u.reasoning_tokens || u.output_tokens_details?.reasoning_tokens || 0;
                }
                if (!result._sessionStart && entry.timestamp) {
                    result._sessionStart = new Date(entry.timestamp);
                }
            } catch {}
        }

        const agentMap = new Map();
        const pendingPermissionMap = new Map();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();

                // Prompt submission time
                if (entry.type === "human" || entry.type === "user") {
                    result.promptTime = timestamp;
                }

                // Thinking/reasoning detection
                if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
                    for (const block of entry.message.content) {
                        if (block.type === "thinking" || block.type === "reasoning") {
                            result._lastThinkingSeen = entry.timestamp || Date.now();
                        }
                    }
                }

                // Token usage — accumulated in first pass (allLines), skip here

                // Agent tracking (legacy system events)
                if (entry.type === "system" && entry.subtype === "agent_start" && entry.agent_id) {
                    agentMap.set(entry.agent_id, {
                        id: entry.agent_id,
                        type: "unknown",
                        status: "running",
                        startTime: timestamp,
                        description: "",
                    });
                }

                // Process content blocks
                const content = entry.message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "tool_use" && block.name) {
                            result.toolCallCount++;

                            const name = block.name;
                            const nameLower = name.toLowerCase();

                            // Agent invocations
                            if (name === "Agent" || name === "Task" || name === "proxy_Task" || nameLower.includes("agent")) {
                                result.agentCallCount++;
                                if (agentMap.size < 100) {
                                    agentMap.set(block.id, {
                                        id: block.id,
                                        type: block.input?.subagent_type || "general",
                                        model: block.input?.model,
                                        description: block.input?.description || "",
                                        status: "running",
                                        startTime: timestamp,
                                    });
                                }
                            }

                            // Skill invocations
                            if (name === "Skill" || name === "proxy_Skill" || block.input?.skill) {
                                result.skillCount++;
                                if (block.input?.skill) {
                                    result.lastSkill = {
                                        name: block.input.skill,
                                        args: block.input.args,
                                        timestamp,
                                    };
                                }
                            }

                            // TodoWrite
                            if (name === "TodoWrite" || name === "proxy_TodoWrite") {
                                if (Array.isArray(block.input?.todos)) {
                                    result.todos = block.input.todos.map((t) => ({
                                        content: t.content,
                                        status: t.status,
                                    }));
                                }
                            }

                            // Permission tracking
                            if (PERMISSION_TOOLS.includes(name)) {
                                pendingPermissionMap.set(block.id, {
                                    toolName: name.replace("proxy_", ""),
                                    timestamp,
                                });
                            }
                        }

                        // tool_result → mark agent completed, clear permission
                        if (block.type === "tool_result" && block.tool_use_id) {
                            pendingPermissionMap.delete(block.tool_use_id);
                            const agent = agentMap.get(block.tool_use_id);
                            if (agent) {
                                const blockContent = block.content;
                                const isBg = typeof blockContent === "string" ? blockContent.includes("Async agent launched") : Array.isArray(blockContent) && blockContent.some((c) => c.text?.includes("Async agent launched"));
                                if (!isBg) {
                                    agent.status = "completed";
                                    agent.endTime = timestamp;
                                }
                            }
                        }
                    }
                }

                // Top-level tool_use
                if (entry.type === "tool_use") {
                    result.toolCallCount++;
                    const name = (entry.name || "").toLowerCase();
                    if (name === "agent" || name === "taskcreate" || name.includes("subagent")) {
                        if (agentMap.size < 100) {
                            agentMap.set(entry.id || name, {
                                id: entry.id,
                                type: "unknown",
                                status: "running",
                                startTime: timestamp,
                                description: "",
                            });
                        }
                    }
                    if (name === "skill" || entry.input?.skill) {
                        result.skillCount++;
                    }
                }
            } catch {
                /* skip malformed lines */
            }
        }

        // Finalise agents
        const now = Date.now();
        const STALE_MS = 30 * 60 * 1000;
        for (const agent of agentMap.values()) {
            if (agent.status === "running") {
                const runTime = now - agent.startTime.getTime();
                if (runTime > STALE_MS) {
                    agent.status = "completed";
                    agent.endTime = new Date(agent.startTime.getTime() + STALE_MS);
                }
            }
        }

        const running = [...agentMap.values()].filter((a) => a.status === "running");
        const completed = [...agentMap.values()].filter((a) => a.status === "completed");
        result.agents = [...running, ...completed.slice(-(10 - running.length))].slice(0, 10);
        result.agentCount = agentMap.size;

        // Pending permission
        for (const [, perm] of pendingPermissionMap) {
            if (now - perm.timestamp.getTime() <= PERMISSION_THRESHOLD_MS) {
                result.pendingPermission = perm;
                break;
            }
        }

        // Thinking active
        if (result._lastThinkingSeen) {
            const age = now - new Date(result._lastThinkingSeen).getTime();
            result.thinkingActive = age <= 30_000;
        }

        // Session total
        result.sessionTotalTokens = result.inputTokens + result.outputTokens;
    } catch {
        /* graceful fallback */
    }
    return result;
}

// ─── Rate Limit Cache ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 90_000;

function fetchAndCacheRateLimit() {
    const cachePath = join(homedir(), ".claude", "plugins", "oh-my-claudecode", ".usage-cache.json");
    try {
        let raw = null;
        try {
            const serviceName = process.env.CLAUDE_CONFIG_DIR ? `Claude Code-credentials-${createHash("sha256").update(process.env.CLAUDE_CONFIG_DIR).digest("hex").slice(0, 8)}` : "Claude Code-credentials";
            raw = execSync(`/usr/bin/security find-generic-password -s "${serviceName}" -w`, { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })
                .toString()
                .trim();
        } catch {
            /* keychain not available */
        }

        if (!raw) {
            const credFile = join(homedir(), ".claude", ".credentials.json");
            if (existsSync(credFile)) raw = readFileSync(credFile, "utf8").trim();
        }
        if (!raw) return null;

        let creds;
        try {
            creds = JSON.parse(raw);
        } catch {
            return null;
        }

        let accessToken = creds?.claudeAiOauth?.accessToken || creds?.accessToken || null;
        const refreshToken = creds?.claudeAiOauth?.refreshToken || creds?.refreshToken || null;
        const expiresAt = creds?.claudeAiOauth?.expiresAt || creds?.expiresAt || null;

        if (!accessToken) return null;

        const OAUTH_CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

        if (expiresAt && Date.now() >= expiresAt && refreshToken) {
            try {
                const refreshResponse = execFileSync("curl", [
                    "-s", "--max-time", "10", "-X", "POST",
                    "https://platform.claude.com/v1/oauth/token",
                    "-H", "Content-Type: application/x-www-form-urlencoded",
                    "--data-urlencode", "grant_type=refresh_token",
                    "--data-urlencode", `refresh_token=${refreshToken}`,
                    "--data-urlencode", `client_id=${OAUTH_CLIENT_ID}`,
                ], { timeout: 12000, encoding: "utf8" });
                const refreshData = JSON.parse(refreshResponse);
                if (refreshData?.access_token) accessToken = refreshData.access_token;
            } catch {
                /* use existing */
            }
        }

        const responseStr = execFileSync("curl", [
            "-s", "--max-time", "10",
            "-H", `Authorization: Bearer ${accessToken}`,
            "-H", "anthropic-beta: oauth-2025-04-20",
            "-H", "Content-Type: application/json",
            "https://api.anthropic.com/api/oauth/usage",
        ], { timeout: 12000, encoding: "utf8" });

        const response = JSON.parse(responseStr);
        if (!response || response.error) return null;

        const now = Date.now();
        const cacheData = {
            timestamp: now,
            data: {
                fiveHourPercent: Math.round(response.five_hour?.utilization ?? 0),
                weeklyPercent: Math.round(response.seven_day?.utilization ?? 0),
                fiveHourResetsAt: response.five_hour?.resets_at || null,
                weeklyResetsAt: response.seven_day?.resets_at || null,
                sonnetWeeklyPercent: Math.round(response.seven_day_sonnet?.utilization ?? 0),
                sonnetWeeklyResetsAt: response.seven_day_sonnet?.resets_at || null,
            },
            error: false,
            source: "anthropic",
            lastSuccessAt: now,
        };

        const cacheDir = dirname(cachePath);
        mkdirSync(cacheDir, { recursive: true });
        const tmpPath = `${cachePath}.tmp.${process.pid}`;
        writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2), "utf8");
        renameSync(tmpPath, cachePath);

        return cacheData.data;
    } catch {
        return null;
    }
}

function loadRateLimit() {
    const cachePath = join(homedir(), ".claude", "plugins", "oh-my-claudecode", ".usage-cache.json");
    try {
        const data = readJson(cachePath);
        const age = data?.timestamp ? Date.now() - data.timestamp : Infinity;
        if (data?.data && age < POLL_INTERVAL_MS) return data.data;
        const fresh = fetchAndCacheRateLimit();
        if (fresh) return fresh;
        if (data?.data && age < 24 * 60 * 60 * 1000) return data.data;
        return null;
    } catch {
        return null;
    }
}

// ─── Session Duration ─────────────────────────────────────────────────────────
function getSessionDurationMs(omcBase, transcriptPath) {
    try {
        const hudStatePath = join(omcBase, "state", "hud-state.json");
        const hudState = readJson(hudStatePath);
        if (hudState?.sessionStartTimestamp) {
            return Date.now() - new Date(hudState.sessionStartTimestamp).getTime();
        }
        if (transcriptPath) {
            const mtime = fileMtime(transcriptPath);
            if (mtime) return Date.now() - mtime;
        }
    } catch {
        /* graceful */
    }
    return null;
}

// ─── Background Tasks ─────────────────────────────────────────────────────────
function getBackgroundTaskCount(omcBase) {
    try {
        const hudStatePath = join(omcBase, "state", "hud-state.json");
        const hudState = readJson(hudStatePath);
        if (Array.isArray(hudState?.backgroundTasks)) return hudState.backgroundTasks.length;
    } catch {
        /* graceful */
    }
    return 0;
}

// ─── PRD Story ────────────────────────────────────────────────────────────────
function loadPrdStory(omcBase, sessionId) {
    const path = resolveStatePath(omcBase, sessionId, "prd-state.json");
    if (!path) return null;
    const data = readJson(path);
    if (!data?.storyId) return null;
    return {
        storyId: data.storyId,
        completed: data.completedTasks || 0,
        total: data.totalTasks || 0,
    };
}

// ─── API Key Source ────────────────────────────────────────────────────────────
function detectApiKeySource(cwd) {
    try {
        // 1. Project-level config
        if (cwd) {
            const projectSettings = join(cwd, ".claude", "settings.local.json");
            if (existsSync(projectSettings)) {
                const data = JSON.parse(readFileSync(projectSettings, "utf8"));
                if (data?.env && "ANTHROPIC_API_KEY" in data.env) return "project";
            }
        }
        // 2. Global config
        const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
        const globalSettings = join(configDir, "settings.json");
        if (existsSync(globalSettings)) {
            const data = JSON.parse(readFileSync(globalSettings, "utf8"));
            if (data?.env && "ANTHROPIC_API_KEY" in data.env) return "global";
        }
        // 3. Environment variable
        if (process.env.ANTHROPIC_API_KEY) return "env";
        // 4. OAuth (default for Claude Code logged-in users)
        return "oauth";
    } catch {
        return null;
    }
}

// ─── Session Summary ──────────────────────────────────────────────────────────
function loadSessionSummary(omcBase, sessionId) {
    const path = resolveStatePath(omcBase, sessionId, "session-summary.json");
    if (!path) return null;
    const data = readJson(path);
    return data?.summary || null;
}

// ─── Agent Tree Renderer ──────────────────────────────────────────────────────
const MODEL_TIER = { opus: "O", sonnet: "s", haiku: "h" };
const MODEL_COL = { opus: MAGENTA, sonnet: CYAN, haiku: GREEN };

function renderAgentTree(agents, maxLines = 4) {
    const running = agents.filter((a) => a.status === "running");
    if (!running.length) return [];
    const lines = [];
    const shown = running.slice(0, maxLines);
    for (let i = 0; i < shown.length; i++) {
        const a = shown[i];
        const isLast = i === shown.length - 1 && running.length <= maxLines;
        const prefix = isLast ? "└─" : "├─";
        const tier = MODEL_TIER[a.model] || "s";
        const col = MODEL_COL[a.model] || CYAN;
        const dur = a.startTime ? formatDuration(Date.now() - a.startTime.getTime()) : "";
        const desc = (a.description || a.type || "").slice(0, 40);
        lines.push(`${GRAY}${prefix}${RESET} ${col}${tier}${RESET} ${WHITE}${desc}${RESET} ${GRAY}${dur}${RESET}`);
    }
    if (running.length > maxLines) {
        lines.push(`${GRAY}└─ +${running.length - maxLines} more${RESET}`);
    }
    return lines;
}

// ─── Todo Renderer ────────────────────────────────────────────────────────────
function renderTodos(todos) {
    if (!todos.length) return null;
    const done = todos.filter((t) => t.status === "completed").length;
    const inProg = todos.filter((t) => t.status === "in_progress").length;
    const total = todos.length;
    const col = done === total ? GREEN : inProg > 0 ? CYAN : YELLOW;
    let str = `${col}${ICON_TODO}${RESET} ${WHITE}${done}/${total}${RESET}`;
    const current = todos.find((t) => t.status === "in_progress");
    if (current?.content) {
        const label = current.content.slice(0, 30);
        str += ` ${GRAY}${label}${current.content.length > 30 ? "…" : ""}${RESET}`;
    }
    return str;
}

// ─── Rate Colour (14-step gradient) ───────────────────────────────────────────
function rateCol(u) {
    if (u <= 10) return "\x1b[38;5;51m";
    if (u <= 20) return "\x1b[38;5;50m";
    if (u <= 30) return "\x1b[38;5;49m";
    if (u <= 40) return "\x1b[38;5;48m";
    if (u <= 50) return "\x1b[38;5;82m";
    if (u <= 55) return "\x1b[38;5;118m";
    if (u <= 60) return "\x1b[38;5;154m";
    if (u <= 65) return "\x1b[38;5;190m";
    if (u <= 70) return "\x1b[38;5;226m";
    if (u <= 75) return "\x1b[38;5;220m";
    if (u <= 80) return "\x1b[38;5;214m";
    if (u <= 85) return "\x1b[38;5;208m";
    if (u <= 90) return "\x1b[38;5;202m";
    return "\x1b[38;5;196m";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
    let input = {};
    try {
        const raw = readFileSync("/dev/stdin", "utf8");
        input = JSON.parse(raw);
    } catch {
        /* no stdin or bad JSON */
    }

    const model = input?.model?.display_name || "Claude";
    const cwd = input?.cwd || process.cwd();
    const pct = Math.floor(input?.context_window?.used_percentage ?? 0);
    const transcriptPath = input?.transcript_path || "";

    const sessionId = transcriptPath
        ? basename(transcriptPath, ".jsonl")
              .replace(/[^a-zA-Z0-9_-]/g, "")
              .slice(0, 32)
        : "";

    const dirName = basename(cwd);

    // ── Data Collection ──
    const omcVersion = getOmcVersion();
    const updateAvailable = checkUpdateAvailable(omcVersion);

    const gitBranch = run("git -c core.useBuiltinFSMonitor=false rev-parse --abbrev-ref HEAD", cwd);
    const gitDirty = gitBranch ? run("git -c core.useBuiltinFSMonitor=false diff-index --quiet HEAD --; echo $?", cwd) === "1" : false;

    const nodeVer = run("node -v", cwd);
    const pythonVer = (() => {
        const v = run("pyenv version-name", cwd);
        return v && v !== "system" ? v : "";
    })();

    const tx = parseTranscript(transcriptPath);

    // Cost calculation
    if (tx.costUSD === 0 && (tx.inputTokens > 0 || tx.outputTokens > 0)) {
        const modelLower = model.toLowerCase();
        const pricing = modelLower.includes("haiku") ? [0.8, 4, 0.8, 0.08] : modelLower.includes("sonnet") ? [3, 15, 3, 0.3] : [15, 75, 15, 1.875];
        tx.costUSD = (tx.inputTokens * pricing[0] + tx.outputTokens * pricing[1] + tx.cacheCreateTokens * pricing[2] + tx.cacheReadTokens * pricing[3]) / 1_000_000;
    }

    const { bar } = buildBar(pct);

    const omcBase = join(cwd, ".omc");
    const ralphData = loadState(resolveStatePath(omcBase, sessionId, "ralph-state.json"));
    const autopilotData = loadState(resolveStatePath(omcBase, sessionId, "autopilot-state.json"));
    const ultraworkData = loadState(resolveStatePath(omcBase, sessionId, "ultrawork-state.json"));
    const prdStory = loadPrdStory(omcBase, sessionId);
    const sessionSummary = loadSessionSummary(omcBase, sessionId);

    const rateData = loadRateLimit();
    const sessionDurationMs = getSessionDurationMs(omcBase, transcriptPath);
    const bgTaskCount = getBackgroundTaskCount(omcBase);

    // ═════════════════════════════════════════════════════════════════════════════
    // LINE 1: Identity & Git
    // ═════════════════════════════════════════════════════════════════════════════
    let line1 = "";

    line1 += `${BOLD}${CYAN}󰚩 ${model}${RESET}`;
    if (tx.thinkingActive) line1 += ` ${MAGENTA}${ICON_THINKING}${RESET}`;

    // Permission approval indicator (NEW)
    if (tx.pendingPermission) {
        line1 += ` ${BOLD}${YELLOW}${ICON_LOCK} APPROVE?${RESET}`;
    }

    line1 += ` ${GRAY}❯${RESET} ${BLUE} ${dirName}${RESET}`;

    if (gitBranch) {
        line1 += ` ${SEP} ${YELLOW} ${gitBranch}${gitDirty ? "*" : ""}${RESET}`;
    }

    const runtimeParts = [];
    if (nodeVer) runtimeParts.push(`${GREEN}󰎙 ${nodeVer}${RESET}`);
    if (pythonVer) runtimeParts.push(`${MAGENTA} ${pythonVer}${RESET}`);
    if (runtimeParts.length) {
        line1 += ` ${SEP} ${runtimeParts.join("  ")}`;
    }

    // OMC version + update notification (NEW)
    if (omcVersion) {
        if (updateAvailable) {
            line1 += ` ${SEP} ${YELLOW}${ICON_UPDATE} ${omcVersion}→${updateAvailable}${RESET}`;
        } else {
            line1 += ` ${SEP} ${CYAN}󰑣 ${omcVersion}${RESET}`;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════
    // LINE 2: Context & Stats
    // ═════════════════════════════════════════════════════════════════════════════
    let pctSuffix = "";
    if (pct >= 90) pctSuffix = ` ${BOLD}${RED}CRITICAL${RESET}`;
    else if (pct >= 80) pctSuffix = ` ${YELLOW}COMPRESS?${RESET}`;

    let line2 = `${WHITE}CTX${RESET} [${bar}]${pctSuffix}`;

    // Token usage (always show — defaults to 0)
    line2 += ` ${SEP} ${WHITE}${ICON_TOKEN}${RESET} ${CYAN}↓${WHITE}${fmtTokens(tx.inputTokens)} ${MAGENTA}↑${WHITE}${fmtTokens(tx.outputTokens)} ${GREEN}Σ${WHITE}${fmtTokens(tx.sessionTotalTokens)}${RESET}`;

    // Cost (always show — defaults to $0.0000)
    line2 += ` ${SEP} ${YELLOW}${ICON_COST}${WHITE} $${tx.costUSD.toFixed(4)}${RESET}`;

    // Call counts (always show — defaults to 0, skill name inline)
    line2 += ` ${SEP} \x1b[38;5;208m${ICON_WRENCH} ${WHITE}${tx.toolCallCount}${RESET}`;
    line2 += ` ${CYAN}${ICON_ROBOT} ${WHITE}${tx.agentCallCount}${RESET}`;
    line2 += ` ${MAGENTA}${ICON_FLASH} ${WHITE}${tx.skillCount}${RESET}`;
    if (tx.lastSkill) {
        line2 += ` ${CYAN}${tx.lastSkill.name}${RESET}`;
    }

    // Background tasks (always show on Line 2)
    line2 += ` ${SEP} ${CYAN}${ICON_PROGRESS} ${bgTaskCount}${RESET}`;

    // Todos on Line 2
    const todoStr2 = renderTodos(tx.todos);
    line2 += ` ${SEP} ${todoStr2 || `${CYAN}${ICON_TODO} ${WHITE}0/0${RESET}`}`;

    // Session duration + Rate limit moved to Line 3

    // ═════════════════════════════════════════════════════════════════════════════
    // LINE 3: OMC Orchestration + PRD + Todos
    // ═════════════════════════════════════════════════════════════════════════════
    const omcParts = [];

    if (ultraworkData && ralphData) {
        const count = ultraworkData.reinforcement_count || 0;
        const iter = ralphData.iteration || 0;
        const max = ralphData.max_iterations || "?";
        omcParts.push(`${MAGENTA} ultrawork+ralph:${iter}/${max} x${count}${RESET}`);
    } else if (ralphData) {
        const iter = ralphData.iteration || 0;
        const max = ralphData.max_iterations || "?";
        omcParts.push(`${YELLOW}󰑮 ralph:${iter}/${max}${RESET}`);
    } else if (ultraworkData) {
        const count = ultraworkData.reinforcement_count || 0;
        omcParts.push(`${MAGENTA} ultrawork:x${count}${RESET}`);
    }

    if (autopilotData) {
        const phase = autopilotData.phase || "";
        const iter = autopilotData.iteration || 0;
        const max = autopilotData.max_iterations || "?";
        const label = phase ? `Phase ${iter} ${phase}` : `${iter}/${max}`;
        omcParts.push(`${CYAN} autopilot:${label}${RESET}`);
    }

    // PRD story (NEW)
    if (prdStory) {
        const col = prdStory.completed === prdStory.total ? GREEN : CYAN;
        omcParts.push(`${col}${ICON_STORY} ${prdStory.storyId}${prdStory.total ? ` (${prdStory.completed}/${prdStory.total})` : ""}${RESET}`);
    }

    // Profile name (only when CLAUDE_CONFIG_DIR is custom)
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir) {
        const profileName = basename(configDir);
        omcParts.push(`${MAGENTA}󰀄 ${WHITE}${profileName}${RESET}`);
    }

    // API key source (always show)
    const apiKeySource = detectApiKeySource(cwd);
    if (apiKeySource) {
        const keyCol = apiKeySource === "oauth" ? GREEN : apiKeySource === "env" ? YELLOW : CYAN;
        omcParts.push(`${keyCol}${ICON_KEY} ${WHITE}${apiKeySource}${RESET}`);
    }

    // Session duration (before rate limit)
    if (sessionDurationMs !== null) {
        const mins = Math.floor(sessionDurationMs / 60000);
        const durStr = formatDuration(sessionDurationMs);
        const durCol = mins >= 120 ? RED : mins >= 60 ? YELLOW : GREEN;
        omcParts.push(`${durCol}${ICON_TIMER}${WHITE} ${durStr}${RESET}`);
    } else {
        omcParts.push(`${GRAY}${ICON_TIMER} 0m${RESET}`);
    }

    // Rate limit (right side of Line 3)
    if (rateData) {
        const rateParts = [];
        const fmtRate = (name, u, resetsAt) => {
            const col = rateCol(u);
            let s = `${WHITE}${name} ${col}${u}%${RESET}`;
            if (resetsAt) {
                const resetIn = formatResetIn(resetsAt, name);
                if (resetIn) s += `${GRAY}(${resetIn})${RESET}`;
            }
            return s;
        };

        let maxU = 0;
        if (rateData.fiveHourPercent !== undefined) {
            const u = rateData.fiveHourPercent;
            maxU = Math.max(maxU, u);
            rateParts.push(fmtRate("5h", u, rateData.fiveHourResetsAt));
        }
        if (rateData.weeklyPercent !== undefined) {
            const u = rateData.weeklyPercent;
            maxU = Math.max(maxU, u);
            rateParts.push(fmtRate("wk", u, rateData.weeklyResetsAt));
        }
        if (rateData.monthlyPercent !== undefined) {
            const u = rateData.monthlyPercent;
            maxU = Math.max(maxU, u);
            rateParts.push(fmtRate("mo", u));
        }

        if (rateParts.length) {
            omcParts.push(`${rateCol(maxU)}${ICON_SPEED}${RESET} ${rateParts.join(" ")}`);
        }
    }

    // Session summary (NEW)
    if (sessionSummary) {
        const label = sessionSummary.slice(0, 35);
        omcParts.push(`${GRAY}${ICON_SUMMARY} ${label}${sessionSummary.length > 35 ? "…" : ""}${RESET}`);
    }

    // ═════════════════════════════════════════════════════════════════════════════
    // LINE 4+: Agent Tree (NEW — only when agents are running)
    // ═════════════════════════════════════════════════════════════════════════════
    const agentTreeLines = renderAgentTree(tx.agents);

    // ═════════════════════════════════════════════════════════════════════════════
    // Context Limit Warning Banner (NEW)
    // ═════════════════════════════════════════════════════════════════════════════
    let warningLine = null;
    if (pct >= 85) {
        warningLine = `${BOLD}${RED}⚠ Context ${pct}% — consider /compact to free space${RESET}`;
    }

    // ─── Output ──────────────────────────────────────────────────────────────────
    const outputLines = [line1, line2];
    // Line 3 always shown (orchestration + todos defaults present)
    outputLines.push(omcParts.join(` ${SEP} `));
    outputLines.push(...agentTreeLines);
    if (warningLine) outputLines.push(warningLine);

    // Limit to max 6 lines to prevent input field shrinkage
    const MAX_LINES = 6;
    if (outputLines.length > MAX_LINES) {
        const truncated = outputLines.length - MAX_LINES + 1;
        outputLines.length = MAX_LINES - 1;
        outputLines.push(`${GRAY}... (+${truncated} lines)${RESET}`);
    }

    process.stdout.write(outputLines.join("\n") + "\n");
}

main();
