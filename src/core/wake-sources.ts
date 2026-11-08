/**
 * Wake source manifest: the budget ladder is the law; the sources are configuration.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export type WakeSource = {
  path: string;
  role: 'identity' | 'goals' | 'due' | 'activity' | 'custom';
  cap: number;
  mode: 'head' | 'tail' | 'fovea' | 'due-scan';
};

/**
 * Populate the wake's warm_notes section from the vitality layer.
 *
 * This was dead code in the default path: warmNotes was initialized empty and
 * no manifest entry or switch branch ever filled it, so the briefing never
 * carried the "what memory is currently alive" signal the design promises.
 * The data already exists — boosts are the activation layer's own record of
 * what was recently retrieved/written, Ebbinghaus-decayed at read time — so
 * warm notes come from there rather than from a manifest source. Best-effort:
 * any failure (no index yet, locked db) yields an empty list, never an error.
 */
export async function assembleWarmNotes(
  dbPath: string,
  cap: number
): Promise<Array<{ title: string; decayed: number }>> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const { loadBoosts } = await import('./activation.js');
    const db = new Database(dbPath, { readonly: true });
    try {
      const boosts = loadBoosts(db);
      return [...boosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, cap)
        .map(([title, decayed]) => ({ title, decayed }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * The project roster from the live derived index — the same note_project rows
 * the ask-first gate's refusal shows, so the roster an agent files against is
 * the roster wake advertises. The map counts: a project whose only note is its
 * map is exactly the documented first step (create the map, then fill it), and
 * the gate's roster includes it — excluding maps here made wake's roster
 * disagree with the gate's (the cold-agent suite caught the drift). Forgotten
 * statuses (archived/superseded/released) are excluded — those notes left
 * retrieval, so counting them would advertise projects that are effectively
 * empty. Best-effort: a missing/locked db yields an empty list, never an error.
 */
export async function assembleProjects(
  dbPath: string
): Promise<Array<{ project: string; notes: number }>> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const { FORGOTTEN_STATUSES } = await import('./status.js');
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT p.project AS project, COUNT(*) AS notes
           FROM note_project p
           JOIN note n ON n.id = p.note_id
           WHERE n.status = '' OR LOWER(n.status) NOT IN (${[...FORGOTTEN_STATUSES].map(() => '?').join(', ')})
           GROUP BY p.project
           ORDER BY notes DESC`,
        )
        .all(...FORGOTTEN_STATUSES) as Array<{ project: string; notes: number }>;
      return rows.map((r) => ({ project: r.project, notes: Number(r.notes) }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * The note slugs belonging to a project — the membership set the scoped
 * read paths (ranked/similar/explore/warmth) hard-filter against. Includes
 * the project's map (a map is a member by definition; the convention match
 * and routing resolve it for wake, and here the note_project row is the
 * truth since promote tags the map too). Forgotten statuses are excluded —
 * they left retrieval. Empty on any failure (missing/locked db), never an
 * error: callers degrade to unscoped and say so.
 */
export async function projectMemberSlugs(
  dbPath: string,
  project: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { default: Database } = await import('better-sqlite3');
    const { FORGOTTEN_STATUSES } = await import('./status.js');
    const db = new Database(dbPath, { readonly: true });
    try {
      const ph = [...FORGOTTEN_STATUSES].map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT n.slug AS slug
           FROM note_project p
           JOIN note n ON n.id = p.note_id
           WHERE p.project = ?
             AND (n.status = '' OR LOWER(n.status) NOT IN (${ph}))`,
        )
        .all(project, ...FORGOTTEN_STATUSES) as Array<{ slug: string }>;
      for (const r of rows) out.add(r.slug);
    } finally {
      db.close();
    }
  } catch {
    // empty set — callers must treat empty as "unknown", not "no members"
  }
  return out;
}

export interface ProjectWake {
  /** The map note's slug (or null when the project has no map). */
  map: string | null;
  /** Map Current State lines — the living handoff (overwritten every session). */
  currentState: string[];
  /** This project's daily-log lines, newest first. */
  daily: string[];
  /** Recent notes belonging to this project, by last activity. */
  recentNotes: string[];
}

function extractCurrentStateLines(mapBody: string): string[] {
  const lines = mapBody.split('\n');
  const start = lines.findIndex((l) => /^##\s+.*current state.*$/i.test(l));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .filter((l) => l.trim() !== '');
}

/**
 * Project-scoped wake context: everything an agent working ON a project
 * needs, and nothing from the other projects. Reads the project map's
 * Current State (the handoff), the project's daily lines, and its recent
 * notes — all best-effort, degrading to empty on any failure.
 *
 * This is the fix for the global-dump briefing: goals.md and daily.md are
 * SHARED files across projects, so a global wake's project sections were a
 * lottery of whatever file order put first. Identity, the roster menu, and
 * policy stay global; project detail comes only through this, scoped.
 */
export async function assembleProjectWake(
  vaultRoot: string,
  dbPath: string,
  project: string,
  mapRouting: Record<string, string>,
): Promise<ProjectWake> {
  const wake: ProjectWake = {
    map: null,
    currentState: [],
    daily: [],
    recentNotes: [],
  };

  // Resolve the map the same way the ritual does (config routing, then the
  // <tag>…map convention) — one routing truth for add, update, and wake.
  const notesDir = path.join(vaultRoot, 'notes');
  let titles: string[] = [];
  try {
    titles = (await fsp.readdir(notesDir))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  } catch {
    return wake;
  }
  const routing = mapRouting[project];
  const routingHit = routing && titles.includes(routing) ? routing : undefined;
  const { slugify } = await import('./slug.js');
  const conventionHit = routingHit
    ? undefined
    : titles.find(
        (t) => /(^|[-\s])map$/i.test(t.trim()) && slugify(t).includes(slugify(project)),
      );
  const mapTitle = routingHit ?? conventionHit;
  wake.map = mapTitle ?? null;

  if (mapTitle) {
    try {
      const { readFrontmatterFile } = await import('./frontmatter.js');
      const parsed = await readFrontmatterFile(path.join(notesDir, `${mapTitle}.md`));
      wake.currentState = extractCurrentStateLines(parsed.body);
    } catch {
      // map unreadable — the roster still names it, the agent can query it.
    }
  }

  // Project-scoped reads from the live index. A missing/locked db degrades
  // to empty (same contract as the roster).
  try {
    const { default: Database } = await import('better-sqlite3');
    const { FORGOTTEN_STATUSES } = await import('./status.js');
    const db = new Database(dbPath, { readonly: true });
    try {
      const ph = [...FORGOTTEN_STATUSES].map(() => '?').join(', ');
      // Daily lines: the project tag in the line text is the current
      // convention (daily.md is shared; lines carry their project in prose).
      const daily = fsp
        .readFile(path.join(vaultRoot, 'ops', 'daily.md'), 'utf8')
        .then((content) =>
          content
            .split(/\r?\n/)
            .filter((l) => l.includes(project))
            .slice(-12),
        )
        .catch(() => [] as string[]);
      // note_access may be empty; LEFT JOIN keeps the rows.
      const recent = db
        .prepare(
          `SELECT n.slug AS slug
           FROM note_project p
           JOIN note n ON n.id = p.note_id
           LEFT JOIN note_access na ON na.slug = n.slug
           WHERE p.project = ?
             AND (n.status = '' OR LOWER(n.status) NOT IN (${ph}))
           ORDER BY COALESCE(na.last_accessed, n.indexed_at) DESC
           LIMIT 10`,
        )
        .all(project, ...FORGOTTEN_STATUSES) as Array<{ slug: string }>;
      wake.daily = await daily;
      wake.recentNotes = recent.map((r) => r.slug);
    } finally {
      db.close();
    }
  } catch {
    // empty already
  }

  return wake;
}

export function loadWakeSources(config: { wake?: { sources?: WakeSource[] } }): WakeSource[] {
  const src = config.wake?.sources;
  if (Array.isArray(src) && src.length > 0) return src;
  return [
    { path: 'self/identity.md', role: 'identity', cap: 1, mode: 'head' },
    { path: 'self/goals.md', role: 'goals', cap: 8, mode: 'head' },
    { path: 'ops/reminders.md', role: 'due', cap: 6, mode: 'due-scan' },
    // Default activity source is daily.md — the file `mnemos_update file=daily`
    // writes and every vault scaffold ships. today.md was never created by any
    // code path, so the default manifest silently read a nonexistent file.
    { path: 'ops/daily.md', role: 'activity', cap: 10, mode: 'tail' }
  ];
}

export async function assembleWakeInputs(
  vaultRoot: string,
  sources: WakeSource[],
  dbPath?: string
): Promise<{
  identity: string;
  goals: string;
  reminders: string;
  daily: string;
  activity: string[];
  warmNotes: Array<{ title: string; decayed: number }>;
  projects: Array<{ project: string; notes: number }>;
  vaultStats: { noteCount: number; inboxCount: number };
  notices: string[];
}> {
  const result = {
    identity: '',
    goals: '',
    reminders: '',
    daily: '',
    activity: [] as string[],
    warmNotes: [] as Array<{ title: string; decayed: number }>,
    projects: [] as Array<{ project: string; notes: number }>,
    vaultStats: { noteCount: 0, inboxCount: 0 },
    notices: [] as string[]
  };

  for (const src of sources) {
    const filePath = path.join(vaultRoot, src.path);
    let content = '';
    try {
      const buf = await fsp.readFile(filePath, 'utf8');
      content = buf;
    } catch {
      content = '';
    }

    // Every source file carries YAML frontmatter; the role emitters scan raw
    // lines, so the delimiter block must be stripped before anything else or
    // `---` lines leak into the briefing as identity/goals content.
    content = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();

    switch (src.role) {
      case 'identity':
        result.identity = content;
        break;
      case 'goals':
        result.goals = content;
        break;
      case 'due':
        result.reminders = content;
        break;
      case 'activity':
        if (src.mode === 'tail') {
          const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');
          const cap = src.cap;
          const last = lines.slice(-cap);
          result.activity = last;
        }
        break;
    }
  }

  async function countMd(dir: string): Promise<number> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter(e => e.isFile() && e.name.endsWith('.md')).length;
    } catch {
      return 0;
    }
  }

  const notesDir = path.join(vaultRoot, 'notes');
  const inboxDir = path.join(vaultRoot, 'inbox');
  result.vaultStats.noteCount = await countMd(notesDir);
  result.vaultStats.inboxCount = await countMd(inboxDir);

  // Warm notes come from the vitality layer, not a manifest file. The index
  // path is config-owned (engine.db_path) — resolve as the engine does, with
  // the same default; a missing/locked db degrades to an empty list.
  const resolvedDbPath = dbPath ?? path.join(vaultRoot, '.mnemos', 'embeddings.db');
  result.warmNotes = await assembleWarmNotes(resolvedDbPath, 10);
  result.projects = await assembleProjects(resolvedDbPath);

  return result;
}
