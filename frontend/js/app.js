// Orquestração do Cardio3D: upload/demo -> API -> gráfico ECG + coração 3D + laudo.

import { HeartModel } from './heart3d.js';
import { EcgChart } from './ecgchart.js';

// Se aberto via arquivo local, aponta para o servidor local; senão usa a mesma origem.
const API_BASE = location.protocol === 'file:' ? 'http://localhost:8000' : '';

const el = (id) => document.getElementById(id);

// ----- Estado de reprodução (relógio virtual) -----
const clock = {
  t: 0,
  duration: 10,
  speed: 1,
  playing: true,
  last: performance.now(),
  tick() {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t > this.duration) this.t = 0; // loop contínuo
    }
    return this.t;
  },
};

let heart, chart, currentData;

function init() {
  heart = new HeartModel(el('heart-canvas'));
  chart = new EcgChart(el('ecg-canvas'));

  heart.start(() => clock.t);
  // Loop de renderização do gráfico + atualização do relógio.
  const frame = () => {
    clock.tick();
    chart.render(clock.t);
    el('time-readout').textContent = `${clock.t.toFixed(1)}s / ${clock.duration.toFixed(1)}s`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  wireControls();
  // Carrega uma demonstração inicial para o coração começar batendo.
  loadDemo('sinus');
}

function wireControls() {
  el('play-pause').addEventListener('click', () => {
    clock.playing = !clock.playing;
    el('play-pause').textContent = clock.playing ? '⏸ Pausar' : '▶ Reproduzir';
  });
  el('speed').addEventListener('input', (e) => {
    clock.speed = parseFloat(e.target.value);
    el('speed-val').textContent = `${clock.speed.toFixed(1)}×`;
  });

  // Botões de demonstração.
  document.querySelectorAll('[data-demo]').forEach((b) => {
    b.addEventListener('click', () => loadDemo(b.dataset.demo));
  });

  // Alternar rótulos das estruturas no modelo 3D.
  let labelsOn = false;
  el('toggle-labels').addEventListener('click', () => {
    labelsOn = !labelsOn;
    heart.setLabels(labelsOn);
    el('toggle-labels').classList.toggle('active', labelsOn);
  });

  // Upload por clique e arrastar-soltar.
  const drop = el('dropzone');
  const input = el('file-input');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) uploadFile(input.files[0]); });
  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(f);
  });
}

function setStatus(msg, kind = 'info') {
  const s = el('status');
  s.textContent = msg;
  s.className = `status ${kind}`;
}

async function loadDemo(rhythm) {
  setStatus('Gerando ECG de demonstração…', 'info');
  try {
    const r = await fetch(`${API_BASE}/api/demo?rhythm=${encodeURIComponent(rhythm)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    applyResult(await r.json());
    setStatus(`Demonstração: ${rhythm}`, 'ok');
  } catch (err) {
    setStatus(`Falha ao carregar demonstração (${err.message}). Verifique se o servidor está ativo.`, 'error');
  }
}

async function uploadFile(file) {
  setStatus(`Processando "${file.name}"…`, 'info');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch(`${API_BASE}/api/analyze`, { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    applyResult(data);
    const conf = Math.round((data.meta.confidence || 0) * 100);
    setStatus(`Analisado: ${file.name} — confiança de digitalização ${conf}%`, conf < 40 ? 'warn' : 'ok');
  } catch (err) {
    setStatus(`Erro ao analisar arquivo: ${err.message}`, 'error');
  }
}

function applyResult(data) {
  currentData = data;
  const sig = data.signal;
  const an = data.analysis;
  const it = data.interpretation;

  clock.duration = sig.duration || (sig.samples.length / sig.fs);
  clock.t = 0;

  chart.setData(sig.samples, sig.fs, clock.duration, sig.r_peaks);
  heart.setBeats(an.ok ? an.beats : [], clock.duration, it.animation);

  renderInterpretation(an, it, data.meta);
}

// ----- Painel de análise técnica + laudo -----
function renderInterpretation(an, it, meta) {
  // Ritmo em destaque.
  el('rhythm-title').textContent = it.ritmo;

  // Tabela de medidas técnicas completas.
  const measures = el('measures');
  measures.innerHTML = '';
  if (an.ok) {
    const iv = an.intervals_ms;
    const hr = an.heart_rate;
    const morph = an.morphology;
    const va = an.variability;
    const rows = [
      ['Frequência cardíaca', `${hr.mean} bpm`, `${hr.min}–${hr.max}`, refFC(hr.mean)],
      ['Intervalo RR', `${iv.RR_mean} ms`, '', ''],
      ['Intervalo PR', fmt(iv.PR, 'ms'), '', refRange(iv.PR, 120, 200)],
      ['Duração QRS', fmt(iv.QRS, 'ms'), '', refRange(iv.QRS, 70, 110)],
      ['Intervalo QT', fmt(iv.QT, 'ms'), '', ''],
      ['QTc (Bazett)', fmt(iv.QTc_Bazett, 'ms'), '', refRange(iv.QTc_Bazett, 350, 450)],
      ['QTc (Fridericia)', fmt(iv.QTc_Fridericia, 'ms'), '', ''],
      ['Segmento ST', `${(morph.st_level_mv * 1000).toFixed(0)} µV`, '', refST(morph.st_level_mv)],
      ['Amplitude R', `${morph.r_amplitude_mv.toFixed(2)} mV`, '', ''],
      ['Onda P (presença)', `${Math.round(morph.p_wave_fraction * 100)}%`, '', ''],
      ['Variabilidade (SDNN)', `${va.SDNN_ms} ms`, '', ''],
      ['Batimentos analisados', `${an.n_beats}`, '', ''],
    ];
    for (const [label, val, extra, flag] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="ml">${label}</td>
        <td class="mv">${val}</td>
        <td class="me">${extra}</td>
        <td class="mf ${flag.kind || ''}">${flag.text || ''}</td>`;
      measures.appendChild(tr);
    }
  } else {
    measures.innerHTML = `<tr><td colspan="4">${an.reason || 'Sem medidas.'}</td></tr>`;
  }

  // Lista de achados com severidade + repercussão + estruturas envolvidas.
  const findings = el('findings');
  findings.innerHTML = '';
  const structNames = (an.ok || it.structures) ? (it.structures || {}) : {};
  for (const f of it.achados) {
    const li = document.createElement('li');
    li.className = `finding sev-${f.severidade}`;
    const estruturas = (f.estruturas || [])
      .map((k) => (it.structures?.[k]?.nome) || k)
      .join(', ');
    li.innerHTML = `<span class="badge">${sevLabel(f.severidade)}</span>
      <div>
        <strong>${f.titulo}</strong>
        <p>${f.detalhe}</p>
        ${f.repercussao ? `<p class="reperc"><b>Repercussão:</b> ${f.repercussao}</p>` : ''}
        ${estruturas ? `<p class="estr"><b>Estruturas:</b> ${estruturas}</p>` : ''}
      </div>`;
    findings.appendChild(li);
  }

  // Análise combinada + impressão diagnóstica.
  el('combined').textContent = it.analise_combinada || '';
  el('impression').textContent = it.impressao;

  // Painel de estado de todas as estruturas cardíacas.
  renderStructures(it.structures || {});

  // Avisos de digitalização + confiança.
  const warns = el('warnings');
  warns.innerHTML = '';
  const w = (meta && meta.warnings) || [];
  if (meta && meta.mode) {
    const modeLabel = { demo: 'Demonstração', upload: 'Arquivo enviado', fallback: 'Fallback' }[meta.mode] || meta.mode;
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = `Fonte: ${modeLabel}${meta.source ? ' · ' + meta.source : ''}`;
    warns.appendChild(chip);
  }
  for (const msg of w) {
    const d = document.createElement('div');
    d.className = 'warn-item';
    d.textContent = '⚠ ' + msg;
    warns.appendChild(d);
  }

  el('disclaimer').textContent = it.disclaimer || '';
}

// Renderiza o estado de todas as estruturas cardíacas.
function renderStructures(structures) {
  const box = el('structures');
  box.innerHTML = '';
  const entries = Object.values(structures);
  if (!entries.length) { box.innerHTML = '<p class="sub">Sem dados.</p>'; return; }
  for (const s of entries) {
    const alterada = s.estado && s.estado !== 'normal';
    const div = document.createElement('div');
    div.className = `struct ${alterada ? 'alt' : 'ok'}`;
    div.innerHTML = `<i class="sdot"></i>
      <div><span class="sname">${s.nome}</span>
      <span class="sstate">${alterada ? (s.obs || s.estado) : 'normal'}</span></div>`;
    box.appendChild(div);
  }
}

// ----- Utilidades de formatação -----
function fmt(v, unit) { return (v === null || v === undefined) ? '—' : `${v} ${unit}`; }
function sevLabel(s) { return { info: 'OK', atencao: 'Atenção', critico: 'Crítico' }[s] || s; }

function refRange(v, lo, hi) {
  if (v === null || v === undefined) return { text: '', kind: '' };
  if (v < lo) return { text: `↓ (< ${lo})`, kind: 'flag-warn' };
  if (v > hi) return { text: `↑ (> ${hi})`, kind: 'flag-warn' };
  return { text: 'normal', kind: 'flag-ok' };
}
function refFC(v) {
  if (v < 60) return { text: '↓ bradicardia', kind: 'flag-warn' };
  if (v > 100) return { text: '↑ taquicardia', kind: 'flag-warn' };
  return { text: 'normal', kind: 'flag-ok' };
}
function refST(v) {
  if (v > 0.12) return { text: '↑ supra', kind: 'flag-crit' };
  if (v < -0.12) return { text: '↓ infra', kind: 'flag-warn' };
  if (Math.abs(v) > 0.08) return { text: 'limítrofe', kind: 'flag-warn' };
  return { text: 'normal', kind: 'flag-ok' };
}

window.addEventListener('DOMContentLoaded', init);
