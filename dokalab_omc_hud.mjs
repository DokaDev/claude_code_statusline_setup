#!/usr/bin/env node
/**
 * statusline-combined.mjs
 * Combined Claude Code statusline: Nerd Font icons + OMC orchestration state.
 * Merges the gradient bar / git / runtime design of statusline.sh with OMC HUD state.
 * No external dependencies — only node:* built-ins.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

// ─── ANSI Colours ─────────────────────────────────────────────────────────────
const CYAN    = '\x1b[36m';
const BLUE    = '\x1b[34m';
const YELLOW  = '\x1b[33m';
const GREEN   = '\x1b[32m';
const RED     = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const GRAY    = '\x1b[90m';
const WHITE   = '\x1b[97m';
const BOLD    = '\x1b[1m';
const RESET   = '\x1b[0m';

// Nerd Font icons (Line 2) - defined via codepoints to avoid encoding issues
const ICON_WRENCH   = String.fromCodePoint(0xF1322);  // 󱌢 tool calls (hammer_screwdriver)
const ICON_TIMER    = String.fromCodePoint(0xF13AB);  // 󱎫 session
const ICON_TOKEN    = String.fromCodePoint(0xF0284);  // 󰊄 tokens
const ICON_ROBOT    = String.fromCodePoint(0xF167A);  // 󱙺 agents
const ICON_FLASH    = String.fromCodePoint(0xF0329);  // 󰌩 skills
const ICON_SPEED    = String.fromCodePoint(0xF04C5);  // 󰓅 rate limit
const ICON_PROGRESS = String.fromCodePoint(0xF070E);  // 󰜎 background
const ICON_COST     = String.fromCodePoint(0xF0857);  // 󰡗 cost
const ICON_THINKING = String.fromCodePoint(0xF0803);  // 󰠃 thinking (head_cog)

// 256-colour smooth gradient for context bar (cyan → green → yellow → orange → red)
const BAR_GRADIENT = [
  51, 50, 49, 48, 47,    // cyan → green
  46, 82, 118, 154, 190, // green → yellow-green
  226, 226, 220, 214,    // yellow
  214, 208, 208, 202,    // orange
  196, 196,              // red
].map(c => `\x1b[38;5;${c}m`);
const CEMPTY = '\x1b[38;5;237m';  // empty blocks

// Rate limit colours
const RATE_OK   = '\x1b[38;5;51m';
const RATE_WARN = '\x1b[38;5;220m';
const RATE_CRIT = '\x1b[38;5;196m';

const SEP = `${GRAY}|${RESET}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, cwd, timeout = 2000) {
  try {
    return execSync(cmd, { cwd, timeout, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return ''; }
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

function fileAgeMins(path) {
  try { return (Date.now() - statSync(path).mtimeMs) / 60000; }
  catch { return Infinity; }
}

function fileMtime(path) {
  try { return statSync(path).mtimeMs; }
  catch { return null; }
}

function gradientColor(pos100) {
  const idx = Math.min(Math.floor(pos100 / 100 * BAR_GRADIENT.length), BAR_GRADIENT.length - 1);
  return BAR_GRADIENT[Math.max(0, idx)];
}

// Format a duration in ms as "Xm", "Xh Ym", or "Xd Yh"
function formatDuration(ms) {
  const totalMins = Math.floor(ms / 60000);
  if (totalMins < 60) return `${totalMins}m`;
  const totalHours = Math.floor(totalMins / 60);
  if (totalHours < 24) {
    const m = totalMins % 60;
    return m > 0 ? `${totalHours}h ${m}m` : `${totalHours}h`;
  }
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

// Format an ISO reset time as relative duration from now
// If reset time has passed, roll forward by cycle length (5h or 7d)
function formatResetIn(isoString, cycleName) {
  try {
    let resetAt = new Date(isoString).getTime();
    const now = Date.now();
    if (resetAt <= now) {
      const cycleMs = cycleName === 'wk' ? 7 * 24 * 60 * 60 * 1000
                    : cycleName === 'mo' ? 30 * 24 * 60 * 60 * 1000
                    : 5 * 60 * 60 * 1000; // default 5h
      while (resetAt <= now) resetAt += cycleMs;
    }
    return formatDuration(resetAt - now);
  } catch { return ''; }
}

// ─── OMC Version ──────────────────────────────────────────────────────────────
function getOmcVersion() {
  try {
    const cacheDir = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    if (!existsSync(cacheDir)) return null;
    const entries = readdirSync(cacheDir).filter(e => /^\d+\.\d+\.\d+/.test(e));
    if (!entries.length) return null;
    // Pick latest by semver-ish sort
    entries.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });
    return entries[0];
  } catch { return null; }
}

// ─── Context Bar ──────────────────────────────────────────────────────────────
// Background colour versions of the gradient (for text overlay on filled blocks)
const BAR_GRADIENT_BG = [
  51, 50, 49, 48, 47,
  46, 82, 118, 154, 190,
  226, 226, 220, 214,
  214, 208, 208, 202,
  196, 196,
].map(c => `\x1b[48;5;${c}m`);
const CEMPTY_BG = '\x1b[48;5;237m';

function buildBar(pct) {
  const BAR_WIDTH = 20;
  const filledTenths = Math.floor(pct * BAR_WIDTH * 10 / 100);
  const fullBlocks   = Math.floor(filledTenths / 10);
  const frac         = filledTenths % 10;

  // Percentage text centered in bar
  const pctText = `${pct}%`;
  const textStart = Math.floor((BAR_WIDTH - pctText.length) / 2);
  const textEnd   = textStart + pctText.length;

  let bar = '';
  for (let i = 0; i < BAR_WIDTH; i++) {
    const isFilled = i < fullBlocks || (i === fullBlocks && frac > 0);
    const isText   = i >= textStart && i < textEnd;

    if (isText) {
      const ch = pctText[i - textStart];
      if (isFilled) {
        // Black text on gradient background
        const bg = BAR_GRADIENT_BG[i] || BAR_GRADIENT_BG[BAR_GRADIENT_BG.length - 1];
        bar += `${bg}${BOLD}\x1b[30m${ch}${RESET}`;
      } else {
        // White text on dark background
        bar += `${CEMPTY_BG}${BOLD}\x1b[97m${ch}${RESET}`;
      }
    } else {
      const col = BAR_GRADIENT[i] || BAR_GRADIENT[BAR_GRADIENT.length - 1];
      if (i < fullBlocks)                     bar += `${col}█`;
      else if (i === fullBlocks && frac >= 5) bar += `${col}▌`;
      else                                     bar += `${CEMPTY}░`;
    }
  }
  bar += RESET;

  return { bar };
}

// ─── OMC State ────────────────────────────────────────────────────────────────
const STATE_MAX_AGE_MINS = 120;

function resolveStatePath(baseDir, sessionId, filename) {
  if (sessionId) {
    const p = join(baseDir, 'state', 'sessions', sessionId, filename);
    if (existsSync(p)) return p;
  }
  const p2 = join(baseDir, 'state', filename);
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

// ─── Transcript Parsing ───────────────────────────────────────────────────────
function parseTranscript(transcriptPath) {
  const result = {
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    agentCount: 0,
    toolCallCount: 0,
    skillCount: 0,
    thinkingActive: false,
  };
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return result;
    const lines = readFileSync(transcriptPath, 'utf8').split('\n');
    const agentSet = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        // Thinking/reasoning state detection
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'thinking' || block.type === 'reasoning') {
              result._lastThinkingSeen = entry.timestamp || Date.now();
            }
          }
        }

        // Tokens (cost calculated after parsing based on model)
        if (entry.costUSD) result.costUSD += entry.costUSD;
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          result.inputTokens  += u.input_tokens  || 0;
          result.outputTokens += u.output_tokens || 0;
          result.cacheCreateTokens += u.cache_creation_input_tokens || 0;
          result.cacheReadTokens   += u.cache_read_input_tokens   || 0;
        }

        // Agent tracking (legacy system events)
        if (entry.type === 'system' && entry.subtype === 'agent_start' && entry.agent_id) {
          agentSet.add(entry.agent_id);
        }

        // Tool use entries
        if (entry.type === 'tool_use' || (entry.type === 'assistant' && entry.message?.content)) {
          const content = entry.type === 'tool_use'
            ? [entry]
            : (entry.message?.content || []);

          for (const block of Array.isArray(content) ? content : []) {
            if (block.type === 'tool_use') {
              result.toolCallCount++;

              // Agent invocations
              const name = (block.name || '').toLowerCase();
              if (name === 'agent' || name === 'taskcreate' || name === 'task' ||
                  name.includes('subagent') || name.includes('agent')) {
                const agentId = block.id || block.input?.agent_id || name + '_' + result.toolCallCount;
                agentSet.add(agentId);
              }

              // Skill invocations — Skill tool or mcp skill-like calls
              if (name === 'skill' || (block.input?.skill) ||
                  (name.startsWith('mcp__') && name.includes('skill'))) {
                result.skillCount++;
              }
            }
          }
        }

        // Top-level tool_use type (some transcript formats)
        if (entry.type === 'tool_use') {
          result.toolCallCount++;
          const name = (entry.name || '').toLowerCase();
          if (name === 'agent' || name === 'taskcreate' || name.includes('subagent')) {
            agentSet.add(entry.id || name);
          }
          if (name === 'skill' || entry.input?.skill) {
            result.skillCount++;
          }
        }

      } catch { /* skip malformed lines */ }
    }

    result.agentCount = agentSet.size;

    // Thinking is active if last seen within 30 seconds
    if (result._lastThinkingSeen) {
      const age = Date.now() - new Date(result._lastThinkingSeen).getTime();
      result.thinkingActive = age <= 30_000;
    }
  } catch { /* graceful fallback */ }
  return result;
}

// ─── Rate Limit Cache ─────────────────────────────────────────────────────────
function loadRateLimit() {
  const cachePath = join(homedir(), '.claude', 'plugins', 'oh-my-claudecode', '.usage-cache.json');
  const data = readJson(cachePath);
  if (!data || !data.data) return null;
  if (data.timestamp && (Date.now() - data.timestamp) > 24 * 60 * 60 * 1000) return null; // 24h stale limit
  return data.data;
}

// ─── Session Duration ─────────────────────────────────────────────────────────
function getSessionDurationMs(omcBase, transcriptPath) {
  try {
    // Try hud-state.json first
    const hudStatePath = join(omcBase, 'state', 'hud-state.json');
    const hudState = readJson(hudStatePath);
    if (hudState?.sessionStartTimestamp) {
      return Date.now() - new Date(hudState.sessionStartTimestamp).getTime();
    }
    // Fallback: use transcript mtime as proxy (file was created at session start)
    if (transcriptPath) {
      const mtime = fileMtime(transcriptPath);
      if (mtime) return Date.now() - mtime;
    }
  } catch { /* graceful */ }
  return null;
}

// ─── Background Tasks ─────────────────────────────────────────────────────────
function getBackgroundTaskCount(omcBase) {
  try {
    const hudStatePath = join(omcBase, 'state', 'hud-state.json');
    const hudState = readJson(hudStatePath);
    if (Array.isArray(hudState?.backgroundTasks)) {
      return hudState.backgroundTasks.length;
    }
  } catch { /* graceful */ }
  return 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  let input = {};
  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    input = JSON.parse(raw);
  } catch { /* no stdin or bad JSON — use defaults */ }

  const model          = input?.model?.display_name || 'Claude';
  const cwd            = input?.cwd || process.cwd();
  const pct            = Math.floor(input?.context_window?.used_percentage ?? 0);
  const transcriptPath = input?.transcript_path || '';

  const sessionId = transcriptPath
    ? basename(transcriptPath, '.jsonl').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
    : '';

  const dirName = basename(cwd);

  // ── OMC Version ──
  const omcVersion = getOmcVersion();

  // ── Git ──
  const gitBranch = run('git -c core.useBuiltinFSMonitor=false rev-parse --abbrev-ref HEAD', cwd);
  const gitDirty  = gitBranch
    ? run('git -c core.useBuiltinFSMonitor=false diff-index --quiet HEAD --; echo $?', cwd) === '1'
    : false;

  // ── Runtimes ──
  const nodeVer   = run('node -v', cwd);
  const pythonVer = (() => {
    const v = run('pyenv version-name', cwd);
    return (v && v !== 'system') ? v : '';
  })();

  // ── Transcript ──
  const tx = parseTranscript(transcriptPath);

  // Calculate cost from tokens if not already set
  if (tx.costUSD === 0 && (tx.inputTokens > 0 || tx.outputTokens > 0)) {
    const modelLower = model.toLowerCase();
    // Pricing per 1M tokens [input, output, cache_create, cache_read]
    const pricing = modelLower.includes('haiku')  ? [0.80, 4, 0.80, 0.08]
                  : modelLower.includes('sonnet') ? [3, 15, 3, 0.30]
                  :                                  [15, 75, 15, 1.875]; // opus default
    tx.costUSD = (tx.inputTokens * pricing[0]
                + tx.outputTokens * pricing[1]
                + tx.cacheCreateTokens * pricing[2]
                + tx.cacheReadTokens * pricing[3]) / 1_000_000;
  }

  // ── Context bar ──
  const { bar } = buildBar(pct);

  // ── OMC State ──
  const omcBase       = join(cwd, '.omc');
  const ralphData     = loadState(resolveStatePath(omcBase, sessionId, 'ralph-state.json'));
  const autopilotData = loadState(resolveStatePath(omcBase, sessionId, 'autopilot-state.json'));
  const ultraworkData = loadState(resolveStatePath(omcBase, sessionId, 'ultrawork-state.json'));

  // ── Rate Limit ──
  const rateData = loadRateLimit();

  // ── Session Duration ──
  const sessionDurationMs = getSessionDurationMs(omcBase, transcriptPath);

  // ── Background Tasks ──
  const bgTaskCount = getBackgroundTaskCount(omcBase);

  // ─────────────────────────────────────────────────────────────────────────────
  // LINE 1: Identity & Git
  // ─────────────────────────────────────────────────────────────────────────────
  let line1 = '';

  line1 += `${BOLD}${CYAN}󰚩 ${model}${RESET}${tx.thinkingActive ? ` ${MAGENTA}${ICON_THINKING}${RESET}` : ""} ${GRAY}❯${RESET} ${BLUE} ${dirName}${RESET}`;

  if (gitBranch) {
    line1 += ` ${SEP} ${YELLOW} ${gitBranch}${gitDirty ? '*' : ''}${RESET}`;
  }

  const runtimeParts = [];
  if (nodeVer)   runtimeParts.push(`${GREEN}󰎙 ${nodeVer}${RESET}`);
  if (pythonVer) runtimeParts.push(`${MAGENTA} ${pythonVer}${RESET}`);
  if (runtimeParts.length) {
    line1 += ` ${SEP} ${runtimeParts.join('  ')}`;
  }

  if (omcVersion) {
    line1 += ` ${SEP} ${CYAN}󰑣 ${omcVersion}${RESET}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LINE 2: Context & Stats
  // ─────────────────────────────────────────────────────────────────────────────

  // Context percentage with threshold warning
  let pctSuffix = '';
  if (pct >= 90) {
    pctSuffix = ` ${BOLD}${RED}CRITICAL${RESET}`;
  } else if (pct >= 80) {
    pctSuffix = ` ${YELLOW}COMPRESS?${RESET}`;
  }

  let line2 = `${WHITE}CTX${RESET} [${bar}]${pctSuffix}`;

  if (tx.inputTokens > 0 || tx.outputTokens > 0) {
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
    line2 += ` ${SEP} ${WHITE}${ICON_TOKEN}${RESET} ${CYAN}↓${WHITE}${fmt(tx.inputTokens)} ${MAGENTA}↑${WHITE}${fmt(tx.outputTokens)}`;
  }

  if (tx.costUSD > 0) {
    line2 += ` ${SEP} ${YELLOW}${ICON_COST}${WHITE} $${tx.costUSD.toFixed(4)}${RESET}`;
  }

  // Tool calls
  if (tx.toolCallCount > 0) {
    line2 += ` ${SEP} \x1b[38;5;208m${ICON_WRENCH}${WHITE} ${tx.toolCallCount}${RESET}`;
  }

  // Agent count (from transcript)
  if (tx.agentCount > 0) {
    line2 += ` ${CYAN}${ICON_ROBOT}${WHITE} ${tx.agentCount}${RESET}`;
  }

  // Skill count
  if (tx.skillCount > 0) {
    line2 += ` ${MAGENTA}${ICON_FLASH}${WHITE} ${tx.skillCount}${RESET}`;
  }

  // Session duration
  if (sessionDurationMs !== null) {
    const mins = Math.floor(sessionDurationMs / 60000);
    const durStr = formatDuration(sessionDurationMs);
    const durCol = mins >= 120 ? RED : mins >= 60 ? YELLOW : GREEN;
    line2 += ` ${SEP} ${durCol}${ICON_TIMER}${WHITE} ${durStr}${RESET}`;
  }

  // Background tasks
  if (bgTaskCount > 0) {
    line2 += ` ${SEP} ${CYAN}${ICON_PROGRESS} ${bgTaskCount}${RESET}`;
  }

  // Rate limit
  if (rateData) {
    const parts = [];

    const rateCol = (u) => {
      if (u <= 10) return '\x1b[38;5;51m';   // cyan
      if (u <= 20) return '\x1b[38;5;50m';
      if (u <= 30) return '\x1b[38;5;49m';
      if (u <= 40) return '\x1b[38;5;48m';
      if (u <= 50) return '\x1b[38;5;82m';   // green
      if (u <= 55) return '\x1b[38;5;118m';
      if (u <= 60) return '\x1b[38;5;154m';
      if (u <= 65) return '\x1b[38;5;190m';
      if (u <= 70) return '\x1b[38;5;226m';  // yellow
      if (u <= 75) return '\x1b[38;5;220m';
      if (u <= 80) return '\x1b[38;5;214m';
      if (u <= 85) return '\x1b[38;5;208m';  // orange
      if (u <= 90) return '\x1b[38;5;202m';
      return '\x1b[38;5;196m';                // red
    };
    const fmtRate = (name, u, resetsAt) => {
      const col = rateCol(u);
      let s = `${WHITE}${name} ${col}${u}%${RESET}`;
      if (resetsAt) {
        const resetIn = formatResetIn(resetsAt, name);
        if (resetIn) s += `${GRAY}(${resetIn})${RESET}`;
      }
      return s;
    };

    // Five-hour rate
    let maxU = 0;
    if (rateData.fiveHourPercent !== undefined) {
      const u = rateData.fiveHourPercent;
      maxU = Math.max(maxU, u);
      parts.push(fmtRate('5h', u, rateData.fiveHourResetsAt));
    } else if (rateData.five_hour) {
      const u = Math.round(rateData.five_hour.utilization * 100);
      maxU = Math.max(maxU, u);
      parts.push(fmtRate('5h', u, rateData.five_hour.resets_at));
    }

    // Weekly rate
    if (rateData.weeklyPercent !== undefined) {
      const u = rateData.weeklyPercent;
      maxU = Math.max(maxU, u);
      parts.push(fmtRate('wk', u, rateData.weeklyResetsAt));
    } else if (rateData.seven_day) {
      const u = Math.round(rateData.seven_day.utilization * 100);
      maxU = Math.max(maxU, u);
      parts.push(fmtRate('wk', u, rateData.seven_day.resets_at));
    }

    // Monthly rate
    if (rateData.monthlyPercent !== undefined) {
      const u = rateData.monthlyPercent;
      maxU = Math.max(maxU, u);
      parts.push(fmtRate('mo', u));
    }

    if (parts.length) {
      line2 += ` ${SEP} ${rateCol(maxU)}${ICON_SPEED}${RESET} ${parts.join(' ')}`;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LINE 3: OMC Orchestration (only when modes are active)
  // ─────────────────────────────────────────────────────────────────────────────
  const omcParts = [];

  if (ralphData) {
    const iter = ralphData.iteration || 0;
    const max  = ralphData.max_iterations || '?';
    omcParts.push(`${YELLOW}󰑮 ralph:${iter}/${max}${RESET}`);
  }

  if (autopilotData) {
    const phase = autopilotData.phase || '';
    const iter  = autopilotData.iteration || 0;
    const max   = autopilotData.max_iterations || '?';
    const label = phase ? `Phase ${iter} ${phase}` : `${iter}/${max}`;
    omcParts.push(`${CYAN} autopilot:${label}${RESET}`);
  }

  // Ultrawork — combine with ralph if both active
  if (ultraworkData) {
    const count = ultraworkData.reinforcement_count || 0;
    if (ralphData) {
      // Both active: already showed ralph above, annotate ultrawork alongside
      omcParts.push(`${MAGENTA} ultrawork+ralph:x${count}${RESET}`);
    } else {
      omcParts.push(`${MAGENTA} ultrawork:x${count}${RESET}`);
    }
  }

  // Active skills line (ultrawork + ralph combo label at start if both active)
  if (ultraworkData && ralphData && omcParts.length >= 2) {
    // Replace the separate ralph and ultrawork+ralph entries with a combined one
    const ralphIdx = omcParts.findIndex(p => p.includes('ralph:'));
    const uwIdx    = omcParts.findIndex(p => p.includes('ultrawork'));
    if (ralphIdx !== -1 && uwIdx !== -1) {
      const count = ultraworkData.reinforcement_count || 0;
      const iter  = ralphData.iteration || 0;
      const max   = ralphData.max_iterations || '?';
      omcParts.splice(Math.min(ralphIdx, uwIdx), 2,
        `${MAGENTA} ultrawork+ralph:${iter}/${max} x${count}${RESET}`);
    }
  }

  // Agent count and background tasks are already shown on Line 2

  // ─── Output ──────────────────────────────────────────────────────────────────
  process.stdout.write(line1 + '\n');
  process.stdout.write(line2 + '\n');
  if (omcParts.length) {
    process.stdout.write(omcParts.join(` ${SEP} `) + '\n');
  }
}

main();
