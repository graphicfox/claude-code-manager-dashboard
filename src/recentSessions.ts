import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// How much of each JSONL to scan looking for ai-title / first user prompt.
// 32 KB is enough for a few opening turns.
const HEAD_BYTES = 32 * 1024;

export interface RecentSession {
  sessionId: string;
  cwd: string;
  jsonlPath: string;
  modifiedAt: Date;
  title?: string;
  firstUserText?: string;
}

/**
 * Lists the most recently-modified JSONL session logs Claude Code has
 * written for `cwd`. Reads only the first ~32KB of each file to extract a
 * display title without paying full-file parse cost.
 */
export async function listRecentSessions(
  cwd: string,
  limit = 20
): Promise<RecentSession[]> {
  const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const candidates: { name: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const stat = await fsp.stat(path.join(dir, name));
      candidates.push({ name, mtime: stat.mtimeMs });
    } catch {
      /* skip */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);

  const out: RecentSession[] = [];
  for (const c of top) {
    const jsonlPath = path.join(dir, c.name);
    const sessionId = c.name.replace(/\.jsonl$/, '');
    const meta = await peekTitle(jsonlPath);
    out.push({
      sessionId,
      cwd,
      jsonlPath,
      modifiedAt: new Date(c.mtime),
      title: meta.title,
      firstUserText: meta.firstUserText,
    });
  }
  return out;
}

async function peekTitle(
  jsonlPath: string
): Promise<{ title?: string; firstUserText?: string }> {
  let buf: Buffer;
  try {
    const fd = await fsp.open(jsonlPath, 'r');
    try {
      const stat = await fd.stat();
      const len = Math.min(stat.size, HEAD_BYTES);
      buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, 0);
    } finally {
      await fd.close();
    }
  } catch {
    return {};
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // Drop the last partial line (we may have read mid-record).
  if (lines.length > 0) lines.pop();

  let title: string | undefined;
  let firstUserText: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!title && event.type === 'ai-title' && typeof event.aiTitle === 'string') {
      title = event.aiTitle.trim();
    }
    if (!firstUserText && event.type === 'user') {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        const textBlock = content.find(
          (c: any) => c?.type === 'text' && typeof c.text === 'string'
        );
        if (textBlock) firstUserText = String(textBlock.text).trim();
      } else if (typeof content === 'string') {
        firstUserText = content.trim();
      }
    }
    if (title && firstUserText) break;
  }
  return { title, firstUserText };
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

export function pickRecentLabel(s: RecentSession): {
  label: string;
  description: string;
  detail: string;
} {
  const label = s.title?.slice(0, 80) || s.firstUserText?.slice(0, 80) || s.sessionId;
  const detail = s.firstUserText
    ? s.firstUserText.replace(/\s+/g, ' ').slice(0, 120)
    : '';
  return {
    label,
    description: relativeTimeString(s.modifiedAt),
    detail,
  };
}

function relativeTimeString(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}
