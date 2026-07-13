// Núcleo do Cardio3D em JavaScript puro — funciona 100% no navegador, sem backend.
//
// Reúne, em JS, o que antes era feito em Python:
//   * gerador de ECG sintético (demonstrações / fallback);
//   * digitalização de ECG a partir de imagem (canvas);
//   * análise do sinal (detecção de QRS, FC, intervalos PR/QRS/QT/QTc, ST…);
//   * interpretação clínica (ritmo, achados, repercussão, estruturas, animação).
//
// Saída no MESMO formato que a antiga API, para o restante do app não mudar.

const REF = { PR: [120, 200], QRS: [70, 110], QTc: [350, 450], HR: [60, 100] };
const SEV = { INFO: 'info', WARN: 'atencao', CRIT: 'critico' };

const STRUCTURES = {
  atrio_direito: 'Átrio direito', atrio_esquerdo: 'Átrio esquerdo',
  ventriculo_direito: 'Ventrículo direito', ventriculo_esquerdo: 'Ventrículo esquerdo',
  septo: 'Septo interventricular', valva_tricuspide: 'Valva tricúspide', valva_mitral: 'Valva mitral',
  valva_aortica: 'Valva aórtica', valva_pulmonar: 'Valva pulmonar',
  no_sa: 'Nó sinoatrial (SA)', no_av: 'Nó atrioventricular (AV)', feixe_his: 'Feixe de His',
  ramo_direito: 'Ramo direito', ramo_esquerdo: 'Ramo esquerdo', purkinje: 'Fibras de Purkinje',
  aorta: 'Aorta', arteria_pulmonar: 'Artéria pulmonar', veia_cava: 'Veias cavas',
};

const DISCLAIMER =
  'Ferramenta educacional e de demonstração. As interpretações são geradas por algoritmo heurístico e ' +
  'NÃO constituem diagnóstico médico. Procure sempre um profissional de saúde qualificado.';

// ---------- utilidades ----------
function mulberry32(seed) { // PRNG determinístico
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const median = (arr) => {
  const a = arr.filter((v) => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

// ================= GERADOR SINTÉTICO =================
const WAVES = { P: [-0.20, 0.15, 0.025], Q: [-0.035, -0.10, 0.012], R: [0, 1.10, 0.020], S: [0.035, -0.25, 0.012], T: [0.22, 0.32, 0.05] };

export function generate(rhythm = 'sinus', heartRate = 72, duration = 10, fs = 250, seed = 7) {
  const rng = mulberry32(seed);
  const n = Math.floor(duration * fs);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / fs;
  const sig = new Float64Array(n);
  const baseRR = 60 / Math.max(30, Math.min(220, heartRate));

  const rTimes = [], morphs = [];
  let tcur = 0.4;
  while (tcur < duration - 0.4) {
    let rr = baseRR;
    const morph = JSON.parse(JSON.stringify(WAVES));
    const qtScale = Math.max(0.6, Math.min(1.25, Math.sqrt(baseRR / 0.85)));
    morph.T[0] *= qtScale; morph.T[2] *= qtScale;

    if (rhythm === 'afib') { rr = baseRR * (0.62 + rng() * 0.83); morph.P[1] = 0; }
    else if (rhythm === 'pvc') {
      if (rTimes.length && rTimes.length % 4 === 3) {
        rr = baseRR * 0.62; morph.P[1] = 0; morph.R[1] = 1.5; morph.R[2] = 0.05; morph.S[1] = -0.6; morph.T[1] = -0.45;
      }
    } else if (rhythm === 'st_elevation') { morph.T[0] = 0.24; morph.T[1] = 0.45; morph.ST_extra = [0.085, 0.28, 0.06]; }

    rTimes.push(tcur); morphs.push(morph);
    const jitter = (rhythm === 'sinus' || rhythm === 'st_elevation') ? (rng() - 0.5) * 0.024 : 0;
    tcur += rr + jitter;
  }
  for (let k = 0; k < rTimes.length; k++) {
    const rt = rTimes[k], morph = morphs[k];
    for (const key in morph) {
      const [off, amp, w] = morph[key];
      for (let i = 0; i < n; i++) sig[i] += amp * Math.exp(-((t[i] - (rt + off)) ** 2) / (2 * w * w));
    }
  }
  for (let i = 0; i < n; i++) sig[i] += (rng() - 0.5) * 0.024 + 0.03 * Math.sin(2 * Math.PI * 0.25 * t[i]);
  return { signal: Array.from(sig), fs, duration, source: `synthetic:${rhythm}` };
}

// ================= ANÁLISE =================
function detrend(x, fs) { // remove linha de base por média móvel
  const win = Math.max(3, Math.round(0.6 * fs)), out = new Float64Array(x.length);
  let acc = 0; const q = [];
  for (let i = 0; i < x.length; i++) {
    q.push(x[i]); acc += x[i];
    if (q.length > win) acc -= q.shift();
    out[i] = x[i] - acc / q.length;
  }
  return out;
}
function smooth(x, k = 3) {
  const out = new Float64Array(x.length), h = k >> 1;
  for (let i = 0; i < x.length; i++) {
    let s = 0, c = 0;
    for (let j = -h; j <= h; j++) { const idx = i + j; if (idx >= 0 && idx < x.length) { s += x[idx]; c++; } }
    out[i] = s / c;
  }
  return out;
}
function detectQRS(x, fs) {
  const diff = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) diff[i] = x[i] - x[i - 1];
  const sq = diff.map((v) => v * v);
  const win = Math.max(1, Math.round(0.12 * fs));
  const integ = smooth(sq, win * 2 + 1);
  const thr = mean(Array.from(integ)) + 0.5 * std(Array.from(integ));
  const minDist = Math.max(1, Math.round(0.25 * fs));
  const peaks = [];
  let last = -minDist;
  for (let i = 1; i < integ.length - 1; i++) {
    if (integ[i] > thr && integ[i] >= integ[i - 1] && integ[i] > integ[i + 1] && i - last >= minDist) { peaks.push(i); last = i; }
  }
  // refina para o máximo local do sinal
  const r = Math.max(1, Math.round(0.05 * fs)), refined = [];
  for (const p of peaks) {
    let a0 = Math.max(0, p - r), a1 = Math.min(x.length, p + r), best = a0;
    for (let i = a0; i < a1; i++) if (x[i] > x[best]) best = i;
    if (!refined.length || best - refined[refined.length - 1] >= minDist) refined.push(best);
  }
  return refined;
}
function wavePoints(x, fs, rIdx) {
  const n = x.length, baseline = median(Array.from(x));
  let noise = 0; { const dev = Array.from(x).map((v) => Math.abs(v - baseline)); noise = median(dev) * 1.15 + 1e-6; }
  const beats = [];
  for (const rr of rIdx) {
    const q0 = Math.max(0, rr - Math.round(0.05 * fs));
    let q = rr; for (let i = q0; i < rr; i++) if (x[i] < x[q]) q = i; if (rr <= q0) q = rr;
    const s1 = Math.min(n, rr + Math.round(0.06 * fs));
    let s = rr; for (let i = rr; i < s1; i++) if (x[i] < x[s]) s = i;
    const iA = Math.max(0, q - Math.round(0.05 * fs)), iB = Math.max(1, q - Math.round(0.01 * fs));
    const iso = iB > iA ? median(Array.from(x).slice(iA, iB)) : baseline;
    const pA = Math.max(0, rr - Math.round(0.22 * fs)), pB = Math.max(0, rr - Math.round(0.08 * fs));
    let p = null; if (pB > pA) { let c = pA; for (let i = pA; i < pB; i++) if (x[i] > x[c]) c = i; if (x[c] - baseline > noise) p = c; }
    const tA = Math.min(n, rr + Math.round(0.15 * fs)), tB = Math.min(n, rr + Math.round(0.42 * fs));
    let tp = null; if (tB > tA) { let c = tA; for (let i = tA; i < tB; i++) if (Math.abs(x[i] - iso) > Math.abs(x[c] - iso)) c = i; tp = c; }
    let tEnd = null;
    if (tp !== null) {
      const e0 = tp, e1 = Math.min(n, tp + Math.round(0.20 * fs)), amp = Math.abs(x[tp] - iso) + 1e-6;
      for (let i = e0; i < e1; i++) if (Math.abs(x[i] - iso) < 0.10 * amp) { tEnd = i; break; }
      if (tEnd === null) { let c = e0; for (let i = e0; i < e1; i++) if (Math.abs(x[i] - iso) < Math.abs(x[c] - iso)) c = i; tEnd = c; }
    }
    beats.push({ P: p, Q: q, R: rr, S: s, T: tp, T_end: tEnd, iso });
  }
  return beats;
}

export function analyze(signalArr, fs, confidence = 1) {
  const xr = Float64Array.from(signalArr);
  if (xr.length < fs) return { ok: false, reason: 'Sinal muito curto para análise.' };
  const x = smooth(detrend(xr, fs), 3);
  const rIdx = detectQRS(x, fs);
  if (rIdx.length < 2) return { ok: false, reason: 'Nenhum complexo QRS detectável.' };

  const rr = []; for (let i = 1; i < rIdx.length; i++) rr.push((rIdx[i] - rIdx[i - 1]) / fs);
  const hrSeries = rr.map((v) => 60 / v);
  const hrMean = median(hrSeries), hrMin = Math.min(...hrSeries), hrMax = Math.max(...hrSeries);
  const rrMs = rr.map((v) => v * 1000);
  const sdnn = std(rrMs);
  let rmssd = 0; if (rrMs.length > 1) { const d = []; for (let i = 1; i < rrMs.length; i++) d.push((rrMs[i] - rrMs[i - 1]) ** 2); rmssd = Math.sqrt(mean(d)); }
  const irregularity = sdnn / (mean(rrMs) + 1e-9);

  const beats = wavePoints(x, fs, rIdx);
  const prList = [], qrsList = [], qtList = []; let pPresent = 0;
  for (const b of beats) {
    if (b.P !== null) { pPresent++; prList.push((b.Q - b.P) / fs * 1000); }
    qrsList.push((b.S - b.Q) / fs * 1000);
    if (b.T_end !== null) qtList.push((b.T_end - b.Q) / fs * 1000);
  }
  const pr = median(prList), qrs = median(qrsList), qt = median(qtList);
  const rrMeanS = mean(rr);
  const qtcB = qt ? qt / Math.sqrt(rrMeanS) : null;
  const qtcF = qt ? qt / Math.cbrt(rrMeanS) : null;
  const pFraction = pPresent / beats.length;

  const stLevels = [];
  for (const b of beats) { const j = b.S + Math.round(0.02 * fs), st = j + Math.round(0.06 * fs); if (st < x.length) stLevels.push(x[st] - b.iso); }
  const stLevel = stLevels.length ? median(stLevels) : 0;
  const rAmp = median(beats.map((b) => x[b.R] - b.iso));

  const events = beats.map((b) => ({ p: b.P !== null ? b.P / fs : null, qrs: b.R / fs, t: b.T !== null ? b.T / fs : null, q: b.Q / fs, s: b.S / fs }));
  const round = (v, d = 1) => (v === null || v === undefined) ? null : Math.round(v * 10 ** d) / 10 ** d;

  return {
    ok: true, fs, duration: x.length / fs, confidence, n_beats: beats.length,
    heart_rate: { mean: round(hrMean), min: round(hrMin), max: round(hrMax) },
    intervals_ms: { PR: round(pr), QRS: round(qrs), QT: round(qt), QTc_Bazett: round(qtcB), QTc_Fridericia: round(qtcF), RR_mean: round(rrMeanS * 1000) },
    variability: { SDNN_ms: round(sdnn), RMSSD_ms: round(rmssd), irregularity: round(irregularity, 3) },
    morphology: { p_wave_fraction: round(pFraction, 2), st_level_mv: round(stLevel, 3), r_amplitude_mv: round(rAmp, 3) },
    beats: events, filtered_signal: Array.from(x).map((v) => Math.round(v * 1e4) / 1e4), r_peaks: rIdx,
  };
}

// ================= INTERPRETAÇÃO =================
function finding(titulo, detalhe, sev, repercussao = '', estruturas = []) { return { titulo, detalhe, severidade: sev, repercussao, estruturas }; }

export function interpret(a) {
  const structures = {};
  for (const k in STRUCTURES) structures[k] = { nome: STRUCTURES[k], estado: 'normal', obs: '' };
  const mark = (keys, estado, obs) => keys.forEach((k) => { structures[k].estado = estado; structures[k].obs = obs; });

  if (!a.ok) {
    return { ritmo: 'Indeterminado', achados: [finding('Análise não conclusiva', a.reason || 'Sinal insuficiente.', SEV.WARN)],
      impressao: 'Não foi possível interpretar o traçado com segurança. Envie uma imagem mais nítida.',
      analise_combinada: 'Sem dados suficientes para correlacionar achados.', structures,
      animation: { rhythm: 'sinus', highlight_atria: true, structures: {} }, disclaimer: DISCLAIMER };
  }
  const hr = a.heart_rate.mean, iv = a.intervals_ms, va = a.variability, morph = a.morphology;
  const achados = []; const anim = {}; let rhythmAnim = 'sinus';

  if (hr < 60) { achados.push(finding('Bradicardia', `Frequência cardíaca média de ${Math.round(hr)} bpm (< 60 bpm).`, SEV.WARN,
      'Débito cardíaco pode cair; se sintomática, causa fadiga, tontura ou síncope. O nó sinoatrial dispara mais lentamente.', ['no_sa'])); mark(['no_sa'], 'lento', 'Disparo sinusal lento'); }
  else if (hr > 100) { const sev = hr > 150 ? SEV.CRIT : SEV.WARN; achados.push(finding('Taquicardia', `Frequência cardíaca média de ${Math.round(hr)} bpm (> 100 bpm).`, sev,
      'Encurta a diástole e o enchimento ventricular, aumentando o consumo de oxigênio do miocárdio.', ['no_sa', 'ventriculo_esquerdo'])); mark(['no_sa'], 'rapido', 'Disparo sinusal acelerado'); }
  else achados.push(finding('Frequência normal', `Frequência cardíaca média de ${Math.round(hr)} bpm.`, SEV.INFO, 'Ritmo de disparo do nó sinoatrial dentro do esperado.', ['no_sa']));

  const irregular = va.irregularity > 0.15, pAbsent = morph.p_wave_fraction < 0.5;
  let ritmo;
  if (irregular && pAbsent) {
    ritmo = 'Fibrilação atrial (provável)';
    achados.push(finding('Ritmo irregularmente irregular sem onda P', `Variabilidade RR elevada (SDNN ${Math.round(va.SDNN_ms)} ms) e ausência de ondas P organizadas.`, SEV.CRIT,
      'Os átrios não contraem de forma coordenada — perde-se a contribuição atrial ao enchimento ventricular (~20% do débito) e há estase sanguínea nos átrios, com risco de trombos e embolia (AVC).', ['atrio_direito', 'atrio_esquerdo', 'no_av']));
    rhythmAnim = 'afib'; mark(['atrio_direito', 'atrio_esquerdo'], 'fibrilando', 'Contração desorganizada'); mark(['no_av'], 'irregular', 'Condução irregular aos ventrículos'); anim.atria = 'fibrillating';
  } else if (irregular) {
    ritmo = 'Ritmo irregular';
    achados.push(finding('Ritmo irregular', `Variabilidade dos intervalos RR acima do esperado (SDNN ${Math.round(va.SDNN_ms)} ms).`, SEV.WARN,
      'Batimentos precoces ou pausas alteram o enchimento ventricular, podendo gerar palpitações.', ['ventriculo_esquerdo', 'ventriculo_direito']));
    rhythmAnim = 'pvc'; mark(['ventriculo_esquerdo', 'ventriculo_direito'], 'extrassistole', 'Batimentos ectópicos'); anim.ventricles = 'ectopic';
  } else if (pAbsent) {
    ritmo = 'Ritmo regular sem onda P clara';
    achados.push(finding('Onda P pouco visível', 'Onda P não identificada de forma consistente.', SEV.WARN,
      'Pode ser limitação da imagem ou um ritmo de origem juncional (o nó AV assume o comando), com perda da contração atrial efetiva.', ['atrio_direito', 'atrio_esquerdo', 'no_av']));
    mark(['atrio_direito', 'atrio_esquerdo'], 'silencioso', 'Atividade atrial não identificada');
  } else {
    const base = hr < 60 ? 'bradicárdico' : hr > 100 ? 'taquicárdico' : 'normal';
    ritmo = `Ritmo sinusal (${base})`;
    achados.push(finding('Ritmo sinusal', 'Ondas P presentes precedendo cada QRS, ritmo regular.', SEV.INFO, 'Condução normal: nó SA → átrios → nó AV → His-Purkinje → ventrículos.', ['no_sa', 'atrio_direito', 'atrio_esquerdo']));
  }

  const pr = iv.PR;
  if (pr !== null) {
    if (pr > REF.PR[1]) { achados.push(finding('PR prolongado', `Intervalo PR de ${Math.round(pr)} ms (> 200 ms) — sugere bloqueio AV de 1º grau.`, SEV.WARN,
        'A condução entre átrios e ventrículos está lentificada no nó AV.', ['no_av', 'feixe_his'])); mark(['no_av'], 'bloqueio_lento', 'Condução AV lentificada'); anim.av = 'delayed'; }
    else if (pr < REF.PR[0]) { achados.push(finding('PR curto', `Intervalo PR de ${Math.round(pr)} ms (< 120 ms) — considerar pré-excitação (ex.: WPW).`, SEV.WARN,
        'Pode haver uma via acessória conduzindo o impulso mais rápido que o nó AV.', ['no_av', 'feixe_his'])); mark(['no_av'], 'pre_excitacao', 'Condução acelerada / via acessória'); }
  }
  const qrs = iv.QRS;
  if (qrs !== null && qrs > REF.QRS[1]) {
    const sev = qrs > 140 ? SEV.CRIT : SEV.WARN;
    achados.push(finding('QRS alargado', `Duração do QRS de ${Math.round(qrs)} ms (> 110 ms) — bloqueio de ramo ou origem ventricular.`, sev,
      'A despolarização ventricular não segue a via rápida normal; um ventrículo é ativado com atraso, gerando contração dessincronizada.', ['ramo_direito', 'ramo_esquerdo', 'purkinje', 'ventriculo_esquerdo']));
    mark(['ramo_esquerdo'], 'bloqueado', 'Bloqueio de ramo (condução tardia)'); mark(['ventriculo_esquerdo', 'ventriculo_direito'], 'dessincronizado', 'Contração assíncrona');
    anim.bundle = 'block_left'; if (qrs > 120 && rhythmAnim === 'sinus') rhythmAnim = 'pvc';
  }
  const qtc = iv.QTc_Bazett;
  if (qtc !== null) {
    if (qtc > REF.QTc[1]) { const sev = qtc > 500 ? SEV.CRIT : SEV.WARN; achados.push(finding('QTc prolongado', `QTc (Bazett) de ${Math.round(qtc)} ms (> 450 ms).`, sev,
        'A repolarização ventricular está prolongada, aumentando o risco de arritmias ventriculares graves (torsades de pointes).', ['ventriculo_esquerdo', 'ventriculo_direito'])); mark(['ventriculo_esquerdo', 'ventriculo_direito'], 'repolarizacao_lenta', 'Repolarização prolongada'); }
    else if (qtc < REF.QTc[0]) achados.push(finding('QTc curto', `QTc de ${Math.round(qtc)} ms (< 350 ms).`, SEV.WARN, 'Repolarização acelerada; pode associar-se a canalopatias.', ['ventriculo_esquerdo']));
  }
  const st = morph.st_level_mv;
  if (st > 0.12) {
    achados.push(finding('Supradesnivelamento de ST',
      `Elevação do segmento ST de ~${Math.round(st * 1000)} µV — padrão de infarto agudo com supra de ST (IAMCSST). Local afetado destacado no modelo 3D: parede anterior do ventrículo esquerdo (território da artéria descendente anterior). Nota: a localização definitiva do território exige o ECG de 12 derivações.`,
      SEV.CRIT, "Uma região da parede ventricular está sem fluxo sanguíneo adequado (oclusão coronária) e em sofrimento isquêmico — o músculo daquela área contrai mal. É uma emergência tempo-dependente ('tempo é músculo').", ['ventriculo_esquerdo', 'ramo_esquerdo']));
    rhythmAnim = 'st_elevation'; mark(['ventriculo_esquerdo'], 'isquemico', 'Sofrimento/lesão da parede ventricular'); anim.lv_wall = 'ischemic';
  } else if (st < -0.12) {
    achados.push(finding('Infradesnivelamento de ST', `Depressão do segmento ST de ~${Math.round(Math.abs(st) * 1000)} µV — pode indicar isquemia.`, SEV.WARN,
      'Pode refletir isquemia subendocárdica (oferta de oxigênio insuficiente) ou sobrecarga ventricular.', ['ventriculo_esquerdo']));
    mark(['ventriculo_esquerdo'], 'isquemia_subendo', 'Possível isquemia subendocárdica');
  }

  const criticos = achados.filter((x) => x.severidade === SEV.CRIT), atencao = achados.filter((x) => x.severidade === SEV.WARN);
  let cab;
  if (criticos.length) cab = '⚠ Alterações que exigem avaliação médica imediata: ' + criticos.map((x) => x.titulo).join(', ') + '.';
  else if (atencao.length) cab = 'Alterações que merecem atenção: ' + atencao.map((x) => x.titulo).join(', ') + '.';
  else cab = 'Traçado dentro dos parâmetros de normalidade para os itens avaliados.';
  let impressao = `${ritmo}, frequência cardíaca média de ${Math.round(hr)} bpm. ${cab}`;
  if ((a.confidence ?? 1) < 0.5) impressao += ' Observação: a digitalização da imagem teve confiança baixa; as medidas são aproximadas.';

  const alteradas = Object.values(structures).filter((v) => v.estado !== 'normal').map((v) => v.nome);
  const partes = []; const titles = new Set(achados.map((x) => x.titulo));
  if (titles.has('Ritmo irregularmente irregular sem onda P')) partes.push('O conjunto (RR irregular + ausência de onda P) aponta para fibrilação atrial: os átrios deixam de bombear de forma organizada e a resposta ventricular fica irregular. A repercussão é a perda do "chute atrial" e o risco tromboembólico.');
  if (titles.has('Supradesnivelamento de ST')) partes.push('O supradesnivelamento de ST indica lesão miocárdica ativa: uma parede ventricular está isquêmica e sua contração fica comprometida — quadro tempo-dependente.');
  if (titles.has('QRS alargado')) partes.push('O QRS alargado revela condução ventricular anômala (bloqueio de ramo), com contração dessincronizada dos ventrículos.');
  if (titles.has('PR prolongado')) partes.push('O PR prolongado indica lentificação da condução no nó AV.');
  if (!partes.length) partes.push('Os parâmetros elétricos e a condução mostram-se coordenados, sem repercussão hemodinâmica evidente nos itens avaliados.');
  if (alteradas.length) partes.push('Estruturas com alteração destacada no modelo 3D: ' + alteradas.join(', ') + '.');

  return {
    ritmo, achados, impressao, analise_combinada: partes.join(' '), structures,
    animation: { rhythm: rhythmAnim, highlight_atria: !pAbsent, wide_qrs: !!(qrs && qrs > 120), st_elevation: st > 0.12, structures: anim },
    disclaimer: DISCLAIMER,
  };
}

// ================= DIGITALIZAÇÃO DE IMAGEM (canvas) =================
// Recebe um HTMLImageElement/ImageBitmap já carregado; devolve sinal calibrado.
export function digitizeImage(imgOrBitmap) {
  const MM_S = 25, MM_MV = 10;
  let w = imgOrBitmap.width, h = imgOrBitmap.height;
  const maxW = 1600; let scale = 1;
  if (w > maxW) { scale = maxW / w; w = Math.round(w * scale); h = Math.round(h * scale); }
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgOrBitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const gray = new Float64Array(w * h), grid = new Uint8Array(w * h), mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const gr = 0.299 * r + 0.587 * g + 0.114 * b; gray[i] = gr;
    const redness = r - Math.max(g, b);
    if (redness > 20) grid[i] = 1;
    if (gr < 110 && redness <= 25) mask[i] = 1;
  }
  // px/mm via autocorrelação da projeção de colunas da grade
  const col = new Float64Array(w);
  for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) s += grid[y * w + x]; col[x] = s; }
  const cm = mean(Array.from(col)); for (let x = 0; x < w; x++) col[x] -= cm;
  let pxPerMm = 200 / 25.4, gridConf = 0.2;
  const maxLag = Math.min(80, w - 1); const ac = new Float64Array(maxLag);
  for (let lag = 1; lag < maxLag; lag++) { let s = 0; for (let x = 0; x + lag < w; x++) s += col[x] * col[x + lag]; ac[lag] = s; }
  let acMax = 0; for (let i = 1; i < maxLag; i++) acMax = Math.max(acMax, ac[i]);
  if (acMax > 0) {
    let acAbsMean = 0; for (let i = 1; i < maxLag; i++) acAbsMean += Math.abs(ac[i]); acAbsMean /= (maxLag - 1);
    for (let lag = 2; lag < maxLag - 1; lag++) {
      if (ac[lag] >= 0.35 * acMax && ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
        if (lag >= 3 && lag <= 40) { pxPerMm = lag; gridConf = Math.min(1, ac[lag] / (acAbsMean * 6 + 1e-6)); }
        break;
      }
    }
  }
  // banda horizontal mais densa (tira de ritmo)
  const rowDens = new Float64Array(h);
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += mask[y * w + x]; rowDens[y] = s; }
  const band = Math.max(20, Math.floor(h / 8)); let bestC = band, bestV = -1;
  for (let c = band; c < h - band; c += 2) { let s = 0; for (let y = c - band; y < c + band; y++) s += rowDens[y]; if (s > bestV) { bestV = s; bestC = c; } }
  const top = Math.max(0, bestC - band), bot = Math.min(h, bestC + band);
  // rastreia coluna a coluna
  const ys = new Float64Array(w).fill(NaN); let covered = 0;
  for (let x = 0; x < w; x++) { let sum = 0, cnt = 0; for (let y = top; y < bot; y++) if (mask[y * w + x]) { sum += y; cnt++; } if (cnt) { ys[x] = sum / cnt; covered++; } }
  covered /= w;
  // interpola lacunas
  let firstGood = -1; for (let x = 0; x < w; x++) if (!Number.isNaN(ys[x])) { firstGood = x; break; }
  if (firstGood < 0) return { signal: [], fs: 250, duration: 0, confidence: 0, notes: ['Traçado não encontrado.'] };
  for (let x = 0; x < firstGood; x++) ys[x] = ys[firstGood];
  for (let x = 1; x < w; x++) if (Number.isNaN(ys[x])) { let x2 = x; while (x2 < w && Number.isNaN(ys[x2])) x2++; const a0 = ys[x - 1], a1 = x2 < w ? ys[x2] : a0; for (let k = x; k < x2; k++) ys[k] = a0 + (a1 - a0) * (k - x + 1) / (x2 - x + 1); x = x2; }
  const baseY = median(Array.from(ys));
  const pxPerS = pxPerMm * MM_S, fsCol = pxPerS;
  const sigMv = new Float64Array(w); for (let x = 0; x < w; x++) sigMv[x] = -(ys[x] - baseY) / (pxPerMm * MM_MV);
  const duration = w / pxPerS;
  // reamostra para 250 Hz
  const targetFs = 250, nT = Math.max(4, Math.floor(duration * targetFs)); const out = new Float64Array(nT);
  for (let i = 0; i < nT; i++) { const pos = i / (nT - 1) * (w - 1), i0 = Math.floor(pos), f = pos - i0; out[i] = sigMv[i0] * (1 - f) + sigMv[Math.min(w - 1, i0 + 1)] * f; }
  const inkFrac = mask.reduce((s, v) => s + v, 0) / (w * h);
  const confidence = Math.max(0, Math.min(1, 0.45 * gridConf + 0.35 * covered + 0.20 * Math.min(1, inkFrac * 40)));
  const notes = [];
  if (covered < 0.35) notes.push('Cobertura baixa do traçado — imagem pode estar cortada ou com pouco contraste.');
  if (gridConf < 0.3) notes.push('Grade não detectada com clareza — calibração de tempo/amplitude aproximada.');
  return { signal: Array.from(out), fs: targetFs, duration: out.length / targetFs, confidence, px_per_mm: pxPerMm, notes };
}

// ================= MONTAGEM DO RESULTADO (formato da antiga API) =================
export function buildResult(signal, fs, confidence, meta) {
  const analysis = analyze(signal, fs, confidence);
  const interpretation = interpret(analysis);
  const display = analysis.ok ? analysis.filtered_signal : signal;
  return {
    meta,
    signal: { samples: display, fs: analysis.fs || fs, duration: analysis.duration, r_peaks: analysis.r_peaks || [] },
    analysis, interpretation,
  };
}

const DEMO_HR = { sinus: 72, bradycardia: 47, tachycardia: 118, afib: 96, pvc: 76, st_elevation: 82 };
export function demo(rhythm = 'sinus', duration = 10) {
  const r = DEMO_HR[rhythm] !== undefined ? rhythm : 'sinus';
  const syn = generate(r, DEMO_HR[r], duration);
  return buildResult(syn.signal, syn.fs, 1, { mode: 'demo', rhythm_requested: r, source: syn.source, confidence: 1 });
}
