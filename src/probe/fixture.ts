/**
 * The probe fixture — a purpose-built vault designed to challenge the
 * machinery (Eric's ruling, 2026-11-14: the operational tests must be
 * runnable by ANYONE who installs mnemos, so the challenging vault is
 * generated, shipped, and deterministic — not Eric's live vault).
 *
 * Design dimensions (each exists to stress one behavior):
 *  - THREE projects with deliberate vocabulary collisions: `helios` (a solar
 *    dashboard with a genuine MEMORY-LEAK note) vs `terra` (a garden planner
 *    whose "vernalization memory" note must NOT surface for software
 *    questions) — the phantom-blend case, made portable.
 *  - The elegant-method case: a rare-named method documented in helios,
 *    referenced obliquely from a terra session query — the no-miss guarantee.
 *  - Rare-token anchors (`helios-kappa7`) that must cross any scope.
 *  - A stale trap: a superseded note beside its replacement — retrieval must
 *    return the replacement only.
 *  - Lineage: root → continues-child → branched-child session records, each
 *    with its own note (flag-gated cases).
 *  - Filler mass per project so the vault is realistic, not a toy.
 *
 * Determinism: fixed created dates in frontmatter, fixed config, no
 * dependence on the host machine's state. Assertions use top-N membership
 * with generous margins, never exact scores.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type NoteSeed = {
  title: string;
  type: string;
  project: string[];
  created: string;
  description: string;
  body: string;
  status?: string;
  supersededBy?: string;
};

const DESCRIPTION_LIMIT = 200;

function noteFile(seed: NoteSeed): string {
  const fm: string[] = [
    "---",
    // Schema warns on trailing periods ("one sentence adding context beyond
    // the title" — declarative, not narrated). Normalize at write time.
    `description: "${seed.description.replace(/"/g, "'").replace(/\.+$/, "")}"`,
    `type: ${seed.type}`,
    `project: [${seed.project.join(", ")}]`,
    `status: ${seed.status ?? "active"}`,
    `created: ${seed.created}`,
  ];
  if (seed.supersededBy) fm.push(`superseded_by: "${seed.supersededBy}"`);
  return `${fm.join("\n")}\n---\n\n# ${seed.title}\n\n${seed.body}\n`;
}

// ---------------------------------------------------------------------------
// The three collision projects. Titles are prose (multi-word); descriptions
// are one sentence each, under the 200-char limit, written to be relevance-
// decidable WITHOUT opening the note.
// ---------------------------------------------------------------------------

const HELIOS: NoteSeed[] = [
  {
    title: "helios project map",
    type: "moc",
    project: ["helios"],
    created: "2026-06-01",
    description: "Map for helios, the solar monitoring dashboard: current state, goals, and area pointers.",
    body: "Map for the helios solar monitoring dashboard.\n\n## Areas\n- [[helios memory leak on long dashboard sessions]]\n- [[helios chart data caching with ttl]]\n- [[helios the deltadiff method for config snapshots]]\n- [[helios kappa7 panel protocol quirks]]",
  },
  {
    title: "helios memory leak on long dashboard sessions",
    type: "learning",
    project: ["helios"],
    created: "2026-06-10",
    description: "Long helios dashboard sessions leaked ~40MB/hour from undisposed chart listeners; fixed by disposal on unmount.",
    body: "The dashboard leaked about 40MB per hour on long sessions. Root cause: chart.js event listeners were never disposed when panels unmounted. Fix: dispose every chart instance on unmount and drop the shared resize observer.\n\nVerified with a 12-hour soak: heap flat after the fix.\n\nRelated: [[helios chart data caching with ttl]]",
  },
  {
    title: "helios chart data caching with ttl",
    type: "decision",
    project: ["helios"],
    created: "2026-06-12",
    description: "Chart data caches with a 30-second TTL in helios; chosen over event-driven invalidation for simplicity.",
    body: "Decision: chart data is cached with a 30 second TTL. Event-driven invalidation was rejected — every panel would need its own subscription and the failure modes outnumbered the benefit.\n\nSuperseded note below (the TTL was 5s before this decision): [[helios old five second chart cache]]",
  },
  {
    title: "helios old five second chart cache",
    type: "decision",
    project: ["helios"],
    created: "2026-06-03",
    description: "Superseded: helios cached chart data with a 5 second TTL; replaced by the 30 second TTL decision.",
    body: "The first cache design used a 5 second TTL. It churned the API too hard. See the 30 second TTL decision — this note is superseded and should not surface for current questions.",
    status: "superseded",
    supersededBy: "helios chart data caching with ttl",
  },
  {
    title: "helios the deltadiff method for config snapshots",
    type: "learning",
    project: ["helios"],
    created: "2026-06-20",
    description: "The DeltaDiff method: diff two config snapshots by sorting stable keys first, so cosmetic ordering noise never shows as a change.",
    body: "The DeltaDiff method: to diff two configuration snapshots, sort both by their stable keys BEFORE comparing, then walk them in parallel. Cosmetic reordering never shows as a change, and insertions/deletions fall out of the walk naturally.\n\nThis turned a 200-line diff reviewer into a 30-line walk. It generalizes: any two ordered collections with stable identities diff cleanly this way.",
  },
  {
    title: "helios kappa7 panel protocol quirks",
    type: "learning",
    project: ["helios"],
    created: "2026-06-25",
    description: "The helios-kappa7 panel firmware drops telemetry frames above 40C ambient; retry with exponential backoff and jitter.",
    body: "Panels running the helios-kappa7 firmware silently drop telemetry frames when ambient temperature exceeds 40C. The retry needs exponential backoff with jitter — fixed-delay retries synchronized the fleet and made it worse.\n\nIdentifier note: the firmware string is helios-kappa7; hardware revisions before it (kappa6) do not show this.",
  },
  {
    title: "helios inverter reset needs two button holds",
    type: "insight",
    project: ["helios"],
    created: "2026-07-02",
    description: "Helios field inverters need two separate button holds to fully reset; one hold only clears the display.",
    body: "Field reports: one button hold clears the display but the inverter is still faulted. A full reset needs two separate holds with a 10 second gap. Documented for support.\n",
  },
  {
    title: "helios timezone bug in production graphs",
    type: "blocker",
    project: ["helios"],
    created: "2026-07-15",
    description: "Superseded: the helios timezone bug shipped in the June graphs release; fixed in the July patch — see the daylight-boundary note.",
    body: "Graphs drawn for the wrong day boundary in production. Root cause: the aggregation bucketed by UTC while the UI rendered local dates. Fixed in the July patch; see [[helios daylight boundary aggregation rule]].",
    status: "superseded",
    supersededBy: "helios daylight boundary aggregation rule",
  },
  {
    title: "helios daylight boundary aggregation rule",
    type: "decision",
    project: ["helios"],
    created: "2026-07-20",
    description: "Helios aggregates by the viewer's local midnight, never UTC midnight; production graphs follow the viewer's timezone.",
    body: "Rule: aggregation buckets close at the VIEWER's local midnight. UTC midnight buckets produced the June timezone bug. Every new graph type must state its boundary rule in the PR description.",
  },
  {
    title: "helios panel uptime report format",
    type: "insight",
    project: ["helios"],
    created: "2026-08-01",
    description: "The monthly helios uptime report rounds to whole hours and never shows fractions; support scripts parse that format.",
    body: "The uptime report shows whole hours only (no fractions) because the support tooling parses it with a fixed regex. Changing the format breaks downstream parsing — coordinate with support first.",
  },
  {
    title: "helios installer onboarding checklist",
    type: "insight",
    project: ["helios"],
    created: "2026-08-10",
    description: "New helios installers need the commissioning checklist before their first dashboard login is provisioned.",
    body: "Provisioning flow: commissioning checklist must be submitted BEFORE the first dashboard login is provisioned. Accounts created out of order get stuck in a half-activated state that support has to clear manually.",
  },
];

const TERRA: NoteSeed[] = [
  {
    title: "terra project map",
    type: "moc",
    project: ["terra"],
    created: "2026-06-05",
    description: "Map for terra, the garden planning database: current state, goals, and area pointers.",
    body: "Map for the terra garden planning database.\n\n## Areas\n- [[terra vernalization the winter memory of seeds]]\n- [[terra companion planting layout rules]]\n- [[terra soil ph log cadence]]\n- [[terra aurora9 cultivar trial results]]",
  },
  {
    title: "terra vernalization the winter memory of seeds",
    type: "learning",
    project: ["terra"],
    created: "2026-06-15",
    description: "Vernalization: many temperate seeds remember winter cold and will not germinate without it — the plant's seasonal memory.",
    body: "Vernalization is the plant's seasonal memory: temperate seeds and bulbs track accumulated cold and refuse to germinate until their winter requirement is met. This is why stored seeds fail in warm rooms — they never counted enough cold days.\n\nPractical rule for terra: chill-requiring seeds get a refrigerated stratification period before sowing.",
  },
  {
    title: "terra companion planting layout rules",
    type: "decision",
    project: ["terra"],
    created: "2026-06-22",
    description: "Terra's layout engine ranks companion pairs first and fills anti-companions into separate beds; the rules live in one table.",
    body: "Layout decision: companion pairs are ranked and placed first; anti-companion pairs are forced into separate beds. The compatibility table is the single source — the engine has no inline plant lore.",
  },
  {
    title: "terra soil ph log cadence",
    type: "learning",
    project: ["terra"],
    created: "2026-07-01",
    description: "Terra soil pH sampling is seasonal, not monthly; mid-summer readings run misleadingly high after irrigation.",
    body: "Sampling cadence: seasonal. Mid-summer pH readings run high right after irrigation and mislead amendment decisions — log at season boundaries, damp-soil only.",
  },
  {
    title: "terra aurora9 cultivar trial results",
    type: "insight",
    project: ["terra"],
    created: "2026-07-18",
    description: "The aurora-9 cultivar out-yielded the standard by 18% in the terra trial beds but needs a longer chill period.",
    body: "Trial results: the aurora-9 cultivar beat the standard bed by 18% yield, but its chill requirement is longer — it failed in the warm-winter bed. Identifier: aurora-9; the standard row is the control.",
  },
  {
    title: "terra seed inventory rotation rule",
    type: "decision",
    project: ["terra"],
    created: "2026-08-05",
    description: "Terra seed inventory rotates oldest-first; anything older than three seasons is composted, not sold.",
    body: "Rotation rule: oldest seed lots ship first; lots older than three seasons are composted. Germination guarantees require it.",
  },
  {
    title: "terra greenhouse humidity alarm thresholds",
    type: "insight",
    project: ["terra"],
    created: "2026-08-20",
    description: "Terra greenhouse alarms fire at 85% humidity sustained 30 minutes; single spikes are ignored to avoid sprinkler false trips.",
    body: "Alarm thresholds: 85% relative humidity sustained for 30 minutes triggers the vent + alarm. Single spikes are ignored — the sprinkler false-tripped twice before the sustained window was added.",
  },
  {
    title: "terra compost temperature logging",
    type: "insight",
    project: ["terra"],
    created: "2026-09-01",
    description: "Compost piles are logged at turn-day only; between-turn readings were noise that never changed a decision.",
    body: "Compost temperature is logged on turn days only. Daily between-turn readings produced 200 data points that never once changed a decision — the turn-day curve is the signal.",
  },
  {
    title: "terra water budget by bed",
    type: "insight",
    project: ["terra"],
    created: "2026-09-15",
    description: "Terra water budgets are per bed, not per crop; mixed beds are budgeted by the thirstiest occupant.",
    body: "Water budgeting is per bed. Mixed beds get the thirstiest occupant's budget — the alternatives (averaging, per-plant) produced chronically dry corners.",
  },
];

const ATLAS: NoteSeed[] = [
  {
    title: "atlas project map",
    type: "moc",
    project: ["atlas"],
    created: "2026-06-08",
    description: "Map for atlas, the trip planning workspace: current state, goals, and area pointers.",
    body: "Map for the atlas trip planning workspace.\n\n## Areas\n- [[atlas booking cancellation windows]]\n- [[atlas seat map parsing quirks]]\n- [[atlas travel day buffer rule]]",
  },
  {
    title: "atlas booking cancellation windows",
    type: "decision",
    project: ["atlas"],
    created: "2026-06-18",
    description: "Atlas bookings assume a 24-hour free cancellation window and never rely on it within 48 hours of departure.",
    body: "Policy: every atlas booking plan assumes the 24-hour free cancellation window exists, but no plan may RELY on it inside 48 hours of departure — the window is a safety margin, not a feature.",
  },
  {
    title: "atlas seat map parsing quirks",
    type: "learning",
    project: ["atlas"],
    created: "2026-07-05",
    description: "Airline seat maps arrive in three encodings; atlas normalizes them at ingest because downstream code assumes one shape.",
    body: "Seat maps arrive in three encodings (SVG, JSON grid, legacy bitmap rows). Normalization happens at ingest — downstream code assumes exactly one normalized shape.",
  },
  {
    title: "atlas travel day buffer rule",
    type: "decision",
    project: ["atlas"],
    created: "2026-07-25",
    description: "Atlas itineraries insert a full buffer day after any leg with a connection tighter than 90 minutes.",
    body: "Rule: a full buffer day follows any leg whose connection is tighter than 90 minutes. Missed connections on tight itineraries cost entire days in visa-bound countries.",
  },
  {
    title: "atlas booking reference checksum",
    type: "learning",
    project: ["atlas"],
    created: "2026-08-12",
    description: "Atlas booking references like XB-2214 use a two-letter prefix plus a number; validation lives in one function.",
    body: "Booking reference format: two-letter prefix + dash + number (example XB-2214). Validation lives in one function — the earlier per-callsite regexes disagreed and accepted malformed refs.",
  },
  {
    title: "atlas visa document checklist",
    type: "insight",
    project: ["atlas"],
    created: "2026-08-28",
    description: "Atlas visa checklists are per passport, not per traveler; dual nationals generate two checklists.",
    body: "Visa checklists key on PASSPORT, not traveler. A dual-national traveler legitimately generates two checklists — the earlier per-traveler model silently dropped one.",
  },
];

/** Filler mass so the vault is realistic — small, true, context-free notes. */
function filler(project: string, n: number): NoteSeed[] {
  const topics = [
    ["standup notes", "The weekly standup notes are written directly into the daily log, not a separate file."],
    ["rename discussion", "The internal rename discussion settled on keeping the old label in parentheses for one release."],
    ["dependency bump", "The quarterly dependency bump is batched — no single-version upgrades between release cuts."],
    ["docs polish pass", "The docs polish pass happens after feature freeze, never during."],
    ["backup verification", "Backups are verified monthly by restoring into a scratch copy and diffing."],
    ["theme contrast audit", "The contrast audit runs on every new theme; two themes shipped with failing contrast before it existed."],
  ];
  const out: NoteSeed[] = [];
  for (let i = 0; i < n; i++) {
    const [t, d] = topics[i % topics.length];
    const month = 6 + Math.floor(i / topics.length);
    out.push({
      title: `${project} ${t} ${i + 1}`,
      type: "insight",
      project: [project],
      created: `2026-${String(month).padStart(2, "0")}-15`,
      description: `${d.slice(0, 180)}`,
      body: `${d}\n`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session records (ops/sessions/) — the lineage graph for the flag-gated
// relationship probes. The root carries one distinctive note; each child
// inherits by edge, and the branch adds its own.
// ---------------------------------------------------------------------------

const SESSION_NOTES: NoteSeed[] = [
  {
    title: "lineage root session note the lantern backlight flicker",
    type: "learning",
    project: ["helios"],
    created: "2026-10-01",
    description: "The helios lantern-mode backlight flickers below 20% brightness; the PWM floor is the fix candidate.",
    body: "In lantern mode the backlight flickers below 20% brightness. Root-cause candidate: the PWM floor is lower than the panel's stable drive threshold. Distinctive token for the probe: lantern-flicker-17.",
  },
  {
    title: "lineage branch session note the lantern thermal cap",
    type: "learning",
    project: ["helios"],
    created: "2026-10-20",
    description: "Lantern mode also caps output thermally at 35C board temperature; the flicker fix must respect the cap.",
    body: "Follow-up from the branch: lantern mode has an independent thermal cap at 35C board temperature. Any flicker fix must respect both limits. Branch-distinctive token: lantern-thermal-cap-8.",
  },
  {
    title: "lineage unrelated session note the terra misting schedule",
    type: "learning",
    project: ["terra"],
    created: "2026-10-22",
    description: "The terra misting schedule moved to dawn-only; midday misting burned leaf edges in the August trial.",
    body: "Unrelated session: the misting schedule moved to dawn-only after midday misting burned leaf edges in August. Unrelated-token: misting-dawn-only-3.",
  },
];

const SESSIONS: Array<{
  id: string;
  continues?: string;
  branchedFrom?: string;
  project: string;
  body: string;
}> = [
  {
    id: "ses_probe_root",
    project: "helios",
    body: "Root session: investigated the lantern backlight flicker; wrote [[lineage root session note the lantern backlight flicker]].",
  },
  {
    id: "ses_probe_child",
    continues: "ses_probe_root",
    project: "helios",
    body: "Continuation of ses_probe_root: kept working the flicker, verified the PWM floor hypothesis on a bench panel.",
  },
  {
    id: "ses_probe_branch",
    branchedFrom: "ses_probe_root",
    project: "helios",
    body: "Branched from ses_probe_root: explored the thermal side; wrote [[lineage branch session note the lantern thermal cap]].",
  },
  {
    id: "ses_probe_unrelated",
    project: "terra",
    body: "Unrelated garden session; wrote [[lineage unrelated session note the terra misting schedule]].",
  },
];

export type FixtureSummary = { notes: number; sessions: number; root: string };

/**
 * Materialize the fixture vault at `dir`. The result is a valid, rule-
 * compliant vault: fixed dates, promoted notes in place, ops state files for
 * each project, session records with lineage edges, and a fixed config with
 * the session-scope flag OFF (the runner enables it per-case in its copy).
 */
export async function buildProbeVault(dir: string): Promise<FixtureSummary> {
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, ".mnemos"), { recursive: true });
  await fs.mkdir(path.join(dir, "notes"), { recursive: true });
  await fs.mkdir(path.join(dir, "inbox"), { recursive: true });
  await fs.mkdir(path.join(dir, "self"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "self", "identity.md"),
    "# Identity\n\nThe probe fixture identity: a coding agent with persistent memory.\n",
  );

  // The fixture vault is a REAL vault: it ships the package scaffold's own
  // templates (one source of truth — no embedded copies to drift, the
  // lockstep trap twice before) and a config that maps `moc` to the map
  // schema, exactly as `mnemos init` would. Missing this made the product's
  // own validator reject every fixture map note with "Invalid type value: moc".
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const scaffoldTemplates = path.resolve(__dirname, "..", "..", "scaffold", "templates");
  await fs.mkdir(path.join(dir, "templates"), { recursive: true });
  for (const name of ["note.md", "map.md"]) {
    await fs.copyFile(path.join(scaffoldTemplates, name), path.join(dir, "templates", name));
  }

  const config = [
    "vault:",
    "  version: \"0.1\"",
    "templates:",
    "  default: templates/note.md",
    "  by_type:",
    "    map: templates/map.md",
    "    moc: templates/map.md",
    "promote:",
    "  auto: true",
    "retrieval:",
    "  session_scope:",
    "    enabled: false",
    "wake:",
    "  project_paths:",
    `    "${path.join(dir, "repos", "helios")}": helios`,
    `    "${path.join(dir, "repos", "terra")}": terra`,
  ].join("\n");
  await fs.writeFile(path.join(dir, "mnemos.config.yaml"), config + "\n");

  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
  const all = [
    ...HELIOS,
    ...TERRA,
    ...ATLAS,
    ...filler("helios", 6),
    ...filler("terra", 6),
    ...filler("atlas", 6),
    ...SESSION_NOTES,
  ];
  for (const seed of all) {
    if (seed.description.length > DESCRIPTION_LIMIT) {
      throw new Error(`fixture seed description too long (${seed.description.length}): ${seed.title}`);
    }
    await fs.writeFile(path.join(dir, "notes", `${slug(seed.title)}.md`), noteFile(seed));
  }

  for (const project of ["helios", "terra", "atlas"]) {
    const opsDir = path.join(dir, "ops", project);
    await fs.mkdir(opsDir, { recursive: true });
    await fs.writeFile(
      path.join(opsDir, "goals.md"),
      `# ${project} Goals\n\nKeep the probe fixture's per-project state files distinct.\n`,
    );
    await fs.writeFile(
      path.join(opsDir, "daily.md"),
      `# ${project} Daily Log\n\n2026-10-01: fixture seed line for ${project}.\n`,
    );
    await fs.writeFile(path.join(opsDir, "reminders.md"), `# ${project} Reminders\n\n- [ ] 2026-12-01: fixture reminder for ${project}\n`);
  }

  const sessionsDir = path.join(dir, "ops", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  for (const s of SESSIONS) {
    const fm = ["---", `session: ${s.id}`, "created: 2026-10-01"];
    if (s.continues) fm.push(`continues: ${s.continues}`);
    if (s.branchedFrom) fm.push(`branched_from: ${s.branchedFrom}`);
    await fs.writeFile(
      path.join(sessionsDir, `${s.id}.md`),
      `${fm.join("\n")}\n---\n\n# Session ${s.id}\n\n${s.body}\n`,
    );
  }

  // Repo directories so the path bridge can resolve per-project wakes.
  for (const project of ["helios", "terra"]) {
    await fs.mkdir(path.join(dir, "repos", project), { recursive: true });
  }

  return { notes: all.length, sessions: SESSIONS.length, root: dir };
}
