// CookMate pipeline console.
//
// One page over the whole pipeline: point it at a site, let it find the recipe
// URLs, run each stage, watch the log, triage what comes out. Every button here
// calls the same functions the CLI commands call - see src/ui/server.ts.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const minutes = (seconds) =>
  seconds == null ? '' : seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
    : `${Math.round(seconds / 60)}m`;

const ago = (iso) => {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
  return payload;
}

const main = $('#main');
const state = {
  view: 'pipeline',
  overview: null,
  job: null,          // the job the drawer is following
  logCursor: 0,
  // Which log the cursor above counts in: a stored run's numbering, or this
  // job's in-process one. They are different sequences, so the panel starts
  // over when it changes rather than carrying a meaningless cursor across.
  logKey: null,
  discovery: null,    // last completed discovery result, kept across tab switches
  // The pipeline view re-renders whenever the overview changes, so what the
  // operator typed has to live out here or it would be wiped mid-keystroke.
  limit: 50,
  flags: {},
};

// ---------------------------------------------------------------------------
// Job drawer
// ---------------------------------------------------------------------------

const drawer = $('#drawer');
const logEl = $('#log');
let pollTimer = null;

$('#drawer-bar').onclick = (event) => {
  if (event.target.closest('#job-cancel')) return;
  toggleDrawer();
};

function toggleDrawer(force) {
  const collapsed = force ?? !drawer.classList.contains('collapsed');
  drawer.classList.toggle('collapsed', collapsed);
  $('#drawer-toggle').textContent = collapsed ? 'Show log' : 'Hide log';
  if (!collapsed) logEl.scrollTop = logEl.scrollHeight;
}

$('#job-cancel').onclick = async () => {
  if (!state.job) return;
  $('#job-cancel').disabled = true;
  await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }).catch(() => {});
};

/** Follow a job: clear the log, open the drawer, and start polling. */
function follow(job) {
  state.job = job;
  state.logCursor = 0;
  state.logKey = null;
  logEl.textContent = '';
  drawer.hidden = false;
  toggleDrawer(false);
  paintJob(job);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollJob, 900);
  pollJob();
}

function paintJob(job) {
  $('#job-title').textContent = `${job.kind} · ${job.label}`;
  $('#job-dot').className = `dot ${job.status === 'running' ? 'run' : ''}`;
  $('#job-cancel').hidden = job.status !== 'running';
  $('#job-cancel').disabled = false;

  const bits = [job.status];
  if (job.status === 'running') bits.push(`started ${ago(job.startedAt)}`);
  else if (job.finishedAt) bits.push(`finished ${ago(job.finishedAt)}`);
  if (job.error) bits.push(job.error);
  $('#job-sub').textContent = bits.join(' · ');
}

/** Append lines to the panel, keeping the view pinned to the bottom if it was. */
function appendLines(lines) {
  if (lines.length === 0) return;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = line.level;
    div.textContent = `${line.ts.slice(11, 19)} [${line.scope}] ${line.message}${line.extra ? ' ' + line.extra : ''}`;
    logEl.appendChild(div);
  }
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function pollJob() {
  if (!state.job) return;
  let job;
  try {
    job = await api(`/api/jobs/${state.job.id}?since=${state.logCursor}`);
  } catch {
    return; // server restarted or job evicted; leave the last state on screen
  }

  // A stage that records a run hands its log over to the database a moment
  // after starting, and the stored log is numbered from its own line 1. Redraw
  // from the source of record rather than splice two sequences together.
  const key = `${job.logSource}:${job.runId ?? ''}`;
  if (key !== state.logKey) {
    state.logKey = key;
    state.logCursor = 0;
    logEl.textContent = '';
    // Deliberately without updating state.job: the poll below does that, and
    // doing it here would hide a status change from the check that ends the
    // polling timer.
    return pollJob();
  }

  appendLines(job.lines);
  state.logCursor = job.logCursor;

  const wasRunning = state.job.status === 'running';
  state.job = { ...job, lines: undefined };
  paintJob(state.job);

  if (wasRunning && job.status !== 'running') {
    clearInterval(pollTimer);
    pollTimer = null;
    onJobFinished(job);
  }
}

function onJobFinished(job) {
  if (job.kind === 'discover' && job.result) {
    state.discovery = job.result;
    // The run is over and the shortlist is the thing to act on now, so get the
    // form out of its way - but only when there is a shortlist. A run that
    // found nothing wants the form still open to adjust and try again.
    if (job.result.candidates.length > 0) composer.open = false;
  }
  loadOverview();
  if (['pipeline', 'queue', 'review'].includes(state.view)) render();
}

/**
 * Open the stored log of a run, job or no job.
 *
 * This is the reason the lines are in Postgres rather than only on screen: the
 * crawl that ran overnight, or before the last restart, has no job record left
 * in this process, and its log is still the only place that says which URLs
 * went wrong.
 */
async function followRun(run) {
  state.job = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  logEl.textContent = '';
  drawer.hidden = false;
  toggleDrawer(false);

  $('#job-title').textContent = `run #${run.id} · ${run.kind}`;
  $('#job-dot').className = `dot ${run.status === 'running' ? 'run' : ''}`;
  $('#job-cancel').hidden = true;
  $('#job-sub').textContent = [run.status, `started ${ago(run.started_at)}`].join(' · ');

  let cursor = 0;
  /** One pass: page until the run is drained, and report its current status. */
  const pull = async () => {
    let status = run.status;
    for (;;) {
      const page = await api(`/api/runs/${run.id}/log?since=${cursor}&limit=1000`).catch(() => null);
      if (!page) return status;
      status = page.run.status;
      appendLines(page.lines);
      if (page.lines.length === 0) return status;
      cursor = page.lines[page.lines.length - 1].seq;
      if (page.lines.length < 1000) return status;
    }
  };

  const status = await pull();
  // A job started while the first pull was in flight owns the drawer now, and
  // owns pollTimer with it: tailing on top of that would leave two intervals
  // polling and one of them unreachable.
  if (status !== 'running' || state.job) return;

  // Tail it. The interval belongs to this run, so it stops the moment the
  // drawer follows a job instead, and when the run itself ends.
  pollTimer = setInterval(async () => {
    if (state.job) return;
    const now = await pull();
    if (now !== 'running') {
      clearInterval(pollTimer);
      pollTimer = null;
      $('#job-dot').className = 'dot';
      $('#job-sub').textContent = now;
    }
  }, 900);
}

// ---------------------------------------------------------------------------
// Overview / nav
// ---------------------------------------------------------------------------

function countOf(rows, status) {
  return rows?.find((row) => row.status === status)?.count ?? 0;
}

let overviewSignature = '';

async function loadOverview() {
  let overview;
  try {
    overview = await api('/api/overview');
  } catch {
    return; // transient; keep showing the last good numbers
  }
  const signature = JSON.stringify(overview);
  const changed = signature !== overviewSignature;
  overviewSignature = signature;
  state.overview = overview;
  const { staging, queue, sources, unmatched } = state.overview;
  const badges = {
    queue: countOf(queue, 'pending') || '',
    review: countOf(staging, 'review') || '',
    // Sub-tabs inside the crawl queue view; only present while it is open.
    'queue-urls': countOf(queue, 'pending') || '',
    'queue-sources': sources.total || '',
    'queue-unmatched': unmatched || '',
  };
  for (const [key, value] of Object.entries(badges)) {
    const el = $(`[data-count="${key}"]`);
    if (el) el.textContent = value;
  }
  // Only redraw when something actually moved: this runs every few seconds.
  if (changed && state.view === 'pipeline') render();
}

$$('nav button').forEach((button) => {
  button.onclick = () => {
    state.view = button.dataset.view;
    $$('nav button').forEach((b) => b.setAttribute('aria-current', b === button ? 'page' : 'false'));
    render();
  };
});

// ---------------------------------------------------------------------------
// Running stages
// ---------------------------------------------------------------------------

async function runStage(stage, limit, flags = {}) {
  try {
    const job = await api('/api/run', { method: 'POST', body: { stage, limit, flags } });
    follow(job);
    loadOverview();
  } catch (error) {
    alert(error.message);
  }
}

const STAGE_INFO = [
  { key: 'crawl', title: 'Crawl', desc: 'Fetch queued URLs, extract recipe markup into raw pages.' },
  { key: 'extract', title: 'Extract', desc: 'Tier D: read recipes off stored pages no markup described. Costs model budget.' },
  { key: 'parse', title: 'Parse', desc: 'Raw pages to staging rows: ingredients, steps, timings.' },
  { key: 'images', title: 'Images', desc: 'Copy each recipe\'s photos into our own public bucket. Sources without allow_image_use are skipped.' },
  { key: 'enrich', title: 'Enrich', desc: 'Step timers and step-to-ingredient links, from the model.' },
  { key: 'gate', title: 'Gate', desc: 'Score, de-duplicate, route to approved or review.' },
  { key: 'publish', title: 'Publish', desc: 'Approved rows into the app tables the API serves.' },
];

function stageBacklog(key) {
  const { staging, queue } = state.overview ?? {};
  switch (key) {
    case 'crawl': return { n: countOf(queue, 'pending'), unit: 'urls pending' };
    case 'extract': return { n: state.overview?.extractable ?? 0, unit: 'pages unread' };
    case 'parse': return { n: state.overview?.parsable ?? 0, unit: 'pages unparsed' };
    case 'images': return { n: state.overview?.mirrorable ?? 0, unit: 'awaiting photos' };
    case 'enrich': return { n: countOf(staging, 'parsed'), unit: 'parsed' };
    case 'gate': return { n: countOf(staging, 'enriched'), unit: 'enriched' };
    case 'publish': {
      // Not just what has never been published: a live row whose staging row
      // moved on since (re-enriched, or photos mirrored) is work this stage
      // would do, and showing only `approved` reported 0 while the app served
      // stale rows. `stale` needs the republish flag, which the hint says.
      const { approved = 0, stale = 0 } = state.overview?.publishable ?? {};
      return { n: approved + stale, unit: stale > 0 ? 'to publish' : 'approved' };
    }
    default: return { n: 0, unit: '' };
  }
}

function renderPipeline() {
  const running = state.overview?.running ?? {};
  const staging = state.overview?.staging ?? [];
  const queue = state.overview?.queue ?? [];

  const cards = STAGE_INFO.map((stage) => {
    const { n, unit } = stageBacklog(stage.key);
    const busy = Boolean(running[stage.key]);
    const flag = (name, label) =>
      `<label class="check"><input type="checkbox" data-flag="${stage.key}:${name}"
        ${state.flags[`${stage.key}:${name}`] ? 'checked' : ''}> ${label}</label>`;
    const extras =
      stage.key === 'extract' ? flag('dryRun', 'dry run')
      : stage.key === 'parse' ? flag('force', 're-parse')
      : stage.key === 'images' ? flag('force', 're-mirror')
      : stage.key === 'enrich' ? flag('escalate', 'escalate')
      : stage.key === 'publish' ? flag('republish', 'republish')
      : '';
    // The one case where the button alone does not clear the backlog.
    const stalePublish = stage.key === 'publish' ? (state.overview?.publishable?.stale ?? 0) : 0;
    const hint = stalePublish > 0
      ? `<div class="hint">${stalePublish} already live but out of date - tick republish</div>`
      : '';
    return `
      <div class="stage ${busy ? 'busy' : ''}">
        <div class="name"><span class="dot ${busy ? 'run' : ''}"></span>${stage.title}</div>
        <div class="metric"><span class="n">${n}</span><span class="unit">${unit}</span></div>
        <div class="desc">${stage.desc}</div>
        ${hint}
        ${extras ? `<div class="opts">${extras}</div>` : ''}
        <button class="btn small" data-run="${stage.key}" ${busy ? 'disabled' : ''}>
          ${busy ? 'Running…' : 'Run'}
        </button>
      </div>`;
  }).join('');

  const statusRows = (rows, label) => rows.length === 0
    ? `<p class="note">No ${label} yet.</p>`
    : `<table><tr><th>${label}</th><th class="num">Rows</th></tr>${rows
        .map((row) => `<tr><td><span class="tag ${esc(row.status)}">${esc(row.status)}</span></td>
          <td class="num">${row.count}</td></tr>`)
        .join('')}</table>`;

  main.innerHTML = `
    <h2>Pipeline</h2>
    <p class="lede">
      Each stage is bounded by its limit and safe to re-run: the pipeline's real
      state lives in Postgres, not in this page.
    </p>

    <div class="panel toolbar">
      <label class="field">Limit per stage
        <input type="number" id="limit" value="${state.limit}" min="1" max="5000">
      </label>
      <button class="btn primary" data-run="pipeline"
        ${running.pipeline ? 'disabled' : ''}>Run crawl → parse → images → enrich → gate</button>
      <button class="btn" id="preflight">Check publish schema</button>
      <span class="note" id="preflight-out"></span>
    </div>

    <div class="stages">${cards}</div>

    <h3>Where everything is</h3>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
      <div class="panel">${statusRows(queue, 'Crawl queue')}</div>
      <div class="panel">${statusRows(staging, 'Staging')}</div>
    </div>`;

  $('#limit').oninput = (event) => {
    state.limit = Number(event.target.value) || 50;
  };
  $$('[data-flag]').forEach((box) => {
    box.onchange = () => {
      state.flags[box.dataset.flag] = box.checked;
    };
  });

  $$('[data-run]').forEach((button) => {
    button.onclick = () => {
      const stage = button.dataset.run;
      const flags = {};
      for (const [key, on] of Object.entries(state.flags)) {
        const [owner, name] = key.split(':');
        // A pipeline run carries every stage's flags; a single stage only its own.
        if (on && (owner === stage || stage === 'pipeline')) flags[name] = true;
      }
      runStage(stage, state.limit, flags);
    };
  });

  $('#preflight').onclick = async () => {
    const out = $('#preflight-out');
    out.textContent = 'checking…';
    try {
      const report = await api('/api/preflight');
      const missing = [...report.missingTables, ...report.missingColumns];
      out.className = report.ok ? 'note' : 'err';
      out.textContent = report.ok
        ? 'app schema looks right — publish has everywhere to write'
        : `missing: ${missing.join(', ')}`;
    } catch (error) {
      out.className = 'err';
      out.textContent = error.message;
    }
  };
}

// ---------------------------------------------------------------------------
// Crawl queue - the table, and the two ways to fill it
// ---------------------------------------------------------------------------

/*
 * Pasting a list and exploring a site used to be tabs of their own, which meant
 * doing either one somewhere you could not see the result. Both are the same
 * act - putting URLs in this queue - so both live at the top of the queue now,
 * as two modes of one composer, and the rows they produce appear underneath.
 *
 * The composer stays folded away by default: most visits here are to read the
 * table, not to write to it. It opens itself only when the queue is empty and
 * there is nothing to read.
 *
 * Everything the operator types lives in here rather than in the DOM, because
 * renderQueue() reruns whenever a job finishes - including the discover job
 * started from this very form - and a re-render would otherwise wipe the fields
 * mid-keystroke.
 */
const composer = {
  open: false,
  mode: 'paste',
  draft: '',
  priority: 100,
  result: null,
  discover: {
    seed: '',
    mode: 'auto',
    maxPages: 40,
    maxDepth: 2,
    maxResults: 200,
    include: '',
    exclude: '',
    dryRun: false,
    verify: false,
    includeSubdomains: false,
  },
};

const queueFilter = { status: 'all', q: '' };

const MODES = [
  ['paste', 'Paste a list'],
  ['discover', 'Explore a site'],
];

/*
 * Sources and unmatched ingredients used to be top-level views of their own.
 * Both are about what the crawl brought in - which domains it touched, and
 * which ingredient strings it could not resolve - so they sit here as
 * sub-tabs of the queue rather than competing for a place in the nav.
 */
const QUEUE_TABS = [
  ['urls', 'URLs', renderQueueUrls],
  ['sources', 'Sources', renderSources],
  ['unmatched', 'Unmatched', renderUnmatched],
];
let queueTab = 'urls';

function queueTabsHtml() {
  const { queue, sources, unmatched } = state.overview ?? {};
  const counts = {
    urls: countOf(queue, 'pending'),
    sources: sources?.total ?? 0,
    unmatched: unmatched ?? 0,
  };
  return QUEUE_TABS.map(
    ([key, label]) => `<button type="button" data-qtab="${key}"
      ${queueTab === key ? 'aria-current="page"' : ''}>
      ${label}<span class="count" data-count="queue-${key}">${counts[key] || ''}</span>
    </button>`,
  ).join('');
}

// Sub-tabs fetch before they paint, so a slow tab must not paint over a newer one.
let queueTabToken = 0;

async function renderQueue() {
  main.innerHTML = `
    <h2>Crawl queue</h2>
    <div class="tabs" id="qtabs" role="group" aria-label="Crawl queue sections"
         style="margin-bottom:14px">${queueTabsHtml()}</div>
    <div id="queue-sub"><div class="empty">Loading…</div></div>`;

  $('#qtabs').onclick = (event) => {
    const button = event.target.closest('button[data-qtab]');
    if (!button || button.dataset.qtab === queueTab) return;
    queueTab = button.dataset.qtab;
    $$('#qtabs button').forEach((b) => {
      if (b === button) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    renderQueueTab();
  };
  await renderQueueTab();
}

async function renderQueueTab() {
  const token = ++queueTabToken;
  const [, , renderTab] = QUEUE_TABS.find(([key]) => key === queueTab);
  const host = $('#queue-sub');
  try {
    await renderTab(host, () => token === queueTabToken && host.isConnected);
  } catch (error) {
    if (token === queueTabToken) host.innerHTML = `<div class="panel err">${esc(error.message)}</div>`;
  }
}

function renderQueueUrls(host) {
  host.innerHTML = `
    <p class="lede">
      Every URL the pipeline knows about, newest first. Add more at the top —
      paste a list you already have, or point the crawler at a site and let it
      find the recipe pages itself.
    </p>

    <section class="composer panel" id="composer">
      <button class="composer-head" id="composer-toggle"
              aria-expanded="${composer.open}" aria-controls="composer-body">
        <span class="chev" aria-hidden="true"></span>
        <strong>Add URLs</strong>
        <span class="note">paste a list, or explore a site for recipe pages</span>
      </button>
      <div class="composer-body" id="composer-body" ${composer.open ? '' : 'hidden'}>
        <div class="composer-modes" role="group" aria-label="How to add URLs">
          ${MODES.map(
            ([mode, label]) => `<button data-mode="${mode}"
              aria-current="${composer.mode === mode ? 'page' : 'false'}">${label}</button>`,
          ).join('')}
        </div>
        <div id="composer-form">${composerFormHtml()}</div>
      </div>
    </section>

    <div id="discover-result">${state.discovery ? discoveryResultHtml(state.discovery) : ''}</div>

    <div class="panel toolbar-row">
      <label class="field">Status
        <select id="qstatus">
          ${['all', 'pending', 'fetching', 'done', 'failed', 'skipped']
            .map((s) => `<option ${queueFilter.status === s ? 'selected' : ''}>${s}</option>`)
            .join('')}
        </select>
      </label>
      <label class="field" style="flex:1;min-width:200px">Search
        <input type="search" id="qsearch" value="${esc(queueFilter.q)}" placeholder="part of a url">
      </label>
      <span class="spacer"></span>
      <button class="btn small" id="retry-failed">Retry all failed</button>
      <button class="btn small" id="retry-picked" disabled>Retry selected</button>
      <button class="btn small danger" id="delete-picked" disabled>Delete selected</button>
    </div>
    <div class="panel" id="queue-table"><div class="empty">Loading…</div></div>`;

  wireComposer();
  wireDiscoveryResult();

  $('#qstatus').onchange = (event) => {
    queueFilter.status = event.target.value;
    loadQueueRows();
  };
  let debounce;
  $('#qsearch').oninput = (event) => {
    queueFilter.q = event.target.value;
    clearTimeout(debounce);
    debounce = setTimeout(loadQueueRows, 250);
  };

  const picked = () => $$('#queue-table .pick:checked').map((box) => Number(box.value));
  $('#retry-failed').onclick = async () => {
    const response = await api('/api/queue/retry', { method: 'POST', body: { status: 'failed' } });
    alert(`${response.requeued} URL(s) back to pending`);
    loadQueueRows();
    loadOverview();
  };
  $('#retry-picked').onclick = async () => {
    const ids = picked();
    if (ids.length === 0) return;
    await api('/api/queue/retry', { method: 'POST', body: { ids } });
    loadQueueRows();
    loadOverview();
  };
  $('#delete-picked').onclick = async () => {
    const ids = picked();
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} queue row(s)? Raw pages already crawled are kept.`)) return;
    await api('/api/queue/delete', { method: 'POST', body: { ids } });
    loadQueueRows();
    loadOverview();
  };

  loadQueueRows();
}

/**
 * `focus` is off for the automatic open on an empty queue: that can fire in the
 * middle of a session when a finished job re-renders the view, and taking the
 * caret away from whatever the operator was doing is worse than a folded form.
 */
function openComposer(open, { focus = false } = {}) {
  composer.open = open;
  const body = $('#composer-body');
  if (!body) return;
  body.hidden = !open;
  $('#composer').classList.toggle('open', open);
  $('#composer-toggle').setAttribute('aria-expanded', String(open));
  if (open && focus) $(composer.mode === 'paste' ? '#urls' : '#seed').focus();
}

function wireComposer() {
  $('#composer').classList.toggle('open', composer.open);
  $('#composer-toggle').onclick = () => openComposer(!composer.open, { focus: true });

  $$('.composer-modes button').forEach((button) => {
    button.onclick = () => {
      if (composer.mode === button.dataset.mode) return;
      composer.mode = button.dataset.mode;
      paintComposerMode();
      openComposer(true, { focus: true });
    };
  });

  wireComposerForm();
}

const composerFormHtml = () => (composer.mode === 'paste' ? pasteFormHtml() : discoverFormHtml());

function wireComposerForm() {
  if (composer.mode === 'paste') wirePasteForm();
  else wireDiscoverForm();
}

/**
 * Swaps the form and nothing else. Going through render() would rebuild the
 * whole view and refetch the queue below, which has nothing to do with which
 * way you happen to be adding URLs - and would throw away the rows the operator
 * had selected down there.
 */
function paintComposerMode() {
  $$('.composer-modes button').forEach((button) =>
    button.setAttribute('aria-current', button.dataset.mode === composer.mode ? 'page' : 'false'));
  $('#composer-form').innerHTML = composerFormHtml();
  wireComposerForm();
}

// ---------------------------------------------------------------------------
// Composer: paste a list
// ---------------------------------------------------------------------------

function pasteFormHtml() {
  return `
    <form class="grid" id="enqueue-form">
      <label class="field" for="urls">URLs to crawl
        <textarea id="urls" name="urls" spellcheck="false" aria-describedby="urls-hint"
          placeholder="https://example.com/recipes/roast-chicken
https://example.com/recipes/apple-pie">${esc(composer.draft)}</textarea>
      </label>
      <p class="note" id="urls-hint" style="margin:0">
        One per line, or separated by spaces or commas. Duplicates and URLs already
        queued are ignored; lines that are not URLs are counted and skipped.
      </p>
      <div class="row">
        <label class="field" for="priority">Priority
          <input type="number" id="priority" name="priority"
                 value="${composer.priority}" min="1" max="1000" aria-describedby="priority-hint">
        </label>
        <span class="note" id="priority-hint">Lower runs first.</span>
        <span class="spacer"></span>
        <button class="btn primary" type="submit" id="enqueue-submit">Add to crawl queue</button>
      </div>
      <p class="${composer.result?.level ?? 'note'}" id="enqueue-out" role="status"
         style="margin:0;min-height:1.2em">${esc(composer.result?.text ?? '')}</p>
    </form>`;
}

function wirePasteForm() {
  $('#urls').oninput = (event) => (composer.draft = event.target.value);
  $('#priority').oninput = (event) => (composer.priority = event.target.value);

  $('#enqueue-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('#enqueue-submit');
    const out = $('#enqueue-out');
    button.disabled = true;
    say(out, 'note', 'adding…');
    try {
      const response = await api('/api/enqueue', {
        method: 'POST',
        body: { urls: composer.draft, priority: Number(composer.priority) || 100 },
      });
      composer.result = {
        level: 'ok',
        text:
          `${response.added} added · ${response.alreadyQueued} already queued` +
          (response.rejected ? ` · ${response.rejected} line(s) were not URLs` : ''),
      };
      composer.draft = '';
      $('#urls').value = '';
      // The payoff of living on this page: the rows just added show up below.
      loadQueueRows();
      loadOverview();
    } catch (error) {
      composer.result = { level: 'err', text: error.message };
    }
    say(out, composer.result.level, composer.result.text);
    button.disabled = false;
  };
}

/** Write a status line, keeping the class in step with the message. */
function say(el, level, text) {
  if (!el) return;
  el.className = level;
  el.textContent = text;
}

// ---------------------------------------------------------------------------
// Composer: explore a site
// ---------------------------------------------------------------------------

function discoverFormHtml() {
  const d = composer.discover;
  const running = state.overview?.running?.discover;
  const option = (value, label) =>
    `<option value="${value}" ${d.mode === value ? 'selected' : ''}>${label}</option>`;
  const check = (id, label) =>
    `<label class="check"><input type="checkbox" class="d" id="${id}" ${d[id] ? 'checked' : ''}> ${label}</label>`;
  const number = (id, label, min, max) =>
    `<label class="field" for="${id}">${label}
       <input type="number" class="d" id="${id}" value="${d[id]}" min="${min}" max="${max}"></label>`;

  return `
    <form class="grid" id="discover-form">
      <label class="field" for="seed">Seed URL
        <input type="url" class="d" id="seed" required placeholder="https://example.com"
               value="${esc(d.seed)}" aria-describedby="seed-hint">
      </label>
      <p class="note" id="seed-hint" style="margin:0">
        A homepage, a category page or a sitemap. It reads the site's sitemap when
        there is one and otherwise walks links, obeying robots.txt and the same
        per-host delay as the crawl stage.
      </p>
      <div class="row">
        <label class="field" for="mode">Strategy
          <select class="d" id="mode">
            ${option('auto', 'Auto — sitemap, then links')}
            ${option('sitemap', 'Sitemap only')}
            ${option('links', 'Follow links only')}
          </select>
        </label>
        ${number('maxPages', 'Max pages to fetch', 1, 500)}
        ${number('maxDepth', 'Link depth', 1, 5)}
        ${number('maxResults', 'Max results', 1, 2000)}
      </div>
      <div class="row">
        <label class="field" for="include" style="flex:1;min-width:200px">URL must match (regex, optional)
          <input type="text" class="d" id="include" value="${esc(d.include)}" placeholder="/recipes?/">
        </label>
        <label class="field" for="exclude" style="flex:1;min-width:200px">URL must not match (regex, optional)
          <input type="text" class="d" id="exclude" value="${esc(d.exclude)}" placeholder="/(tag|author)/">
        </label>
      </div>
      <div class="row">
        ${check('dryRun', 'Preview only — write nothing')}
        ${check('verify', 'Verify every candidate (slower, exact)')}
        ${check('includeSubdomains', 'Follow subdomains')}
      </div>
      <div class="row">
        <span class="note" id="discover-effect">${discoverEffect()}</span>
        <span class="spacer"></span>
        <button class="btn primary" type="submit" id="discover-submit" ${running ? 'disabled' : ''}>
          ${running ? 'Exploring…' : 'Explore site'}
        </button>
      </div>
    </form>`;
}

function discoverEffect() {
  return composer.discover.dryRun
    ? 'Preview only: candidates are listed here and nothing is written.'
    : 'Candidates found are queued automatically.';
}

function wireDiscoverForm() {
  // One handler for the whole form: every control is named after the key it
  // writes, so the draft survives the re-render the job itself will trigger.
  $('#discover-form').oninput = (event) => {
    const input = event.target;
    if (!input.classList.contains('d')) return;
    composer.discover[input.id] =
      input.type === 'checkbox' ? input.checked
      : input.type === 'number' ? Number(input.value)
      : input.value;
    $('#discover-effect').textContent = discoverEffect();
  };
  $('#discover-form').onchange = $('#discover-form').oninput;

  $('#discover-form').onsubmit = async (event) => {
    event.preventDefault();
    const d = composer.discover;
    d.seed = $('#seed').value.trim();
    try {
      state.discovery = null;
      const job = await api('/api/discover', {
        method: 'POST',
        body: {
          url: d.seed,
          mode: d.mode,
          maxPages: d.maxPages,
          maxDepth: d.maxDepth,
          maxResults: d.maxResults,
          dryRun: d.dryRun,
          verify: d.verify,
          includeSubdomains: d.includeSubdomains,
          include: d.include.trim() || undefined,
          exclude: d.exclude.trim() || undefined,
        },
      });
      follow(job);
      render();
    } catch (error) {
      alert(error.message);
    }
  };
}

// ---------------------------------------------------------------------------
// Composer: what exploring found
// ---------------------------------------------------------------------------

/*
 * Sits between the composer and the queue, because that is what it is: a
 * shortlist on its way into the table below. Its checkboxes are `.dpick` rather
 * than `.pick` - the queue table on the same page owns that class now, and a
 * bare `.pick` selector would sweep up both lists.
 */
function discoveryResultHtml(result) {
  const head = `<h3>Explored ${esc(result.domain)}
      <button class="btn small" id="discover-dismiss">Dismiss</button></h3>`;

  if (result.candidates.length === 0) {
    return `${head}<div class="panel"><p class="note">
      Nothing found — ${esc(result.stoppedBecause)}.
      Try raising the page budget or depth, or switch strategy.</p></div>`;
  }

  const rows = result.candidates
    .map(
      (candidate, index) => `
      <tr>
        <td><input type="checkbox" class="dpick" value="${index}"
             aria-label="Select ${esc(candidate.url)}" ${candidate.verified ? '' : 'checked'}></td>
        <td class="url"><a href="${esc(candidate.url)}" target="_blank" rel="noopener">${esc(candidate.url)}</a>
          ${candidate.title ? `<div class="note">${esc(candidate.title)}</div>` : ''}</td>
        <td><span class="tag ${candidate.verified ? 'done' : ''}">${candidate.verified ? 'recipe confirmed' : 'candidate'}</span></td>
        <td class="note">${esc(candidate.via)}</td>
      </tr>`,
    )
    .join('');

  return `
    ${head}
    <div class="panel grid">
      <div class="row">
        <strong>${result.candidates.length}</strong> candidate(s)
        <span class="note">via ${esc(result.mode)} · ${result.pagesFetched} fetch(es) ·
          ${result.ingested} already ingested · ${result.enqueued} queued ·
          ${result.alreadyKnown} already known · stopped: ${esc(result.stoppedBecause)}</span>
      </div>
      <div class="row">
        <button class="btn small" id="dpick-all">Select all</button>
        <button class="btn small" id="dpick-none">Select none</button>
        <span class="spacer"></span>
        <span class="note" id="dqueue-out" role="status"></span>
        <button class="btn primary small" id="dqueue-picked">Queue selected</button>
      </div>
      <table>
        <tr><th></th><th>URL</th><th>State</th><th>Found via</th></tr>
        ${rows}
      </table>
    </div>`;
}

function wireDiscoveryResult() {
  const result = state.discovery;
  if (!result) return;

  $('#discover-dismiss').onclick = () => {
    state.discovery = null;
    $('#discover-result').innerHTML = '';
  };
  if (result.candidates.length === 0) return;

  const boxes = () => $$('#discover-result .dpick');
  $('#dpick-all').onclick = () => boxes().forEach((box) => (box.checked = true));
  $('#dpick-none').onclick = () => boxes().forEach((box) => (box.checked = false));
  $('#dqueue-picked').onclick = async () => {
    const urls = boxes()
      .filter((box) => box.checked)
      .map((box) => result.candidates[Number(box.value)].url);
    const out = $('#dqueue-out');
    if (urls.length === 0) return say(out, 'note', 'nothing selected');
    say(out, 'note', 'queueing…');
    try {
      const response = await api('/api/enqueue', { method: 'POST', body: { urls } });
      say(out, 'ok', `${response.added} queued, ${response.alreadyQueued} already known`);
      loadQueueRows();
      loadOverview();
    } catch (error) {
      say(out, 'err', error.message);
    }
  };
}

// ---------------------------------------------------------------------------
// The queue table
// ---------------------------------------------------------------------------

// Typing in the search box fires a load per keystroke and the responses can
// land out of order, so a slow early request must not paint over a newer one.
let queueToken = 0;

async function loadQueueRows() {
  const token = ++queueToken;
  const target = $('#queue-table');
  if (!target) return;
  const params = new URLSearchParams({ status: queueFilter.status, limit: '200' });
  if (queueFilter.q) params.set('q', queueFilter.q);
  const rows = await api(`/api/queue?${params}`);
  if (token !== queueToken) return; // superseded
  if (rows.length === 0) {
    const filtered = queueFilter.status !== 'all' || queueFilter.q;
    target.innerHTML = filtered
      ? '<div class="empty">No URLs match that filter.</div>'
      : `<div class="empty">
           <p style="margin:0 0 12px">Nothing queued yet.</p>
           <button class="btn" id="empty-add">Add URLs</button>
         </div>`;
    if (!filtered) {
      $('#empty-add').onclick = () => openComposer(true, { focus: true });
      if (!composer.open) openComposer(true);
    }
    syncSelection();
    return;
  }
  target.innerHTML = `<table>
    <tr>
      <th><input type="checkbox" id="pick-all" aria-label="Select all rows"></th>
      <th>URL</th><th>Status</th><th class="num">Tries</th><th>Domain</th><th>When</th>
    </tr>
    ${rows
      .map(
        (row) => `<tr>
        <td><input type="checkbox" class="pick" value="${row.id}" aria-label="Select ${esc(row.url)}"></td>
        <td class="url"><a href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.url)}</a>
          ${row.last_error ? `<div class="err">${esc(row.last_error)}</div>` : ''}</td>
        <td><span class="tag ${esc(row.status)}">${esc(row.status)}</span></td>
        <td class="num">${row.attempts}</td>
        <td class="note">${esc(row.domain ?? '')}</td>
        <td class="note">${esc(ago(row.finished_at ?? row.enqueued_at))}</td>
      </tr>`,
      )
      .join('')}
  </table>`;

  $('#pick-all').onchange = (event) => {
    $$('#queue-table .pick').forEach((box) => (box.checked = event.target.checked));
    syncSelection();
  };
  $$('#queue-table .pick').forEach((box) => (box.onchange = syncSelection));
  syncSelection();
}

/**
 * The composer owns the page's one primary button, so the bulk actions next to
 * it stay quiet until they have something to act on - and say how much.
 */
function syncSelection() {
  const n = $$('#queue-table .pick:checked').length;
  const all = $$('#queue-table .pick');
  const box = $('#pick-all');
  if (box) {
    box.checked = n > 0 && n === all.length;
    box.indeterminate = n > 0 && n < all.length;
  }
  for (const [id, label] of [['#retry-picked', 'Retry'], ['#delete-picked', 'Delete']]) {
    const button = $(id);
    if (!button) continue;
    button.disabled = n === 0;
    button.textContent = n === 0 ? `${label} selected` : `${label} ${n}`;
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function renderSources(host, current) {
  const rows = await api('/api/sources');
  if (!current()) return;
  host.innerHTML = `
    <p class="lede">
      One row per domain. <strong>Images stay off until you turn them on</strong>:
      a recipe's ingredient list is not copyrightable but its photography is, so
      the crawler records every new domain with image use denied and publish
      honours that. Record the licence you actually checked, then re-run publish
      with <em>republish</em> to backfill images onto recipes already live.
    </p>
    <div class="panel">
      ${rows.length === 0 ? '<div class="empty">No sources yet — add a URL first.</div>' : `<table>
        <tr><th>Domain</th><th>Name</th><th>Licence</th><th>Images</th><th>Enabled</th>
            <th class="num">Delay</th><th class="num">Pages</th><th class="num">No markup</th><th></th></tr>
        ${rows
          .map(
            (row) => `<tr data-domain="${esc(row.domain)}">
            <td class="mono">${esc(row.domain)}</td>
            <td><input class="f" data-f="name" value="${esc(row.name)}" size="16"></td>
            <td><input class="f" data-f="license" value="${esc(row.license ?? '')}" size="16" placeholder="CC BY 4.0"></td>
            <td><input type="checkbox" class="f" data-f="allowImageUse" ${row.allow_image_use ? 'checked' : ''}></td>
            <td><input type="checkbox" class="f" data-f="enabled" ${row.enabled ? 'checked' : ''}></td>
            <td class="num"><input type="number" class="f" data-f="crawlDelayMs" value="${row.crawl_delay_ms}" style="width:78px"></td>
            <td class="num">${row.pages}</td>
            <td class="num ${row.extract_failures ? 'err' : ''}">${row.extract_failures}</td>
            <td><button class="btn small save">Save</button></td>
          </tr>`,
          )
          .join('')}
      </table>`}
    </div>`;

  $$('.save', host).forEach((button) => {
    button.onclick = async () => {
      const tr = button.closest('tr');
      const body = { domain: tr.dataset.domain };
      $$('.f', tr).forEach((input) => {
        body[input.dataset.f] =
          input.type === 'checkbox' ? input.checked
          : input.type === 'number' ? Number(input.value)
          : input.value;
      });
      button.textContent = 'Saving…';
      try {
        await api('/api/sources', { method: 'POST', body });
        button.textContent = 'Saved';
      } catch (error) {
        button.textContent = 'Failed';
        alert(error.message);
      }
      setTimeout(() => (button.textContent = 'Save'), 1400);
    };
  });
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

let reviewStatus = 'review';

function reviewTabsHtml() {
  const staging = state.overview?.staging;
  return ['review', 'approved', 'rejected', 'published']
    .map((s) => {
      const count = staging ? countOf(staging, s) : '';
      return `<button type="button" data-status="${s}" ${reviewStatus === s ? 'aria-current="page"' : ''}>
        ${s}${count ? `<span class="count">${count}</span>` : ''}
      </button>`;
    })
    .join('');
}

async function renderReview() {
  main.innerHTML = `
    <h2>Review</h2>
    <p class="lede">Rows the gate could not decide on its own. A decision here pins the
      row: later pipeline runs will not overwrite it.</p>
    <div class="tabs" id="rtabs" style="margin-bottom:14px">${reviewTabsHtml()}</div>
    <div id="review-list"><div class="empty">Loading…</div></div>`;

  $('#rtabs').onclick = (event) => {
    const button = event.target.closest('button[data-status]');
    if (!button || button.dataset.status === reviewStatus) return;
    reviewStatus = button.dataset.status;
    $$('#rtabs button').forEach((b) => {
      if (b === button) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    loadReviewRows();
  };
  loadReviewRows();
}

let reviewToken = 0;

async function loadReviewRows() {
  const token = ++reviewToken;
  const list = $('#review-list');
  const status = reviewStatus;
  const rows = await api(`/api/review?status=${encodeURIComponent(status)}`);
  if (token !== reviewToken) return; // superseded by a newer status
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty">Nothing in “${esc(status)}”.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const row of rows) list.appendChild(reviewCard(row, status === 'review'));
}

function reviewCard(row, decidable = true) {
  const card = document.createElement('div');
  card.className = 'card';
  const enriched = row.enriched?.steps ?? [];
  const ing = row.ingredients ?? [];

  const issues = (row.quality_issues ?? [])
    .map((issue) => `<span class="tag ${esc(issue.severity)}" title="${esc(issue.message)}">${esc(issue.code)}</span>`)
    .join('');

  const steps = (row.steps ?? [])
    .map((step) => {
      const match = enriched.find((e) => e.index === step.index);
      const uses = (match?.ingredientIndices ?? []).map((i) => ing[i]?.name).filter(Boolean);
      return `<li>${esc(step.text)}
        ${match?.durationSeconds ? `<span class="timer">${esc(match.timerName)} · ${minutes(match.durationSeconds)}</span>` : ''}
        ${uses.length ? `<div class="uses">uses: ${esc(uses.join(', '))}</div>` : ''}
      </li>`;
    })
    .join('');

  const ingredients = ing
    .map(
      (item) => `<li class="${item.canonicalId ? '' : 'unlinked'}">
        ${esc([item.qty, item.unit].filter(Boolean).join(' '))} ${esc(item.name)}
        ${item.canonicalSlug ? `<span class="uses">→ ${esc(item.canonicalSlug)}</span>` : '<span class="uses">(unmatched)</span>'}
      </li>`,
    )
    .join('');

  card.innerHTML = `
    <div class="card-head">
      ${row.image_url ? `<img class="thumb" src="${esc(row.image_url)}" alt="" loading="lazy">` : '<div class="thumb"></div>'}
      <div>
        <p class="title">${esc(row.title ?? 'Untitled')}</p>
        <div class="meta">
          ${row.servings ? row.servings + ' servings · ' : ''}${minutes(row.total_time_seconds)}
          ${row.enrichment_model ? ' · ' + esc(row.enrichment_model) : ''}<br>
          <a href="${esc(row.source_url)}" target="_blank" rel="noopener">${esc(row.source_url)}</a>
        </div>
      </div>
      <div class="score"><b>${row.quality_score ?? '–'}</b><span class="meta">score</span></div>
    </div>
    ${issues ? `<div class="issues">${issues}</div>` : ''}
    <div class="body">
      <div><h4>Ingredients</h4><ul>${ingredients}</ul></div>
      <div><h4>Steps</h4><ol>${steps}</ol></div>
    </div>
    <div class="actions">
      <button class="btn small toggle">Details</button>
      ${decidable ? `<button class="btn small approve" style="color:var(--ok);border-color:var(--ok)">Approve</button>
      <button class="btn small reject danger">Reject</button>` : ''}
    </div>`;

  $('.toggle', card).onclick = () => card.classList.toggle('open');
  if (decidable) {
    const decide = async (decision) => {
      await api('/api/decide', { method: 'POST', body: { id: row.id, decision } });
      card.style.opacity = '.35';
      $$('button', card).forEach((b) => (b.disabled = true));
      loadOverview();
    };
    $('.approve', card).onclick = () => decide('approved');
    $('.reject', card).onclick = () => decide('rejected');
  }
  return card;
}

// ---------------------------------------------------------------------------
// Unmatched ingredients
// ---------------------------------------------------------------------------

async function renderUnmatched(host, current) {
  const rows = await api('/api/unmatched');
  if (!current()) return;
  host.innerHTML = `
    <p class="lede"><strong>Unmatched ingredients.</strong> Strings the canonical dictionary could not resolve, commonest first.
      Draining this list is what makes shopping-list merging work — add them to
      <code>seed/</code> and re-run the canonical seed.</p>
    <div class="panel">
      ${rows.length === 0 ? '<div class="empty">Nothing unmatched.</div>' : `<table>
        <tr><th class="num">Seen</th><th>Normalized</th><th>Example text</th><th>From</th></tr>
        ${rows
          .map(
            (row) => `<tr>
            <td class="num">${row.occurrences}</td>
            <td class="mono">${esc(row.normalized)}</td>
            <td>${esc(row.raw_name)}</td>
            <td class="url note">${row.example_url ? `<a href="${esc(row.example_url)}" target="_blank" rel="noopener">source</a>` : ''}</td>
          </tr>`,
          )
          .join('')}
      </table>`}
    </div>`;
}

// ---------------------------------------------------------------------------

const VIEWS = {
  pipeline: renderPipeline,
  runs: renderRuns,
  queue: renderQueue,
  review: renderReview,
};

/**
 * Runs side by side, oldest on the left.
 *
 * Counters, not lines: this is the view that answers "did last night get
 * worse", which needs runs next to each other rather than one after another.
 * Once a run looks wrong, its stored log is one click away in the drawer.
 */
async function renderRuns() {
  const kind = state.runsKind ?? '';
  const runs = (await api(`/api/runs?limit=12${kind ? `&kind=${kind}` : ''}`)).reverse();

  const filter = ['', 'crawl', 'extract', 'discover']
    .map(
      (k) =>
        `<button class="btn small ${k === kind ? 'on' : ''}" data-runs-kind="${k}">
           ${k || 'all'}
         </button>`,
    )
    .join('');

  if (runs.length === 0) {
    main.innerHTML = `<h2>Runs</h2><div class="opts">${filter}</div>
      <div class="panel">No runs recorded yet. Run a stage and come back.</div>`;
    wireRunsFilter();
    return;
  }

  const names = [...new Set(runs.flatMap((r) => Object.keys(r.counters ?? {})))].sort();

  const header = runs
    .map((r) => {
      const when = new Date(r.started_at).toISOString().replace('T', ' ').slice(5, 16);
      return `<th title="${esc(r.kind)} — ${esc(r.status)} — click for this run's log">
        <button class="run-col" data-run-log="${r.id}">
          <div class="run-id">#${r.id}</div>
          <div class="run-when">${esc(when)}</div>
          <div class="run-kind ${esc(r.status)}">${esc(r.kind)}</div>
        </button>
      </th>`;
    })
    .join('');

  const body = names
    .map((name) => {
      const cells = runs
        .map((r, i) => {
          const value = r.counters?.[name];
          if (value === undefined) return '<td class="absent">–</td>';
          const previous = i > 0 ? runs[i - 1].counters?.[name] : undefined;
          const change = previous === undefined ? null : value - previous;
          const arrow =
            change === null || change === 0
              ? ''
              : `<span class="delta ${change > 0 ? 'up' : 'down'}">${change > 0 ? '+' : ''}${change}</span>`;
          return `<td>${value}${arrow}</td>`;
        })
        .join('');
      return `<tr><th class="counter">${esc(name)}</th>${cells}</tr>`;
    })
    .join('');

  main.innerHTML = `
    <h2>Runs</h2>
    <div class="opts">${filter}</div>
    <p class="hint">Oldest on the left. A counter that did not exist for a run shows
      as – rather than 0: absent and zero are different findings. Click a run to read
      the log it stored.</p>
    <div class="panel scroll">
      <table class="runs">
        <thead><tr><th class="counter"></th>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  wireRunsFilter();
  $$('[data-run-log]').forEach((button) => {
    const run = runs.find((r) => String(r.id) === button.dataset.runLog);
    button.onclick = () => followRun(run);
  });
}

function wireRunsFilter() {
  $$('[data-runs-kind]').forEach((button) => {
    button.onclick = () => {
      state.runsKind = button.dataset.runsKind;
      render();
    };
  });
}

async function render() {
  try {
    await VIEWS[state.view]();
  } catch (error) {
    main.innerHTML = `<h2>${esc(state.view)}</h2><div class="panel err">${esc(error.message)}</div>`;
  }
}

/** Reattach to a job still running from an earlier page load. */
async function resume() {
  const jobs = await api('/api/jobs').catch(() => []);
  const running = jobs.find((job) => job.status === 'running');
  if (running) {
    follow(running);
    toggleDrawer(true);
  }
}

await loadOverview();
await render();
await resume();
setInterval(loadOverview, 5000);
