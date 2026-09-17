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
  discovery: null,    // last completed discovery result, kept across tab switches
  discoverSeed: '',
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

async function pollJob() {
  if (!state.job) return;
  let job;
  try {
    job = await api(`/api/jobs/${state.job.id}?since=${state.logCursor}`);
  } catch {
    return; // server restarted or job evicted; leave the last state on screen
  }

  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  for (const line of job.lines) {
    const div = document.createElement('div');
    div.className = line.level;
    div.textContent = `${line.ts.slice(11, 19)} [${line.scope}] ${line.message}${line.extra ? ' ' + line.extra : ''}`;
    logEl.appendChild(div);
  }
  if (job.lines.length && atBottom) logEl.scrollTop = logEl.scrollHeight;
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
    if (state.view === 'discover') render();
  }
  loadOverview();
  if (['pipeline', 'queue', 'review', 'sources', 'unmatched'].includes(state.view)) render();
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
    sources: sources.total || '',
    review: countOf(staging, 'review') || '',
    unmatched: unmatched || '',
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
  { key: 'parse', title: 'Parse', desc: 'Raw pages to staging rows: ingredients, steps, timings.' },
  { key: 'enrich', title: 'Enrich', desc: 'Step timers and step-to-ingredient links, from the model.' },
  { key: 'gate', title: 'Gate', desc: 'Score, de-duplicate, route to approved or review.' },
  { key: 'publish', title: 'Publish', desc: 'Approved rows into the app tables the API serves.' },
];

function stageBacklog(key) {
  const { staging, queue } = state.overview ?? {};
  switch (key) {
    case 'crawl': return { n: countOf(queue, 'pending'), unit: 'urls pending' };
    case 'parse': return { n: countOf(queue, 'done'), unit: 'pages crawled' };
    case 'enrich': return { n: countOf(staging, 'parsed'), unit: 'parsed' };
    case 'gate': return { n: countOf(staging, 'enriched'), unit: 'enriched' };
    case 'publish': return { n: countOf(staging, 'approved'), unit: 'approved' };
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
      stage.key === 'parse' ? flag('force', 're-parse')
      : stage.key === 'enrich' ? flag('escalate', 'escalate')
      : stage.key === 'publish' ? flag('republish', 'republish')
      : '';
    return `
      <div class="stage ${busy ? 'busy' : ''}">
        <div class="name"><span class="dot ${busy ? 'run' : ''}"></span>${stage.title}</div>
        <div class="metric"><span class="n">${n}</span><span class="unit">${unit}</span></div>
        <div class="desc">${stage.desc}</div>
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
        ${running.pipeline ? 'disabled' : ''}>Run crawl → parse → enrich → gate</button>
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
// Discover
// ---------------------------------------------------------------------------

function renderDiscover() {
  const running = state.overview?.running?.discover;
  const result = state.discovery;

  main.innerHTML = `
    <h2>Discover</h2>
    <p class="lede">
      Give it a homepage, a category page or a sitemap and it finds the recipe
      URLs itself — reading the site's sitemap when there is one, otherwise
      walking links from the seed. It obeys robots.txt and the same per-host
      crawl delay as the crawl stage, so exploring a site is exactly as
      well-behaved as crawling it.
    </p>

    <form class="panel grid" id="discover-form">
      <label class="field">Seed URL
        <input type="url" id="seed" required placeholder="https://example.com"
               value="${esc(state.discoverSeed)}">
      </label>
      <div class="row">
        <label class="field">Strategy
          <select id="mode">
            <option value="auto">Auto — sitemap, then links</option>
            <option value="sitemap">Sitemap only</option>
            <option value="links">Follow links only</option>
          </select>
        </label>
        <label class="field">Max pages to fetch <input type="number" id="maxPages" value="40" min="1" max="500"></label>
        <label class="field">Link depth <input type="number" id="maxDepth" value="2" min="1" max="5"></label>
        <label class="field">Max results <input type="number" id="maxResults" value="200" min="1" max="2000"></label>
      </div>
      <div class="row">
        <label class="field" style="flex:1;min-width:200px">URL must match (regex, optional)
          <input type="text" id="include" placeholder="/recipes?/">
        </label>
        <label class="field" style="flex:1;min-width:200px">URL must not match (regex, optional)
          <input type="text" id="exclude" placeholder="/(tag|author)/">
        </label>
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" id="dryRun"> Preview only — write nothing</label>
        <label class="check"><input type="checkbox" id="verify"> Verify every candidate (slower, exact)</label>
        <label class="check"><input type="checkbox" id="includeSubdomains"> Follow subdomains</label>
      </div>
      <div class="row">
        <button class="btn primary" type="submit" ${running ? 'disabled' : ''}>
          ${running ? 'Exploring…' : 'Explore site'}
        </button>
        <span class="note">Candidates found are queued automatically unless you tick preview.</span>
      </div>
    </form>

    <div id="discover-result">${result ? renderDiscoveryResult(result) : ''}</div>`;

  $('#discover-form').onsubmit = async (event) => {
    event.preventDefault();
    state.discoverSeed = $('#seed').value.trim();
    const body = {
      url: state.discoverSeed,
      mode: $('#mode').value,
      maxPages: Number($('#maxPages').value),
      maxDepth: Number($('#maxDepth').value),
      maxResults: Number($('#maxResults').value),
      dryRun: $('#dryRun').checked,
      verify: $('#verify').checked,
      includeSubdomains: $('#includeSubdomains').checked,
      include: $('#include').value.trim() || undefined,
      exclude: $('#exclude').value.trim() || undefined,
    };
    try {
      state.discovery = null;
      const job = await api('/api/discover', { method: 'POST', body });
      follow(job);
      render();
    } catch (error) {
      alert(error.message);
    }
  };

  wireDiscoveryResult();
}

function renderDiscoveryResult(result) {
  if (result.candidates.length === 0) {
    return `<h3>Result</h3><div class="panel"><p class="note">
      Nothing found on ${esc(result.domain)} — ${esc(result.stoppedBecause)}.
      Try raising the page budget or depth, or switch strategy.</p></div>`;
  }

  const rows = result.candidates
    .map(
      (candidate, index) => `
      <tr>
        <td><input type="checkbox" class="pick" value="${index}" ${candidate.verified ? '' : 'checked'}></td>
        <td class="url"><a href="${esc(candidate.url)}" target="_blank" rel="noopener">${esc(candidate.url)}</a>
          ${candidate.title ? `<div class="note">${esc(candidate.title)}</div>` : ''}</td>
        <td><span class="tag ${candidate.verified ? 'done' : ''}">${candidate.verified ? 'recipe confirmed' : 'candidate'}</span></td>
        <td class="note">${esc(candidate.via)}</td>
      </tr>`,
    )
    .join('');

  return `
    <h3>Result</h3>
    <div class="panel grid">
      <div class="row">
        <strong>${result.candidates.length}</strong> candidate(s) on ${esc(result.domain)}
        <span class="note">via ${esc(result.mode)} · ${result.pagesFetched} fetch(es) ·
          ${result.ingested} already ingested · ${result.enqueued} queued ·
          ${result.alreadyKnown} already known · stopped: ${esc(result.stoppedBecause)}</span>
      </div>
      <div class="row">
        <button class="btn small" id="pick-all">Select all</button>
        <button class="btn small" id="pick-none">Select none</button>
        <button class="btn primary small" id="queue-picked">Queue selected</button>
        <span class="note" id="queue-out"></span>
      </div>
      <table>
        <tr><th></th><th>URL</th><th>State</th><th>Found via</th></tr>
        ${rows}
      </table>
    </div>`;
}

function wireDiscoveryResult() {
  const result = state.discovery;
  if (!result || result.candidates.length === 0) return;

  $('#pick-all').onclick = () => $$('.pick').forEach((box) => (box.checked = true));
  $('#pick-none').onclick = () => $$('.pick').forEach((box) => (box.checked = false));
  $('#queue-picked').onclick = async () => {
    const urls = $$('.pick')
      .filter((box) => box.checked)
      .map((box) => result.candidates[Number(box.value)].url);
    const out = $('#queue-out');
    if (urls.length === 0) {
      out.textContent = 'nothing selected';
      return;
    }
    out.textContent = 'queueing…';
    try {
      const response = await api('/api/enqueue', { method: 'POST', body: { urls } });
      out.textContent = `${response.added} queued, ${response.alreadyQueued} already known`;
      loadOverview();
    } catch (error) {
      out.className = 'err';
      out.textContent = error.message;
    }
  };
}

// ---------------------------------------------------------------------------
// Bulk enqueue
// ---------------------------------------------------------------------------

function renderEnqueue() {
  main.innerHTML = `
    <h2>Add URLs</h2>
    <p class="lede">
      Paste as many as you like — one per line, or separated by spaces or commas.
      Duplicates and URLs already in the queue are ignored, so pasting the same
      list twice is harmless.
    </p>
    <form class="panel grid" id="enqueue-form">
      <textarea id="urls" placeholder="https://example.com/recipes/roast-chicken
https://example.com/recipes/apple-pie"></textarea>
      <div class="row">
        <label class="field">Priority <input type="number" id="priority" value="100" min="1" max="1000"></label>
        <span class="note">Lower runs first.</span>
      </div>
      <div class="row">
        <button class="btn primary" type="submit">Add to crawl queue</button>
        <span class="note" id="enqueue-out"></span>
      </div>
    </form>`;

  $('#enqueue-form').onsubmit = async (event) => {
    event.preventDefault();
    const out = $('#enqueue-out');
    out.className = 'note';
    out.textContent = 'adding…';
    try {
      const response = await api('/api/enqueue', {
        method: 'POST',
        body: { urls: $('#urls').value, priority: Number($('#priority').value) || 100 },
      });
      out.textContent =
        `${response.added} added · ${response.alreadyQueued} already queued` +
        (response.rejected ? ` · ${response.rejected} line(s) were not URLs` : '');
      $('#urls').value = '';
      loadOverview();
    } catch (error) {
      out.className = 'err';
      out.textContent = error.message;
    }
  };
}

// ---------------------------------------------------------------------------
// Crawl queue
// ---------------------------------------------------------------------------

const queueFilter = { status: 'all', q: '' };

async function renderQueue() {
  main.innerHTML = `
    <h2>Crawl queue</h2>
    <p class="lede">Every URL the pipeline knows about, newest first.</p>
    <div class="panel row" style="margin-bottom:14px">
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
      <button class="btn small" id="retry-failed">Retry all failed</button>
      <button class="btn small" id="retry-picked">Retry selected</button>
      <button class="btn small danger" id="delete-picked">Delete selected</button>
    </div>
    <div class="panel" id="queue-table"><div class="empty">Loading…</div></div>`;

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
    target.innerHTML = '<div class="empty">Nothing here.</div>';
    return;
  }
  target.innerHTML = `<table>
    <tr><th></th><th>URL</th><th>Status</th><th class="num">Tries</th><th>Domain</th><th>When</th></tr>
    ${rows
      .map(
        (row) => `<tr>
        <td><input type="checkbox" class="pick" value="${row.id}"></td>
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
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function renderSources() {
  const rows = await api('/api/sources');
  main.innerHTML = `
    <h2>Sources</h2>
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

  $$('.save').forEach((button) => {
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
  for (const row of rows) list.appendChild(reviewCard(row));
}

function reviewCard(row) {
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
      <button class="btn small approve" style="color:var(--ok);border-color:var(--ok)">Approve</button>
      <button class="btn small reject danger">Reject</button>
    </div>`;

  $('.toggle', card).onclick = () => card.classList.toggle('open');
  const decide = async (decision) => {
    await api('/api/decide', { method: 'POST', body: { id: row.id, decision } });
    card.style.opacity = '.35';
    $$('button', card).forEach((b) => (b.disabled = true));
    loadOverview();
  };
  $('.approve', card).onclick = () => decide('approved');
  $('.reject', card).onclick = () => decide('rejected');
  return card;
}

// ---------------------------------------------------------------------------
// Unmatched ingredients
// ---------------------------------------------------------------------------

async function renderUnmatched() {
  const rows = await api('/api/unmatched');
  main.innerHTML = `
    <h2>Unmatched ingredients</h2>
    <p class="lede">Strings the canonical dictionary could not resolve, commonest first.
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
  discover: renderDiscover,
  enqueue: renderEnqueue,
  queue: renderQueue,
  sources: renderSources,
  review: renderReview,
  unmatched: renderUnmatched,
};

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
