// TTS Result Viewer
// Loads configs/viewer_config.yaml, then <results_root>/index.json, then one
// result set (result_set.json) and one group file at a time.
// File formats are described in results/README.md.

const DEFAULT_CONFIG = {
  results_root: '../results',
  index_file: 'index.json',
  default_result_set: 'latest',
  waveform_height: 48,
};

const WAVE_COLORS = {
  real:      { wave: '#86efac', progress: '#16a34a' },
  reference: { wave: '#fcd34d', progress: '#a16207' },
  generated: { wave: '#94a3b8', progress: '#3b82f6' },
};

const state = {
  config: { ...DEFAULT_CONFIG },
  index: null,       // parsed index.json
  set: null,         // parsed result_set.json
  setName: null,
  group: null,       // group record from result_set.json
  items: [],         // items of the loaded group file
  visible: [],       // items after the speaker filter
  position: 0,       // index into visible
  rows: [],          // one entry per row of the current item, a player or null
  lastPlayer: null,
  loadToken: 0,      // answers of an outdated selection are dropped
  notices: { library: '', config: '', load: '', play: '' },
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  el('set-select').addEventListener('change', e => selectSet(e.target.value));
  el('group-select').addEventListener('change', e => selectGroup(e.target.value));
  el('speaker-select').addEventListener('change', e => applySpeaker(e.target.value));
  el('item-select').addEventListener('change', e => showItem(Number(e.target.value)));
  el('prev-btn').addEventListener('click', () => step(-1));
  el('next-btn').addEventListener('click', () => step(1));
  el('stop-btn').addEventListener('click', stopAll);
  document.addEventListener('keydown', handleKey);
  window.addEventListener('hashchange', () => navigate(readHash()));

  if (typeof WaveSurfer === 'undefined') {
    setNotice('library', 'wavesurfer.js could not be loaded. Rows fall back to the plain browser player without waveforms.');
  }

  await loadConfig();

  const indexUrl = `${state.config.results_root}/${state.config.index_file}`;
  try {
    state.index = await fetchJson(indexUrl);
  } catch (err) {
    fail(`No result set index at ${indexUrl} (${err.message}).\n`
       + 'Build a result set first, in result_viewer/ with "make result-set NAME=<name>".');
    return;
  }
  const sets = state.index.result_sets || [];
  if (!sets.length) {
    fail('The index lists no result set. Build one in result_viewer/ with "make result-set NAME=<name>".');
    return;
  }

  const select = el('set-select');
  select.replaceChildren();
  for (const entry of sets) {
    const day = (entry.created_at || '').slice(0, 10);
    select.appendChild(makeOption(entry.name, day ? `${entry.title} (${day})` : entry.title));
  }

  const want = readHash();
  await selectSet(pickStartSet(want.set), want);
}

async function loadConfig() {
  const url = 'configs/viewer_config.yaml';
  let text;
  try {
    text = await fetchText(url);
  } catch (err) {
    setNotice('config', `Could not load ${url} (${err.message}). Built-in defaults are used.`);
    return;
  }
  if (typeof jsyaml === 'undefined') {
    setNotice('config', `js-yaml could not be loaded, so ${url} was not read. Built-in defaults are used.`);
    return;
  }
  try {
    const parsed = jsyaml.load(text);
    if (parsed && typeof parsed === 'object') Object.assign(state.config, parsed);
  } catch (err) {
    setNotice('config', `Could not parse ${url} (${err.message}). Built-in defaults are used.`);
  }
}

function pickStartSet(fromHash) {
  const names = state.index.result_sets.map(s => s.name);
  if (fromHash && names.includes(fromHash)) return fromHash;
  const wanted = state.config.default_result_set;
  if (wanted && wanted !== 'latest') {
    if (names.includes(wanted)) return wanted;
    setNotice('config', `default_result_set "${wanted}" is not in the index. The latest set is shown.`);
  }
  return names.includes(state.index.latest) ? state.index.latest : names[0];
}

// ─── Selection ────────────────────────────────────────────────────────────────

async function selectSet(name, want = {}) {
  const token = ++state.loadToken;
  destroyPlayers();
  el('set-select').value = name;
  let set;
  try {
    set = await fetchJson(setUrl(name, 'result_set.json'));
  } catch (err) {
    if (token !== state.loadToken) return;
    clearItem();
    setNotice('load', `Result set "${name}" could not be loaded (${err.message}).`, true);
    return;
  }
  if (token !== state.loadToken) return;
  state.set = set;
  state.setName = name;

  const select = el('group-select');
  select.replaceChildren();
  for (const group of set.groups || []) {
    select.appendChild(makeOption(group.group_id, `${group.dataset_id} / ${group.task_set} (${group.n_items})`));
  }
  if (!set.groups || !set.groups.length) {
    clearItem();
    setNotice('load', `Result set "${name}" holds no group.`, true);
    return;
  }
  const groupId = set.groups.some(g => g.group_id === want.group) ? want.group : set.groups[0].group_id;
  await selectGroup(groupId, want);
}

async function selectGroup(groupId, want = {}) {
  const token = ++state.loadToken;
  destroyPlayers();
  const group = state.set.groups.find(g => g.group_id === groupId);
  el('group-select').value = groupId;
  let data;
  try {
    data = await fetchJson(setUrl(state.setName, group.file));
  } catch (err) {
    if (token !== state.loadToken) return;
    clearItem();
    setNotice('load', `Group "${groupId}" could not be loaded (${err.message}).`, true);
    return;
  }
  if (token !== state.loadToken) return;
  state.group = group;
  state.items = data.items || [];
  setNotice('load', '');

  const select = el('speaker-select');
  select.replaceChildren(makeOption('', `All speakers (${group.speakers.length})`));
  for (const speaker of group.speakers) select.appendChild(makeOption(speaker, speaker));

  applySpeaker('', want.item);
}

function applySpeaker(speaker, wantItem) {
  el('speaker-select').value = speaker;
  state.visible = speaker ? state.items.filter(i => i.speaker_id === speaker) : state.items;

  const select = el('item-select');
  select.replaceChildren();
  state.visible.forEach((item, i) => select.appendChild(makeOption(String(i), itemLabel(item))));

  if (!state.visible.length) {
    clearItem();
    setNotice('load', 'No item in this selection.', true);
    return;
  }
  showItem(Math.max(0, state.visible.findIndex(i => i.task_id === wantItem)));
}

function step(delta) {
  const next = state.position + delta;
  if (next >= 0 && next < state.visible.length) showItem(next);
}

function navigate(want) {
  if (!state.index || !want.set) return;
  if (want.set !== state.setName) {
    if (state.index.result_sets.some(s => s.name === want.set)) selectSet(want.set, want);
    return;
  }
  if (want.group && state.group && want.group !== state.group.group_id) {
    if (state.set.groups.some(g => g.group_id === want.group)) selectGroup(want.group, want);
    return;
  }
  if (want.item && state.visible[state.position]?.task_id !== want.item) {
    let idx = state.visible.findIndex(i => i.task_id === want.item);
    if (idx < 0 && state.items.some(i => i.task_id === want.item)) {
      applySpeaker('', want.item);
      return;
    }
    if (idx >= 0) showItem(idx);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function showItem(position) {
  const item = state.visible[position];
  if (!item) return;
  state.position = position;

  el('item-select').value = String(position);
  el('position-display').textContent = `${position + 1} / ${state.visible.length}`;
  el('prev-btn').disabled = position <= 0;
  el('next-btn').disabled = position >= state.visible.length - 1;

  const meta = el('reference-meta');
  meta.replaceChildren();
  const facts = [
    state.group.dataset_id,
    state.group.task_set,
    item.speaker_id ? `speaker ${item.speaker_id}` : null,
    `task ${item.task_id}`,
    `language ${item.language}`,
  ];
  for (const fact of facts.filter(Boolean)) meta.appendChild(makeEl('span', '', fact));
  el('reference-text').textContent = item.target_text;

  renderRows(item);
  renderSetInfo();
  writeHash();
}

function renderRows(item) {
  destroyPlayers();
  const container = el('rows');
  container.replaceChildren();

  const recordings = [];
  if (item.real) {
    recordings.push({
      kind: 'real',
      main: 'Original recording',
      sub: item.speaker_id ? `speaker ${item.speaker_id}` : (item.target_utterance_id || ''),
      title: `Real recording of the target text (${item.target_utterance_id || 'unknown utterance'})`,
      entry: item.real,
    });
  }
  (item.references || []).forEach((ref, i) => {
    recordings.push({
      kind: 'reference',
      main: item.references.length > 1 ? `Cloning reference ${i + 1}` : 'Cloning reference',
      sub: ref.text ? `"${ref.text}"` : (ref.utterance_id || ''),
      title: `Reference audio given to the cloning models (${ref.utterance_id || 'unknown utterance'})`,
      entry: ref,
    });
  });

  if (recordings.length) {
    container.appendChild(makeEl('div', 'section-title', 'Recordings'));
    for (const spec of recordings) addRow(container, spec);
  }

  container.appendChild(makeEl('div', 'section-title', 'Generated speech'));
  for (const systemId of state.group.systems) {
    const display = systemDisplay(systemId);
    addRow(container, { kind: 'generated', ...display, entry: item.outputs[systemId] });
  }
}

// The one place that decides how a system is named on screen.
// Blind review (anonymised labels with a reveal button) hooks in here.
function systemDisplay(systemId) {
  const system = state.set.systems[systemId] || {};
  const run = state.group.runs[systemId] || {};
  const title = [
    system.model_id,
    run.checkpoint ? `checkpoint ${run.checkpoint}` : null,
    run.revision ? `revision ${run.revision}` : null,
    run.sample_rate ? `${run.sample_rate} Hz` : null,
    run.finished_at ? `generated ${run.finished_at}` : null,
    run.run_dir,
  ].filter(Boolean).join('\n');
  return {
    main: system.label || systemId,
    sub: [system.model_id, system.mode, system.run_label].filter(Boolean).join(' · '),
    title,
  };
}

function addRow(container, spec) {
  const number = state.rows.length + 1;
  const row = makeEl('div', 'row');
  row.dataset.kind = spec.kind;

  row.appendChild(makeEl('span', 'row-index', number <= 9 ? String(number) : ''));

  const label = makeEl('div', 'row-label');
  label.title = spec.title || '';
  const main = makeEl('div', 'row-label-main');
  main.appendChild(makeEl('span', 'row-kind'));
  main.appendChild(document.createTextNode(spec.main));
  label.appendChild(main);
  label.appendChild(makeEl('div', 'row-label-sub', spec.sub || ''));
  row.appendChild(label);

  const button = makeEl('button', 'row-play', '▶');
  button.setAttribute('aria-label', `Play or pause ${spec.main}`);
  row.appendChild(button);

  const wave = makeEl('div', 'row-wave');
  row.appendChild(wave);

  const meta = makeEl('div', 'row-meta');
  row.appendChild(meta);
  container.appendChild(row);

  const entry = spec.entry;
  if (entry && entry.audio) {
    meta.textContent = typeof entry.duration_s === 'number' ? `${entry.duration_s.toFixed(2)} s` : '';
    state.rows.push(createPlayer(row, wave, button, setUrl(state.setName, entry.audio), spec.kind));
  } else {
    button.disabled = true;
    const status = makeEl('span', 'row-status error', outputProblem(entry));
    if (entry && entry.detail) status.title = entry.detail;
    wave.appendChild(status);
    state.rows.push(null);
  }
}

function outputProblem(entry) {
  if (!entry || entry.error === 'not_generated') return 'Not generated in this run';
  if (entry.error === 'missing_audio') return 'Audio file missing';
  return `Generation failed (${entry.error})`;
}

function renderSetInfo() {
  const set = state.set;
  const parts = [
    set.title,
    set.created_at ? `built ${set.created_at.replace('T', ' ').slice(0, 16)}` : null,
    `audio ${set.audio}`,
    `${state.group.n_items} items`,
    `${state.group.systems.length} systems`,
  ];
  el('set-info').textContent = parts.filter(Boolean).join(' · ');
}

function clearItem() {
  destroyPlayers();
  state.visible = [];
  el('item-select').replaceChildren();
  el('position-display').textContent = '';
  el('reference-meta').replaceChildren();
  el('reference-text').textContent = '';
  el('rows').replaceChildren();
  el('set-info').textContent = '';
}

// ─── Audio ────────────────────────────────────────────────────────────────────

function createPlayer(row, wave, button, url, kind) {
  const player = { destroyed: false };
  button.disabled = true;

  const setPlaying = on => {
    row.classList.toggle('playing', on);
    button.textContent = on ? '⏸' : '▶';
  };
  const onPlay = () => {
    for (const other of state.rows) if (other && other !== player) other.pause();
    state.lastPlayer = player;
    setNotice('play', '');
    setPlaying(true);
  };
  const onError = err => {
    if (player.destroyed) return;
    console.error('Audio error:', url, err);
    wave.replaceChildren(makeEl('span', 'row-status error', 'Audio file could not be loaded'));
    button.disabled = true;
  };
  const playFailed = err => setNotice('play', `Playback did not start (${err.message}).`, true);

  if (typeof WaveSurfer !== 'undefined') {
    const colors = WAVE_COLORS[kind] || WAVE_COLORS.generated;
    const ws = WaveSurfer.create({
      container: wave,
      url,
      height: Number(state.config.waveform_height) || DEFAULT_CONFIG.waveform_height,
      waveColor: colors.wave,
      progressColor: colors.progress,
      cursorColor: '#0f172a',
      barWidth: 2, barGap: 1, barRadius: 2,
      // Not normalised, so loudness differences between systems stay visible.
      normalize: false,
    });
    ws.on('ready', () => { button.disabled = false; });
    ws.on('play', onPlay);
    ws.on('pause', () => setPlaying(false));
    ws.on('finish', () => setPlaying(false));
    ws.on('error', onError);
    player.toggle = () => Promise.resolve(ws.playPause()).catch(playFailed);
    player.pause = () => { if (ws.isPlaying()) ws.pause(); };
    player.stop = () => { ws.pause(); ws.setTime(0); };
    player.destroy = () => ws.destroy();
  } else {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => setPlaying(false));
    audio.addEventListener('error', () => onError(audio.error));
    wave.appendChild(audio);
    button.disabled = false;
    player.toggle = () => (audio.paused ? audio.play().catch(playFailed) : audio.pause());
    player.pause = () => { if (!audio.paused) audio.pause(); };
    player.stop = () => { audio.pause(); audio.currentTime = 0; };
    player.destroy = () => { audio.pause(); audio.removeAttribute('src'); audio.load(); };
  }

  button.addEventListener('click', () => player.toggle());
  return player;
}

function stopAll() {
  for (const player of state.rows) if (player) player.stop();
}

function destroyPlayers() {
  for (const player of state.rows) {
    if (!player) continue;
    player.destroyed = true;
    player.destroy();
  }
  state.rows = [];
  state.lastPlayer = null;
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

function handleKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'ArrowRight') { step(1); e.preventDefault(); return; }
  if (e.key === 'ArrowLeft')  { step(-1); e.preventDefault(); return; }
  if (e.key === 'Escape')     { stopAll(); return; }
  if (e.key === ' ') {
    if (tag === 'BUTTON') return;  // the focused button handles Space itself
    const player = state.lastPlayer || state.rows.find(Boolean);
    if (player) player.toggle();
    e.preventDefault();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    const player = state.rows[Number(e.key) - 1];
    if (player) player.toggle();
  }
}

// ─── Address (deep links to one item) ─────────────────────────────────────────

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { set: params.get('set'), group: params.get('group'), item: params.get('item') };
}

function writeHash() {
  const params = new URLSearchParams();
  params.set('set', state.setName);
  params.set('group', state.group.group_id);
  params.set('item', state.visible[state.position].task_id);
  history.replaceState(null, '', `#${params.toString()}`);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

function setNotice(slot, text, isError = false) {
  state.notices[slot] = text ? { text, isError } : '';
  const active = Object.values(state.notices).filter(Boolean);
  const bar = el('message-bar');
  bar.hidden = active.length === 0;
  bar.textContent = active.map(n => n.text).join('\n');
  bar.classList.toggle('error', active.some(n => n.isError));
}

function fail(text) {
  clearItem();
  setNotice('load', text, true);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function makeEl(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function makeOption(value, label) {
  const opt = document.createElement('option');
  opt.value = value; opt.textContent = label;
  return opt;
}

function itemLabel(item) {
  const text = item.target_text.length > 48 ? `${item.target_text.slice(0, 48)}…` : item.target_text;
  return `${item.task_id}  ${text}`;
}

function setUrl(name, relative) {
  return encodeURI(`${state.config.results_root}/${name}/${relative}`);
}

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
