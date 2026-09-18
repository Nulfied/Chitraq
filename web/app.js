/**
 * Chitraq web interface.
 *
 * Plain ES modules, no framework, no build step — consistent with the rest of
 * the project. The whole app is a router, a fetch wrapper and a set of view
 * functions that return DOM.
 *
 * The one thing the interface is opinionated about: provenance is always
 * visible. Every piece of knowledge shows where it came from and whether a
 * human has checked it, and anything merely *proposed* is drawn so that it can
 * never be mistaken for something already in memory.
 */

const api = {
  /**
   * @param {string} path
   * @param {RequestInit & {body?: any}} [opts]
   */
  async call(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: 'The server sent something unreadable.' }));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  },
  get: (p) => api.call(p),
  post: (p, body) => api.call(p, { method: 'POST', body }),
  patch: (p, body) => api.call(p, { method: 'PATCH', body }),
  del: (p) => api.call(p, { method: 'DELETE' }),
};

const VIEWS = [
  { id: 'ask', label: 'Ask' },
  { id: 'search', label: 'Search' },
  { id: 'capture', label: 'Capture' },
  { id: 'review', label: 'Review', badge: 'pendingProposals' },
  { id: 'conflicts', label: 'Conflicts', badge: 'openConflicts', alert: true },
  { id: 'timeline', label: 'Timeline' },
  { id: 'graph', label: 'Connections' },
  { id: 'history', label: 'Activity' },
  { id: 'status', label: 'Status' },
];

const state = { stats: null, view: 'ask', param: null };

// ------------------------------------------------------------------ boot

window.addEventListener('hashchange', route);
route();

async function route() {
  const [view, param] = decodeURIComponent(location.hash.slice(1) || 'ask').split('/');
  state.view = view || 'ask';
  state.param = param ?? null;
  await refreshStats();
  renderNav();
  await renderView();
  window.scrollTo(0, 0);
}

async function refreshStats() {
  try {
    state.stats = await api.get('/stats');
  } catch {
    state.stats = null;
  }
}

function renderNav() {
  const nav = el('nav');
  nav.replaceChildren(
    ...VIEWS.map((v) => {
      const count = state.stats?.[v.badge] ?? 0;
      return h('button', {
        'aria-current': String(state.view === v.id),
        onclick: () => go(v.id),
      }, [
        v.label,
        v.badge && count > 0
          ? h('span', { class: `count${v.alert ? ' alert' : ''}` }, [String(count)])
          : null,
      ]);
    })
  );

  const s = state.stats;
  el('foot').replaceChildren(
    ...(s
      ? [
          h('div', {}, [`${s.objects} objects · ${s.relations} links`]),
          h('div', {}, [`${s.versions} versions kept`]),
          h('div', { style: 'margin-top:6px' }, [
            s.embeddings > 0 ? 'semantic search on' : 'lexical search only',
          ]),
        ]
      : [h('div', {}, ['memory unavailable'])])
  );
}

async function renderView() {
  const main = el('main');
  main.replaceChildren(h('div', { class: 'spinner' }, ['…']));
  try {
    const node = await views[state.view]?.(state.param);
    main.replaceChildren(node ?? notFound());
  } catch (err) {
    main.replaceChildren(
      h('div', { class: 'notice' }, [String(err.message ?? err)]),
      h('button', { class: 'btn', onclick: renderView }, ['Try again'])
    );
  }
}

/** @param {string} view @param {string} [param] */
function go(view, param) {
  location.hash = param ? `${view}/${param}` : view;
}

// ----------------------------------------------------------------- views

const views = {
  // -------------------------------------------------------------- ask
  async ask() {
    const results = h('div', {});
    const input = h('input', {
      type: 'text',
      placeholder: 'Why did we drop the Redis cache?',
      autofocus: 'true',
    });

    async function submit() {
      const question = input.value.trim();
      if (!question) return;
      results.replaceChildren(h('div', { class: 'spinner' }, ['Searching memory…']));
      try {
        const a = await api.post('/ask', { question });
        results.replaceChildren(answerView(a));
      } catch (err) {
        results.replaceChildren(h('div', { class: 'notice' }, [String(err.message)]));
      }
    }

    return h('div', {}, [
      h('h1', {}, ['Ask your memory']),
      h('p', { class: 'lede' }, [
        'Answers are built only from what you have captured. When your memory does not ' +
          'contain the answer, Chitraq says so rather than inventing one.',
      ]),
      // A real form, so Enter submits natively and mobile keyboards show "Go".
      h('form', {
        class: 'row',
        style: 'margin-bottom:18px',
        onsubmit: (e) => { e.preventDefault(); submit(); },
      }, [
        input,
        h('button', { class: 'btn primary', style: 'flex:0 0 auto', type: 'submit' }, ['Ask']),
      ]),
      results,
    ]);
  },

  // ----------------------------------------------------------- search
  async search() {
    const results = h('div', {});
    const input = h('input', { type: 'search', placeholder: 'kind:decision sqlite after:2025-01' });

    async function submit() {
      const q = input.value.trim();
      if (!q) return;
      results.replaceChildren(h('div', { class: 'spinner' }, ['…']));
      const found = await api.get(`/search?q=${encodeURIComponent(q)}&limit=25`);
      results.replaceChildren(
        h('div', { class: 'meta', style: 'margin-bottom:12px' }, [
          found.total
            ? `${found.total} match${found.total === 1 ? '' : 'es'} · ${found.signals.join(' + ')} · ${found.latencyMs}ms`
            : '',
        ]),
        ...(found.results.length
          ? found.results.map(objectCard)
          : [h('div', { class: 'empty' }, [`Nothing in memory matches “${q}”.`])])
      );
    }

    return h('div', {}, [
      h('h1', {}, ['Search']),
      h('p', { class: 'lede' }, [
        'Combines exact words, meaning, structure and time. Filters: ',
        h('code', {}, ['kind:']), ', ', h('code', {}, ['origin:']), ', ',
        h('code', {}, ['after:']), ', ', h('code', {}, ['before:']), ', ',
        h('code', {}, ['is:confirmed']), ', quoted phrases, and ', h('code', {}, ['-exclude']), '.',
      ]),
      h('form', {
        class: 'row',
        style: 'margin-bottom:18px',
        onsubmit: (e) => { e.preventDefault(); submit(); },
      }, [
        input,
        h('button', { class: 'btn primary', style: 'flex:0 0 auto', type: 'submit' }, ['Search']),
      ]),
      results,
    ]);
  },

  // ---------------------------------------------------------- capture
  async capture() {
    const title = h('input', { type: 'text', placeholder: 'What is this about?' });
    const body = h('textarea', { placeholder: 'The detail worth keeping…' });
    const kind = h('select', {}, [
      ...['note', 'decision', 'observation', 'fact', 'lesson', 'question', 'hypothesis', 'task'].map(
        (k) => h('option', { value: k }, [k])
      ),
    ]);
    const out = h('div', {});

    const doc = h('textarea', {
      placeholder: 'Paste a document, page or transcript. Chitraq will propose what it contains.',
      style: 'min-height:150px',
    });
    const docOut = h('div', {});

    async function remember() {
      if (!title.value.trim()) return toast('Give it a title first.', true);
      out.replaceChildren(h('div', { class: 'spinner' }, ['Remembering…']));
      const res = await api.post('/remember', {
        title: title.value.trim(),
        body: body.value,
        kind: kind.value,
      });
      title.value = '';
      body.value = '';
      await refreshStats();
      renderNav();
      out.replaceChildren(
        h('div', { class: 'card' }, [
          h('span', { class: 'title' }, ['Remembered']),
          h('p', { class: 'body' }, [res.object.title]),
          h('div', { class: 'actions', style: 'margin-top:10px' }, [
            h('button', { class: 'btn quiet', onclick: () => go('object', res.object.id) }, ['Open it']),
            res.enrichment?.conflicts?.length
              ? h('button', { class: 'btn danger', onclick: () => go('conflicts') }, [
                  `⚠ disagrees with ${res.enrichment.conflicts.length} thing(s)`,
                ])
              : null,
            res.enrichment?.proposals?.filter((p) => p.status === 'pending').length
              ? h('button', { class: 'btn', onclick: () => go('review') }, ['Review suggestions'])
              : null,
          ]),
        ])
      );
    }

    async function ingest() {
      if (!doc.value.trim()) return toast('Paste something first.', true);
      docOut.replaceChildren(h('div', { class: 'spinner' }, ['Reading…']));
      const res = await api.post('/ingest', { text: doc.value, filename: 'pasted.md' });
      await refreshStats();
      renderNav();
      docOut.replaceChildren(
        res.deduplicated
          ? h('div', { class: 'card' }, ['You have captured this exact content before.'])
          : h('div', { class: 'card' }, [
              h('span', { class: 'title' }, ['Captured, nothing written yet']),
              h('p', { class: 'body' }, [
                `The document is stored verbatim. ${res.proposals.length} piece(s) of knowledge ` +
                  `were proposed from it — none becomes memory until you accept it.`,
              ]),
              h('div', { class: 'actions', style: 'margin-top:10px' }, [
                h('button', { class: 'btn primary', onclick: () => go('review') }, ['Review them']),
              ]),
            ])
      );
      doc.value = '';
    }

    return h('div', {}, [
      h('h1', {}, ['Capture']),
      h('p', { class: 'lede' }, ['Write something down, or hand Chitraq a document to read.']),

      h('h2', {}, ['Remember something']),
      h('div', { class: 'card' }, [
        h('div', { class: 'field' }, [h('label', {}, ['Title']), title]),
        h('div', { class: 'field' }, [h('label', {}, ['Detail']), body]),
        h('div', { class: 'field', style: 'max-width:200px' }, [h('label', {}, ['Kind']), kind]),
        h('div', { class: 'actions' }, [
          h('button', { class: 'btn primary', onclick: remember }, ['Remember']),
          h('span', { class: 'hint' }, ['Saved as yours — origin: user, no confidence score.']),
        ]),
      ]),
      out,

      h('h2', {}, ['Read a document']),
      h('div', { class: 'card' }, [
        h('div', { class: 'field' }, [doc]),
        h('div', { class: 'actions' }, [
          h('button', { class: 'btn', onclick: ingest }, ['Read it']),
          h('span', { class: 'hint' }, ['Stored verbatim; what it contains becomes proposals.']),
        ]),
      ]),
      docOut,
    ]);
  },

  // ----------------------------------------------------------- review
  async review() {
    const pending = await api.get('/proposals?status=pending&limit=60');

    if (!pending.length) {
      return h('div', {}, [
        h('h1', {}, ['Review']),
        h('p', { class: 'lede' }, ['Suggestions wait here until you decide. Nothing is added to memory on its own.']),
        h('div', { class: 'empty' }, ['Nothing waiting for you.']),
      ]);
    }

    const list = h('div', {});
    list.replaceChildren(...pending.map((p) => proposalCard(p, list)));

    return h('div', {}, [
      h('h1', {}, ['Review']),
      h('p', { class: 'lede' }, [
        `${pending.length} suggestion${pending.length === 1 ? '' : 's'} waiting. These are proposals — ` +
          'they are not part of your memory until you accept them, and declining one is recorded too.',
      ]),
      list,
    ]);
  },

  // -------------------------------------------------------- conflicts
  async conflicts() {
    const open = await api.get('/conflicts?status=open&limit=60');

    if (!open.length) {
      return h('div', {}, [
        h('h1', {}, ['Conflicts']),
        h('p', { class: 'lede' }, ['Where two things you captured disagree with each other.']),
        h('div', { class: 'empty' }, ['No open disagreements.']),
      ]);
    }

    return h('div', {}, [
      h('h1', {}, ['Conflicts']),
      h('p', { class: 'lede' }, [
        'Chitraq does not resolve these for you. It keeps both, shows them together, and lets ' +
          'you decide which is right — or record that both were true at different times.',
      ]),
      ...open.map((c) =>
        h('div', { class: 'card conflict' }, [
          h('div', { class: 'meta' }, [
            `${c.kind} · found by ${c.detected_by}${c.confidence ? ` · confidence ${c.confidence}` : ''}`,
          ]),
          c.detail?.reason ? h('p', { class: 'body' }, [c.detail.reason]) : null,
          h('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:4px' }, [
            h('span', { class: 'citation', onclick: () => go('object', c.a_id) }, [c.a_title ?? c.a_id]),
            c.b_id
              ? h('span', { class: 'citation', onclick: () => go('object', c.b_id) }, [c.b_title ?? c.b_id])
              : null,
          ]),
          h('div', { class: 'actions', style: 'margin-top:12px' }, [
            h('button', {
              class: 'btn',
              onclick: async (e) => {
                await api.post(`/conflicts/${c.id}/resolve`, { status: 'acknowledged' });
                toast('Acknowledged — it stays on record.');
                e.target.closest('.card').remove();
                await refreshStats();
                renderNav();
              },
            }, ['I know about this']),
            h('button', {
              class: 'btn quiet',
              onclick: async (e) => {
                await api.post(`/conflicts/${c.id}/resolve`, {
                  status: 'dismissed',
                  resolution: 'not a real contradiction',
                });
                toast('Dismissed.');
                e.target.closest('.card').remove();
                await refreshStats();
                renderNav();
              },
            }, ['Not a real conflict']),
          ]),
        ])
      ),
    ]);
  },

  // --------------------------------------------------------- timeline
  async timeline() {
    const items = await api.get('/timeline?limit=100');
    if (!items.length) {
      return h('div', {}, [
        h('h1', {}, ['Timeline']),
        h('div', { class: 'empty' }, ['Memory is empty. Capture something first.']),
      ]);
    }
    return h('div', {}, [
      h('h1', {}, ['Timeline']),
      h('p', { class: 'lede' }, ['Everything in memory, by when it happened or was recorded.']),
      h('div', { class: 'card' },
        items.map((o) =>
          h('div', { class: 'timeline-entry' }, [
            h('span', { class: 'when' }, [(o.occurred_at ?? o.created_at).slice(0, 10)]),
            h('div', {}, [
              h('span', { class: 'citation', style: 'margin-left:0', onclick: () => go('object', o.id) }, [o.title]),
              badgeRow(o),
            ]),
          ])
        )
      ),
    ]);
  },

  // ------------------------------------------------------------ graph
  async graph() {
    const { nodes, edges } = await api.get('/graph?limit=90');
    if (!nodes.length) {
      return h('div', {}, [h('h1', {}, ['Connections']), h('div', { class: 'empty' }, ['Nothing to draw yet.'])]);
    }
    return h('div', {}, [
      h('h1', {}, ['Connections']),
      h('p', { class: 'lede' }, [
        'How your memory links together. Solid lines are links you made; dashed lines were ' +
          'proposed by a capability and accepted.',
      ]),
      drawGraph(nodes, edges),
    ]);
  },

  // ---------------------------------------------------------- history
  async history() {
    const events = await api.get('/events?limit=120');
    return h('div', {}, [
      h('h1', {}, ['Activity']),
      h('p', { class: 'lede' }, [
        'Every change to memory, appended and never rewritten. This is what makes it possible ' +
          'to ask why something is the way it is.',
      ]),
      h('div', { class: 'card' },
        events.map((e) =>
          h('div', { class: 'timeline-entry' }, [
            h('span', { class: 'when' }, [e.at.slice(5, 16).replace('T', ' ')]),
            h('div', {}, [
              h('span', {}, [e.type.replace(/([a-z])([A-Z])/g, '$1 $2')]),
              ' ',
              e.subject_id
                ? h('span', { class: 'mono citation', onclick: () => go('object', e.subject_id) }, [e.subject_id])
                : null,
              h('span', { class: 'meta' }, [` by ${e.actor_kind}`]),
            ]),
          ])
        )
      ),
    ]);
  },

  // ----------------------------------------------------------- status
  async status() {
    const [caps, stats] = await Promise.all([api.get('/capabilities'), api.get('/stats')]);

    return h('div', {}, [
      h('h1', {}, ['Status']),
      h('p', { class: 'lede' }, ['What memory holds, and which intelligence is available to work over it.']),

      ...(stats.health?.warnings ?? []).map((w) => h('div', { class: 'notice' }, [w])),

      h('div', { class: 'stat-grid' }, [
        stat(stats.objects, 'objects'),
        stat(stats.relations, 'links'),
        stat(stats.versions, 'versions'),
        stat(stats.sources, 'sources'),
        stat(stats.embeddings, 'vectors'),
        stat(stats.pendingProposals, 'pending', stats.pendingProposals > 0),
        stat(stats.openConflicts, 'conflicts', stats.openConflicts > 0),
        stat(stats.events, 'events'),
      ]),

      h('h2', {}, ['Providers']),
      h('div', { class: 'card' },
        caps.providers.map((p) =>
          h('div', { class: 'provider' }, [
            h('span', { class: `dot${p.available ? ' up' : ''}` }, []),
            h('div', { style: 'flex:1' }, [
              h('div', {}, [p.label]),
              h('div', { class: 'meta' }, [
                `${p.locality} · ${p.cost}${p.deterministic ? ' · deterministic' : ''} · ` +
                  `${p.capabilities.length} capabilit${p.capabilities.length === 1 ? 'y' : 'ies'}`,
              ]),
            ]),
            h('span', { class: `badge ${p.available ? 'confirmed' : 'state'}` }, [
              p.available ? 'available' : 'not reachable',
            ]),
          ])
        )
      ),

      h('h2', {}, ['Capabilities']),
      h('div', { class: 'card' },
        Object.entries(caps.coverage).map(([name, c]) =>
          h('div', { class: 'provider' }, [
            h('span', { class: `dot${c.best ? ' up' : ''}` }, []),
            h('div', { style: 'flex:1' }, [
              h('div', { class: 'mono', style: 'color:var(--text)' }, [name]),
              h('div', { class: 'meta' }, [
                c.best
                  ? c.degraded
                    ? `${c.best} — built-in deterministic floor`
                    : c.best
                  : 'no provider',
              ]),
            ]),
          ])
        )
      ),

      h('h2', {}, ['Policy']),
      h('div', { class: 'card' }, [
        h('dl', { class: 'kv' }, [
          h('dt', {}, ['Prefer']), h('dd', {}, [caps.policy.prefer]),
          h('dt', {}, ['Remote calls']), h('dd', {}, [caps.policy.allowRemote ? 'allowed' : 'off']),
          h('dt', {}, ['Paid providers']), h('dd', {}, [caps.policy.allowPaid ? 'allowed' : 'off']),
        ]),
        h('p', { class: 'hint' }, [
          'Nothing leaves this machine while remote calls are off. Set CHITRAQ_ALLOW_REMOTE=true ' +
            'to permit them.',
        ]),
      ]),

      h('div', { class: 'actions', style: 'margin-top:18px' }, [
        h('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = 'Rebuilding…';
            const r = await api.post('/reindex', {});
            toast(`Rebuilt ${r.chunks} chunks from ${r.objects} objects.`);
            renderView();
          },
        }, ['Rebuild index']),
        h('button', {
          class: 'btn quiet',
          onclick: () => window.open('/api/export', '_blank'),
        }, ['Export everything']),
      ]),
    ]);
  },

  // ----------------------------------------------------------- object
  async object(id) {
    if (!id) return notFound();
    const d = await api.get(`/objects/${id}`);
    const o = d.object;

    return h('div', {}, [
      h('span', { class: 'breadcrumb', onclick: () => history.back() }, ['← back']),
      h('h1', {}, [o.title]),
      badgeRow(o, true),

      o.state !== 'active'
        ? h('div', { class: 'notice', style: 'margin-top:14px' }, [
            o.state === 'superseded'
              ? 'This has been superseded. It is kept because what you used to believe is part of the record.'
              : `This is ${o.state}.`,
          ])
        : null,

      o.body ? h('p', { class: 'body', style: 'margin:16px 0;font-size:15.5px' }, [o.body]) : null,

      h('div', { class: 'actions', style: 'margin:16px 0' }, [
        o.review !== 'confirmed'
          ? h('button', {
              class: 'btn primary',
              onclick: async () => {
                await api.post(`/objects/${id}/confirm`, {});
                toast('Confirmed.');
                renderView();
              },
            }, ['Confirm this'])
          : null,
        h('button', {
          class: 'btn',
          onclick: async () => {
            const res = await api.post(`/objects/${id}/relate`, {});
            toast(`${res.similar.length} similar item(s); ${res.proposals.length} link(s) proposed.`);
            if (res.proposals.length) go('review');
          },
        }, ['Find related']),
        h('button', {
          class: 'btn quiet',
          onclick: async () => {
            if (!confirm('Remove this from retrieval? History is kept and it can be restored.')) return;
            await api.del(`/objects/${id}`);
            toast('Removed from retrieval.');
            go('timeline');
          },
        }, ['Forget']),
      ]),

      // Both directions of supersession, so the chain is walkable from either
      // end: what this replaced, and what replaced it.
      d.supersedes?.length
        ? h('div', {}, [
            h('h2', {}, ['This replaced']),
            h('div', { class: 'card' },
              d.supersedes.map((s) =>
                h('div', { style: 'padding:5px 0' }, [
                  h('span', { class: 'citation', style: 'margin-left:0', onclick: () => go('object', s.id) }, [
                    s.title,
                  ]),
                  h('span', { class: 'meta' }, [` — until ${s.updated_at.slice(0, 10)}`]),
                ])
              )
            ),
          ])
        : null,

      o.superseded_by
        ? h('div', {}, [
            h('h2', {}, ['Replaced by']),
            h('div', { class: 'card' }, [
              h('span', { class: 'citation', style: 'margin-left:0', onclick: () => go('object', o.superseded_by) }, [
                'the current version',
              ]),
            ]),
          ])
        : null,

      d.conflicts.length
        ? h('div', {}, [
            h('h2', {}, ['Disagreements']),
            ...d.conflicts.map((c) =>
              h('div', { class: 'card conflict' }, [
                h('p', { class: 'body' }, [c.detail?.reason ?? c.kind]),
                c.b_id
                  ? h('span', { class: 'citation', onclick: () => go('object', c.b_id === id ? c.a_id : c.b_id) },
                      [c.b_id === id ? c.a_title : c.b_title])
                  : null,
              ])
            ),
          ])
        : null,

      d.relations.outgoing.length || d.relations.incoming.length
        ? h('div', {}, [
            h('h2', {}, ['Connected to']),
            h('div', { class: 'card' }, [
              ...d.relations.outgoing.map((r) => relationRow(r.type, r)),
              ...d.relations.incoming.map((r) => relationRow(r.display_type, r)),
            ]),
          ])
        : null,

      d.evidence.length
        ? h('div', {}, [
            h('h2', {}, ['Evidence']),
            h('div', { class: 'card' },
              d.evidence.map((e) =>
                h('div', { style: 'padding:7px 0;border-bottom:1px solid var(--border)' }, [
                  h('span', { class: `badge ${e.stance === 'contradicts' ? 'warn' : 'kind'}` }, [e.stance]),
                  ' ',
                  h('span', { class: 'meta' }, [e.source_title ?? e.object_title ?? e.source_id ?? '']),
                  e.excerpt ? h('p', { class: 'excerpt' }, [`“${e.excerpt}”`]) : null,
                ])
              )
            ),
          ])
        : null,

      h('h2', {}, ['How this changed']),
      h('div', { class: 'card' },
        d.history.map((v, i) =>
          h('div', { class: `version${i === d.history.length - 1 ? ' current' : ''}` }, [
            h('div', {}, [
              h('strong', {}, [`v${v.version}`]),
              ' ',
              h('span', {}, [v.change_kind]),
              v.change_reason ? h('span', { class: 'meta' }, [` — ${v.change_reason}`]) : null,
            ]),
            h('div', { class: 'meta' }, [
              `${v.recorded_at.slice(0, 16).replace('T', ' ')} by ${v.actor_kind}`,
            ]),
            i !== d.history.length - 1 && v.body
              ? h('p', { class: 'excerpt' }, [truncate(v.body, 180)])
              : null,
          ])
        )
      ),

      h('h2', {}, ['Where this came from']),
      h('div', { class: 'card' }, [
        h('dl', { class: 'kv' },
          d.provenance.flatMap((p) => [
            h('dt', {}, [`version ${p.target_version}`]),
            h('dd', {}, [
              p.method === 'user'
                ? 'you wrote it'
                : `${p.method}${p.model ? ` · ${p.model}` : ''}${p.provider ? ` · via ${p.provider}` : ''}`,
            ]),
          ])
        ),
        h('p', { class: 'hint' }, [h('span', { class: 'mono' }, [o.id])]),
      ]),
    ]);
  },
};

// ------------------------------------------------------------ components

/** @param {any} a */
function answerView(a) {
  const nodes = [];

  if (a.grounded) {
    nodes.push(
      h('div', { class: 'answer' }, [
        ...String(a.answer).split('\n').filter(Boolean).map((p) => h('p', {}, [p])),
        a.citations?.length
          ? h('div', { class: 'citations' }, [
              h('div', { class: 'meta', style: 'margin-bottom:2px' }, [
                `From ${a.citations.length} item${a.citations.length === 1 ? '' : 's'} in your memory`,
              ]),
              ...a.citations.map((id) => {
                const item = a.context.items.find((i) => i.id === id);
                return h('span', { class: 'citation', onclick: () => go('object', id) }, [
                  h('span', { class: 'mono' }, [id.slice(0, 12)]),
                  h('span', {}, [item?.title ?? id]),
                ]);
              }),
            ])
          : null,
        a.uncertainty ? h('div', { class: 'uncertainty' }, [a.uncertainty]) : null,
      ])
    );
  } else {
    nodes.push(
      h('div', { class: 'answer ungrounded' }, [
        h('p', {}, [a.uncertainty ?? 'Memory does not contain an answer to this.']),
      ])
    );
  }

  if (a.conflicts?.length) {
    nodes.push(
      h('div', { class: 'card conflict' }, [
        h('span', { class: 'title' }, [
          `⚠ ${a.conflicts.length} disagreement${a.conflicts.length === 1 ? '' : 's'} in this material`,
        ]),
        ...a.conflicts.map((c) => h('p', { class: 'body' }, [c.detail?.reason ?? c.kind])),
      ])
    );
  }

  if (a.context?.items?.length) {
    nodes.push(
      h('h2', {}, ['What was used, and why']),
      ...a.context.items.map((i) =>
        h('div', { class: 'card clickable', onclick: () => go('object', i.id) }, [
          h('span', { class: 'title' }, [i.title]),
          h('div', { class: 'reason' }, [i.reason]),
          h('div', { class: 'badges' }, [
            badge(i.kind, 'kind'),
            badge(i.origin, `origin-${i.origin}`),
            i.review === 'confirmed' ? badge('confirmed', 'confirmed') : null,
          ]),
        ])
      ),
      h('p', { class: 'hint' }, [
        `${a.context.usedTokens} of ${a.context.budget} tokens · ` +
          `${a.context.coverage.candidatesConsidered} candidates considered · ` +
          `answered by ${a.provider ?? 'nothing'}`,
      ])
    );
  }

  return h('div', {}, nodes);
}

/** @param {any} o */
function objectCard(o) {
  return h('div', { class: 'card clickable', onclick: () => go('object', o.id) }, [
    h('span', { class: 'title' }, [o.title]),
    o.excerpt ? h('p', { class: 'excerpt' }, [o.excerpt]) : null,
    badgeRow(o),
  ]);
}

/** @param {any} p @param {HTMLElement} list */
function proposalCard(p, list) {
  const card = h('div', { class: 'card proposal' }, [
    h('div', { class: 'meta' }, [
      `${p.op.replace(/_/g, ' ')} · proposed by ${p.provider ?? 'unknown'}` +
        `${p.model ? ` (${p.model})` : ''}${p.confidence != null ? ` · confidence ${p.confidence}` : ''}`,
    ]),
    h('p', { class: 'body' }, [describeProposal(p)]),
    p.rationale ? h('div', { class: 'reason' }, [p.rationale]) : null,
    h('div', { class: 'actions', style: 'margin-top:12px' }, [
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            const r = await api.post(`/proposals/${p.id}/accept`, {});
            toast(`Added to memory as ${r.applied.kind}.`);
            card.remove();
            await refreshStats();
            renderNav();
            if (!list.children.length) renderView();
          } catch (err) {
            toast(String(err.message), true);
          }
        },
      }, ['Accept']),
      h('button', {
        class: 'btn quiet',
        onclick: async () => {
          await api.post(`/proposals/${p.id}/reject`, { note: 'declined in review' });
          toast('Declined — kept on record.');
          card.remove();
          await refreshStats();
          renderNav();
          if (!list.children.length) renderView();
        },
      }, ['Decline']),
    ]),
  ]);
  return card;
}

/** @param {any} p */
function describeProposal(p) {
  const d = p.payload ?? {};
  switch (p.op) {
    case 'create_object':
      return `Remember this as a ${d.kind ?? 'note'}: “${d.title}”`;
    case 'update_object':
      return `Change ${Object.keys(d.patch ?? {}).join(', ')} on ${d.objectId}`;
    case 'create_relation':
      return `Link these as “${String(d.type).replace(/_/g, ' ')}”`;
    case 'set_attributes':
      return `Tag with: ${(d.attrs?.keywords ?? []).join(', ') || JSON.stringify(d.attrs)}`;
    case 'link_evidence':
      return `Attach supporting evidence to ${d.targetId}`;
    default:
      return p.op;
  }
}

/** @param {string} label @param {any} r */
function relationRow(label, r) {
  return h('div', { style: 'padding:6px 0;display:flex;gap:10px;align-items:baseline' }, [
    h('span', { class: 'badge kind' }, [String(label).replace(/_/g, ' ')]),
    h('span', { class: 'citation', style: 'margin-left:0', onclick: () => go('object', r.other_id) }, [
      r.other_title,
    ]),
    r.origin === 'ai' ? badge('proposed', 'origin-ai') : null,
  ]);
}

/** @param {any} o @param {boolean} [detailed] */
function badgeRow(o, detailed) {
  return h('div', { class: 'badges' }, [
    badge(o.kind, 'kind'),
    detailed ? badge(o.epistemic, 'plain') : null,
    badge(originLabel(o.origin), `origin-${o.origin}`),
    o.review === 'confirmed' ? badge('confirmed', 'confirmed') : null,
    o.review === 'rejected' ? badge('rejected', 'rejected') : null,
    o.state && o.state !== 'active' ? badge(o.state, 'state') : null,
    o.confidence != null ? badge(`conf ${o.confidence}`, 'plain') : null,
  ]);
}

/** @param {string} origin */
function originLabel(origin) {
  return { user: 'you wrote it', source: 'from a source', algorithm: 'derived', ai: 'AI-derived' }[origin] ?? origin;
}

/** @param {string} text @param {string} cls */
function badge(text, cls) {
  return text ? h('span', { class: `badge ${cls}` }, [text]) : null;
}

/** @param {number} n @param {string} k @param {boolean} [alert] */
function stat(n, k, alert) {
  return h('div', { class: `stat${alert ? ' alert' : ''}` }, [
    h('div', { class: 'n' }, [String(n ?? 0)]),
    h('div', { class: 'k' }, [k]),
  ]);
}

/**
 * A small force-directed layout, run to a fixed number of iterations so the
 * result is stable and the page does not animate forever.
 * @param {any[]} nodes
 * @param {any[]} edges
 */
function drawGraph(nodes, edges) {
  const W = 900;
  const H = 520;
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  const pos = nodes.map((_, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    return { x: W / 2 + Math.cos(angle) * 190, y: H / 2 + Math.sin(angle) * 190, vx: 0, vy: 0 };
  });

  const links = edges
    .map((e) => ({ s: index.get(e.src_id), t: index.get(e.dst_id), origin: e.origin }))
    .filter((l) => l.s !== undefined && l.t !== undefined);

  for (let step = 0; step < 220; step++) {
    // Repulsion between every pair.
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let dx = pos[j].x - pos[i].x;
        let dy = pos[j].y - pos[i].y;
        let d2 = dx * dx + dy * dy || 0.01;
        const force = 2600 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        pos[i].vx -= fx; pos[i].vy -= fy;
        pos[j].vx += fx; pos[j].vy += fy;
      }
    }
    // Attraction along links.
    for (const l of links) {
      const dx = pos[l.t].x - pos[l.s].x;
      const dy = pos[l.t].y - pos[l.s].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (d - 110) * 0.012;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      pos[l.s].vx += fx; pos[l.s].vy += fy;
      pos[l.t].vx -= fx; pos[l.t].vy -= fy;
    }
    for (const p of pos) {
      p.x = Math.max(30, Math.min(W - 30, p.x + (p.vx *= 0.82)));
      p.y = Math.max(24, Math.min(H - 24, p.y + (p.vy *= 0.82)));
    }
  }

  // Repulsion pushes unconnected nodes to the edges and lets the connected
  // cluster settle wherever it likes, which often leaves the interesting part
  // of the graph in a corner. Recentre the whole layout on its own extent.
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const dx = W / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = H / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const p of pos) {
    p.x += dx;
    p.y += dy;
  }

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'graph');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  for (const l of links) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', pos[l.s].x);
    line.setAttribute('y1', pos[l.s].y);
    line.setAttribute('x2', pos[l.t].x);
    line.setAttribute('y2', pos[l.t].y);
    if (l.origin === 'ai') line.setAttribute('stroke-dasharray', '3 3');
    svg.appendChild(line);
  }

  const colour = { user: 'var(--user)', source: 'var(--source)', algorithm: 'var(--algo)', ai: 'var(--ai)' };

  nodes.forEach((n, i) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', pos[i].x);
    c.setAttribute('cy', pos[i].y);
    c.setAttribute('r', String(4 + Math.min(7, n.degree)));
    c.setAttribute('fill', colour[n.origin] ?? 'var(--text-3)');
    c.addEventListener('click', () => go('object', n.id));
    const t = document.createElementNS(ns, 'title');
    t.textContent = `${n.title} — ${n.kind}, ${n.origin}`;
    c.appendChild(t);
    svg.appendChild(c);

    if (n.degree > 0) {
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', pos[i].x + 10);
      label.setAttribute('y', pos[i].y + 3);
      label.textContent = truncate(n.title, 24);
      svg.appendChild(label);
    }
  });

  return svg;
}

// --------------------------------------------------------------- helpers

/**
 * Minimal DOM builder. `props` starting with `on` become listeners; null
 * children are skipped so views can use inline conditionals.
 * @param {string} tag
 * @param {Record<string, any>} props
 * @param {any[]} [children]
 */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** @param {string} id */
function el(id) {
  return document.getElementById(id);
}

function notFound() {
  return h('div', { class: 'empty' }, ['Nothing here.']);
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return !s ? '' : s.length <= n ? s : `${s.slice(0, n)}…`;
}

let toastTimer;
/** @param {string} message @param {boolean} [isError] */
function toast(message, isError) {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: `toast${isError ? ' error' : ''}` }, [message]);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
}
