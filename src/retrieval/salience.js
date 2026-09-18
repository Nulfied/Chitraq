/**
 * Salience: how prominent a piece of knowledge is in *this* memory.
 *
 * Section 22 is explicit that Chitraq should not imitate human forgetting.
 * Nothing here decays, expires or hides anything. Salience is a mild ranking
 * nudge and a sort order for browsing — the material you return to, that other
 * material points at, that carries evidence, and that you have confirmed,
 * surfaces a little sooner than material nobody has touched since it arrived.
 *
 * Two deliberate limits:
 *
 *   - It is **bounded** (0.85–1.15 as a ranking multiplier). A memory engine
 *     that ranks by popularity stops being able to find the thing you looked
 *     at once, two years ago, which is precisely what you need it for.
 *   - It is **deterministic and explainable**. No learned weights, no feedback
 *     loop that quietly buries what it has already buried.
 */

/**
 * @typedef {object} SalienceInput
 * @property {number} [access_count]
 * @property {string|null} [last_access]
 * @property {number} [degree]     active relationships touching this object
 * @property {number} [evidence]   pieces of evidence attached
 * @property {string} [review]
 */

/**
 * Raw salience, 0..1.
 * @param {SalienceInput} o
 * @param {{now?: number}} [opts]
 * @returns {{value: number, because: string[]}}
 */
export function compute(o, opts = {}) {
  const now = opts.now ?? Date.now();
  const because = [];

  // Attention. Logarithmic: the difference between 1 and 5 visits says more
  // than the difference between 50 and 54.
  const accesses = Number(o.access_count ?? 0);
  const attention = Math.min(1, Math.log1p(accesses) / Math.log1p(40));
  if (accesses > 0) because.push(`opened ${accesses}×`);

  // How recently that attention happened. Half-life of 60 days.
  let freshness = 0;
  if (o.last_access) {
    const days = (now - Date.parse(o.last_access)) / 86400000;
    freshness = Number.isFinite(days) ? Math.pow(0.5, Math.max(days, 0) / 60) : 0;
    if (freshness > 0.5) because.push('opened recently');
  }

  // Connectedness. Something eight other notes point at is load-bearing.
  const degree = Number(o.degree ?? 0);
  const connected = Math.min(1, degree / 8);
  if (degree > 2) because.push(`${degree} connections`);

  // Support. Claims with evidence behind them are worth surfacing.
  const evidence = Number(o.evidence ?? 0);
  const supported = Math.min(1, evidence / 4);
  if (evidence > 0) because.push(`${evidence} piece${evidence === 1 ? '' : 's'} of evidence`);

  const confirmed = o.review === 'confirmed' ? 1 : 0;
  if (confirmed) because.push('confirmed');

  const value =
    0.32 * attention +
    0.18 * freshness +
    0.25 * connected +
    0.15 * supported +
    0.10 * confirmed;

  return { value: Math.max(0, Math.min(1, value)), because };
}

/**
 * Salience as a ranking multiplier.
 *
 * Deliberately narrow. At the extremes this moves a result by ±15%, which is
 * enough to break ties between comparable matches and nowhere near enough to
 * float an irrelevant-but-popular note above a relevant one.
 *
 * @param {SalienceInput} o
 * @param {{now?: number}} [opts]
 * @returns {{multiplier: number, value: number, because: string[]}}
 */
export function multiplier(o, opts) {
  const { value, because } = compute(o, opts);
  return { multiplier: 0.85 + 0.3 * value, value: round(value), because };
}

/**
 * Recompute and store salience for a whole workspace.
 *
 * The stored column is what browse and timeline sort on. Ranking computes
 * salience live from columns it already has, so a stale column can never make
 * search wrong — at worst it makes a "most prominent" listing slightly out of
 * date until the next refresh.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @returns {{updated: number}}
 */
export function refresh(db, workspaceId) {
  const rows = db
    .prepare(
      `SELECT o.id, o.access_count, o.last_access, o.review,
              (SELECT COUNT(*) FROM relation r
               WHERE (r.src_id = o.id OR r.dst_id = o.id) AND r.state = 'active') AS degree,
              (SELECT COUNT(*) FROM evidence e
               WHERE e.target_kind = 'object' AND e.target_id = o.id) AS evidence
       FROM object o
       WHERE o.workspace_id = ? AND o.state != 'deleted'`
    )
    .all(workspaceId);

  const now = Date.now();
  const update = db.prepare('UPDATE object SET salience = ? WHERE id = ?');
  for (const row of rows) {
    update.run(compute({ ...row }, { now }).value, row.id);
  }
  return { updated: rows.length };
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 1e4) / 1e4;
}
