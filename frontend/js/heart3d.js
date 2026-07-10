// Molde cardíaco 3D animado e completo, sincronizado ao ritmo do ECG.
//
// Modela TODAS as estruturas cardíacas — 4 câmaras, septo, 4 valvas, grandes
// vasos e o sistema de condução completo (nó SA, nó AV, feixe de His, ramos
// direito/esquerdo e fibras de Purkinje) — e demonstra visualmente a alteração
// detectada no ECG sobre a estrutura correspondente:
//
//   * onda P    -> contração dos átrios (ou fibrilação, na FA);
//   * QRS       -> contração dos ventrículos (ou assíncrona, no bloqueio de ramo);
//   * marcador  -> percorre nó SA -> nó AV -> His -> ramos -> Purkinje;
//   * isquemia  -> parede do ventrículo esquerdo destacada (supra de ST);
//   * bloqueio  -> nó AV / ramo com condução atrasada ou interrompida.
//
// Rótulos opcionais nomeiam cada estrutura sobre o modelo.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const C = {
  myo: 0x8c1c1c, atria: 0xb5433a, rv: 0x7a1f1f,
  septum: 0x6e1616, valve: 0xe8d9a0, vesselA: 0xb04b4b, vesselV: 0x5b6fb0,
  node: 0xffe08a, hilite: 0xff5a4d, ischemic: 0x3a0d0d, block: 0x556070,
};

function pulse(t, t0, width) {
  if (t0 === null || t0 === undefined) return 0;
  const d = (t - t0) / width;
  return Math.exp(-d * d);
}

function chamber(rx, ry, rz, color, opacity = 0.9) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.05, transparent: true, opacity,
    emissive: new THREE.Color(color).multiplyScalar(0.15),
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
  mesh.scale.set(rx, ry, rz);
  return mesh;
}

function vessel(rt, rb, h, color) {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(rt, rb, h, 24, 1, true),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
}

// Rótulo de texto como sprite (canvas -> textura).
function makeLabel(text) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = '600 26px Segoe UI, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 18;
  cv.width = w; cv.height = 38;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10,6,12,0.78)';
  if (ctx.roundRect) { ctx.roundRect(0, 0, w, 38, 9); ctx.fill(); }
  else ctx.fillRect(0, 0, w, 38);
  ctx.fillStyle = '#ffe9e4';
  ctx.fillText(text, 9, 27);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(w / 130, 38 / 130, 1);
  return spr;
}

export class HeartModel {
  constructor(container) {
    this.container = container;
    this.beats = [];
    this.duration = 10;
    this.animation = { rhythm: 'sinus', highlight_atria: true, structures: {} };
    this.showLabels = false;
    this._initScene();
    this._buildHeart();
    this._raf = null;
    window.addEventListener('resize', () => this._onResize());
  }

  _initScene() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.camera.position.set(0, 0.4, 8);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4.5;
    this.controls.maxDistance = 15;

    const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(4, 6, 6);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.6); fill.position.set(-6, 2, 3);
    const rim = new THREE.DirectionalLight(0xff8866, 0.7); rim.position.set(0, -3, -6);
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0x404050, 1.1));
  }

  _buildHeart() {
    this.heart = new THREE.Group();
    this.heart.rotation.z = -0.18;
    this.scene.add(this.heart);
    this.parts = {};   // chave da estrutura -> mesh
    this.labels = [];  // {sprite, anchor}

    const add = (key, mesh, pos, labelName) => {
      mesh.position.set(...pos);
      if (mesh.material) {
        mesh.userData.baseColor = mesh.material.color.getHex();
        mesh.userData.rest = mesh.scale.clone();
      }
      this.heart.add(mesh);
      this.parts[key] = mesh;
      if (labelName) {
        const spr = makeLabel(labelName);
        spr.visible = false;
        this.heart.add(spr);
        this.labels.push({ sprite: spr, anchor: new THREE.Vector3(...pos), mesh });
      }
      return mesh;
    };

    // --- Câmaras ---
    add('ventriculo_esquerdo', chamber(1.15, 1.5, 1.15, C.myo), [-0.45, -0.7, 0], 'Ventrículo esq.');
    add('ventriculo_direito', chamber(0.95, 1.25, 1.05, C.rv, 0.9), [0.7, -0.55, 0.35], 'Ventrículo dir.');
    add('atrio_esquerdo', chamber(0.72, 0.62, 0.72, C.atria, 0.9), [-0.5, 0.95, -0.1], 'Átrio esq.');
    add('atrio_direito', chamber(0.7, 0.6, 0.72, C.atria, 0.9), [0.75, 0.95, 0.3], 'Átrio dir.');

    // --- Septo interventricular ---
    const septum = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 2.4, 1.6),
      new THREE.MeshStandardMaterial({ color: C.septum, roughness: 0.6, transparent: true, opacity: 0.85 })
    );
    add('septo', septum, [0.12, -0.6, 0.1], null);

    // --- Valvas (discos finos) ---
    const valveGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.06, 20);
    const valveMat = () => new THREE.MeshStandardMaterial({ color: C.valve, roughness: 0.4, emissive: 0x221a00 });
    add('valva_mitral', new THREE.Mesh(valveGeo, valveMat()), [-0.5, 0.2, 0], 'Valva mitral');
    add('valva_tricuspide', new THREE.Mesh(valveGeo, valveMat()), [0.7, 0.25, 0.3], null);
    const semi = new THREE.CylinderGeometry(0.22, 0.22, 0.06, 18);
    add('valva_aortica', new THREE.Mesh(semi, valveMat()), [-0.12, 0.75, -0.05], null);
    add('valva_pulmonar', new THREE.Mesh(semi, valveMat()), [0.5, 0.8, 0.28], null);

    // --- Grandes vasos ---
    const aorta = vessel(0.26, 0.3, 1.7, C.vesselA); aorta.rotation.z = 0.15;
    add('aorta', aorta, [-0.1, 1.75, -0.1], 'Aorta');
    const pulm = vessel(0.24, 0.28, 1.5, C.vesselV); pulm.rotation.z = -0.2;
    add('arteria_pulmonar', pulm, [0.5, 1.8, 0.25], 'A. pulmonar');
    add('veia_cava', vessel(0.18, 0.2, 1.1, C.vesselV), [1.15, 1.7, 0.3], null);

    // --- Sistema de condução ---
    this.pathPoints = [
      new THREE.Vector3(0.9, 1.25, 0.45),   // nó SA
      new THREE.Vector3(0.35, 0.35, 0.2),   // nó AV
      new THREE.Vector3(0.12, -0.1, 0.1),   // feixe de His
      new THREE.Vector3(-0.3, -1.0, 0.05),  // ramo esquerdo
      new THREE.Vector3(-0.5, -2.0, 0),     // Purkinje / ápice
    ];
    const nodeGeo = new THREE.SphereGeometry(0.13, 16, 16);
    const nodeMat = () => new THREE.MeshStandardMaterial({ color: C.node, emissive: 0x332200, roughness: 0.4 });
    add('no_sa', new THREE.Mesh(nodeGeo, nodeMat()), this.pathPoints[0].toArray(), 'Nó SA');
    add('no_av', new THREE.Mesh(nodeGeo, nodeMat()), this.pathPoints[1].toArray(), 'Nó AV');
    add('feixe_his', new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), nodeMat()), this.pathPoints[2].toArray(), 'Feixe de His');

    // Ramos direito/esquerdo + Purkinje como linhas.
    const branchMat = (op = 0.6) => new THREE.LineBasicMaterial({ color: C.node, transparent: true, opacity: op });
    const mkLine = (pts) => new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), branchMat());
    this.ramoEsq = mkLine([this.pathPoints[2], this.pathPoints[3], this.pathPoints[4]]);
    this.ramoDir = mkLine([this.pathPoints[2], new THREE.Vector3(0.6, -1.0, 0.2), new THREE.Vector3(0.75, -1.9, 0.15)]);
    this.parts['ramo_esquerdo'] = this.ramoEsq;
    this.parts['ramo_direito'] = this.ramoDir;
    this.heart.add(this.ramoEsq, this.ramoDir);
    // Purkinje: pequenos ramos no ápice.
    const purk = mkLine([this.pathPoints[4], new THREE.Vector3(-0.9, -1.7, 0.1)]);
    this.parts['purkinje'] = purk;
    this.heart.add(purk);

    // Marcador de condução.
    this.spark = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), new THREE.MeshBasicMaterial({ color: 0xfff2b0 }));
    this.spark.visible = false;
    this.heart.add(this.spark);

    // Região isquêmica (patch sobre a parede do VE), oculta por padrão.
    this.ischemicPatch = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 24, 16, 0, Math.PI, 0, Math.PI * 0.7),
      new THREE.MeshStandardMaterial({ color: C.ischemic, emissive: 0x220000, roughness: 0.8, transparent: true, opacity: 0.9 })
    );
    this.ischemicPatch.position.set(-1.0, -0.9, 0.2);
    this.ischemicPatch.visible = false;
    this.heart.add(this.ischemicPatch);

    this.glow = new THREE.PointLight(C.hilite, 0, 6);
    this.glow.position.set(-0.3, -0.6, 0.5);
    this.heart.add(this.glow);
  }

  setBeats(beats, duration, animation) {
    this.beats = beats || [];
    this.duration = duration || 10;
    if (animation) this.animation = animation;
    // Aplica o estado das estruturas (alterações fixas).
    this._applyStructures(this.animation.structures || {});
  }

  setLabels(on) {
    this.showLabels = on;
    for (const l of this.labels) l.sprite.visible = on;
  }

  // Ajusta a aparência estática das estruturas conforme a alteração detectada.
  _applyStructures(st) {
    // reset visual
    this.ischemicPatch.visible = false;
    this.ramoEsq.material.color.setHex(C.node); this.ramoEsq.material.opacity = 0.6;
    this.ramoDir.material.color.setHex(C.node); this.ramoDir.material.opacity = 0.6;

    if (st.lv_wall === 'ischemic') this.ischemicPatch.visible = true;
    if (st.bundle === 'block_left') {
      this.ramoEsq.material.color.setHex(C.block);
      this.ramoEsq.material.opacity = 0.9;
    }
    this._struct = st;
  }

  _activation(t) {
    let atrial = 0, ventric = 0, nearestQ = null, phase = 0;
    for (const b of this.beats) {
      const pT = (b.p !== null && b.p !== undefined) ? b.p : (b.qrs - 0.16);
      atrial = Math.max(atrial, pulse(t, pT, 0.05));
      ventric = Math.max(ventric, pulse(t, b.qrs, 0.045));
      const start = pT - 0.02, end = b.qrs + 0.04;
      if (t >= start && t <= end) { phase = (t - start) / (end - start); nearestQ = b.qrs; }
    }
    return { atrial, ventric, sparkPhase: nearestQ !== null ? phase : null };
  }

  _sparkPos(phase) {
    const seg = phase * (this.pathPoints.length - 1);
    const i = Math.min(this.pathPoints.length - 2, Math.floor(seg));
    return this.pathPoints[i].clone().lerp(this.pathPoints[i + 1], seg - i);
  }

  _contract(mesh, amount, maxShrink, asym = 0) {
    if (!mesh || !mesh.userData.rest) return;
    const s = mesh.userData.rest;
    const k = 1 - maxShrink * amount;
    mesh.scale.set(s.x * k, s.y * k, s.z * (k - asym * 0.1));
    if (mesh.material?.emissive) {
      mesh.material.emissive.setHex(C.hilite).multiplyScalar((0.15 + 0.85 * amount) * 0.5);
    }
  }

  update(t) {
    const { atrial, ventric, sparkPhase } = this._activation(t);
    const st = this._struct || {};

    // Átrios: contração coordenada OU fibrilação (jitter rápido de baixa amplitude).
    if (st.atria === 'fibrillating') {
      const fib = 0.5 + 0.5 * Math.sin(t * 45);
      this._contract(this.parts.atrio_esquerdo, fib * 0.4, 0.06);
      this._contract(this.parts.atrio_direito, (1 - fib) * 0.4, 0.06);
      this.parts.atrio_esquerdo.material.color.setHex(0xc65a4a);
      this.parts.atrio_direito.material.color.setHex(0xc65a4a);
    } else {
      this._contract(this.parts.atrio_esquerdo, atrial, 0.16);
      this._contract(this.parts.atrio_direito, atrial, 0.16);
    }

    // Ventrículos: contração; se bloqueio de ramo, o VE contrai com atraso (assíncrono).
    const lvDelay = st.bundle === 'block_left' ? 0.05 : 0;
    const { ventric: lvAct } = this._activation(t - lvDelay);
    this._contract(this.parts.ventriculo_esquerdo, lvAct, 0.2, st.bundle ? 0.5 : 0);
    this._contract(this.parts.ventriculo_direito, ventric, 0.2);

    // Valvas AV pulsam ao contrair (fecham na sístole ventricular).
    if (this.parts.valva_mitral) this.parts.valva_mitral.rotation.x = ventric * 0.5;
    if (this.parts.valva_tricuspide) this.parts.valva_tricuspide.rotation.x = ventric * 0.5;

    // Nós brilham conforme a onda passa; nó AV atrasado em bloqueio.
    if (this.parts.no_sa) this.parts.no_sa.material.emissive.setHex(0x332200).addScalar(atrial * 0.7);
    if (this.parts.no_av) {
      const avGlow = st.av === 'delayed' ? ventric * 0.4 : ventric * 0.7;
      this.parts.no_av.material.emissive.setHex(st.av === 'delayed' ? 0x332200 : 0x332200).addScalar(avGlow);
    }

    // Região isquêmica pulsa em vermelho de alerta.
    if (this.ischemicPatch.visible) {
      const p = 0.5 + 0.5 * Math.sin(t * 4);
      this.ischemicPatch.material.emissive.setHex(0x330000).addScalar(p * 0.5);
    }

    // Marcador de condução.
    if (sparkPhase !== null) { this.spark.visible = true; this.spark.position.copy(this._sparkPos(sparkPhase)); }
    else this.spark.visible = false;

    this.glow.intensity = lvAct * 3.2;
    this.heart.rotation.y = Math.sin(t * 0.4) * 0.12;

    // Rótulos: espalhados radialmente para fora do centro, evitando sobreposição.
    if (this.showLabels) {
      for (const l of this.labels) {
        const dir = l.anchor.clone().setLength(1);
        l.sprite.position.copy(l.anchor)
          .add(dir.multiplyScalar(0.9))
          .add(new THREE.Vector3(0, 0.12, 0));
      }
    }
  }

  start(getTime) {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.update(getTime());
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  _onResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
