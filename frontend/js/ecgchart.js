// Renderiza o traçado de ECG num canvas com grade estilo papel milimetrado,
// marcação dos complexos QRS e um cursor de reprodução sincronizado ao coração 3D.

export class EcgChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.samples = [];
    this.fs = 250;
    this.duration = 10;
    this.rPeaks = [];
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(300, rect.width) * dpr;
    this.canvas.height = Math.max(140, rect.height) * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = this.canvas.width / dpr;
    this.h = this.canvas.height / dpr;
  }

  setData(samples, fs, duration, rPeaks) {
    this.samples = samples || [];
    this.fs = fs || 250;
    this.duration = duration || (this.samples.length / this.fs);
    this.rPeaks = rPeaks || [];
    // Normaliza amplitude para caber no canvas.
    const finite = this.samples.filter((v) => Number.isFinite(v));
    const max = Math.max(0.5, ...finite.map((v) => Math.abs(v)));
    this._scale = max;
  }

  _drawGrid() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0406';
    ctx.fillRect(0, 0, w, h);
    // grade fina (1 mm) e grossa (5 mm) — papel milimetrado carmim
    const small = 8;
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += small) {
      ctx.strokeStyle = (x % (small * 5) === 0) ? 'rgba(226,72,60,0.26)' : 'rgba(226,72,60,0.10)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += small) {
      ctx.strokeStyle = (y % (small * 5) === 0) ? 'rgba(226,72,60,0.26)' : 'rgba(226,72,60,0.10)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  _x(i) { return (i / (this.samples.length - 1)) * this.w; }
  _y(v) { return this.h / 2 - (v / this._scale) * (this.h * 0.42); }

  _drawTrace() {
    const { ctx } = this;
    if (this.samples.length < 2) return;
    ctx.strokeStyle = '#54e38e';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(84,227,142,0.55)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let i = 0; i < this.samples.length; i++) {
      const x = this._x(i);
      const y = this._y(this.samples[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Marca os picos R detectados.
    ctx.fillStyle = 'rgba(255,220,120,0.9)';
    for (const p of this.rPeaks) {
      if (p < this.samples.length) {
        const x = this._x(p);
        const y = this._y(this.samples[p]);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // Desenha o cursor de reprodução na posição temporal t (segundos).
  render(t) {
    this._drawGrid();
    this._drawTrace();
    const { ctx, w, h } = this;
    const frac = Math.max(0, Math.min(1, t / this.duration));
    const x = frac * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    // marcador no ponto atual do traçado
    const i = Math.min(this.samples.length - 1, Math.floor(frac * (this.samples.length - 1)));
    if (i >= 0 && Number.isFinite(this.samples[i])) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(x, this._y(this.samples[i]), 4, 0, Math.PI * 2); ctx.fill();
    }
  }
}
