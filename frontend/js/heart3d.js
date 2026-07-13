// Molde cardíaco 3D realista — carrega um modelo anatômico real (glTF/GLB) e o
// anima sincronizado ao ECG.
//
// Modelo: coração anatômico texturizado do projeto open-source "interactive_3d"
// (MIT, © 2025 Muhammad Adnan) — ver NOTICE.
//
// Como a malha é única, a resposta do coração é global e realista:
//   * sístole ventricular (QRS) -> leve compressão + "flush" emissivo do miocárdio;
//   * a alteração detectada muda o COMPORTAMENTO do batimento:
//       - fibrilação atrial -> tremor rápido e irregular do brilho;
//       - supra de ST/isquemia -> pulsação avermelhada sustentada (sofrimento);
//       - bloqueio de ramo -> contração ventricular atrasada;
//   * um marcador percorre a via de condução (SA -> AV -> His -> Purkinje);
//   * rótulos opcionais nomeiam as regiões anatômicas.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URL = './vendor/models/heart.glb';
const FLUSH = new THREE.Color(0xff5a3c);     // brilho normal do batimento
const ISCHEMIC = new THREE.Color(0xd11f12);  // brilho de sofrimento (isquemia)

function pulse(t, t0, w) {
  if (t0 === null || t0 === undefined) return 0;
  const d = (t - t0) / w;
  return Math.exp(-d * d);
}

function makeLabel(text) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = '600 26px Segoe UI, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 18;
  cv.width = w; cv.height = 38; ctx.font = font;
  ctx.fillStyle = 'rgba(20,10,12,0.82)';
  if (ctx.roundRect) { ctx.roundRect(0, 0, w, 38, 9); ctx.fill(); } else ctx.fillRect(0, 0, w, 38);
  ctx.fillStyle = '#fff2ee'; ctx.fillText(text, 9, 27);
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(w / 165, 38 / 165, 1);
  return spr;
}

export class HeartModel {
  constructor(container) {
    this.container = container;
    this.beats = [];
    this.duration = 10;
    this.animation = { rhythm: 'sinus', highlight_atria: true, structures: {} };
    this.showLabels = false;
    this._struct = {};
    this.loaded = false;
    this.labels = [];
    this._initScene();
    this._loadModel();
    this._raf = null;
    window.addEventListener('resize', () => this._onResize());
  }

  _initScene() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
    this.camera.position.set(0, 0.2, 9);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4.5;
    this.controls.maxDistance = 18;

    const key = new THREE.DirectionalLight(0xfff4ec, 2.5); key.position.set(4, 6, 7);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.8); fill.position.set(-6, 1, 5);
    const rim = new THREE.DirectionalLight(0xffd8c8, 1.0); rim.position.set(-3, 4, -6);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0xaab0bd, 1.0));

    this.heart = new THREE.Group();   // rotação + pulsação
    this.inner = new THREE.Group();   // modelo centralizado
    this.heart.add(this.inner);
    this.scene.add(this.heart);
  }

  _loadModel() {
    new GLTFLoader().load(MODEL_URL, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      this.inner.scale.setScalar(3.7 / maxDim);

      this.mats = [];
      model.traverse((o) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m.emissive) m.emissive = new THREE.Color(0x000000);
            m.emissiveIntensity = 0;
            this.mats.push(m);
          }
        }
      });
      this.inner.add(model);
      this.model = model;
      this._buildOverlays();
      this.loaded = true;
      this._applyStructures(this.animation.structures || {});
    }, undefined, (err) => console.error('Falha ao carregar o modelo do coração:', err));
  }

  // Rótulos de região (ancorados em posições anatômicas aproximadas) + via de condução.
  _buildOverlays() {
    const anchors = {
      'Aorta': [0.15, 1.55, 0.0],
      'Átrio dir.': [0.95, 0.65, 0.1],
      'Átrio esq.': [-0.85, 0.65, -0.2],
      'Ventrículo dir.': [0.7, -0.7, 0.45],
      'Ventrículo esq.': [-0.7, -0.8, 0.35],
      'Nó SA': [0.9, 0.95, 0.2],
      'Nó AV': [0.2, 0.15, 0.55],
    };
    for (const [name, pos] of Object.entries(anchors)) {
      const spr = makeLabel(name); spr.visible = false;
      this.inner.add(spr);
      this.labels.push({ sprite: spr, anchor: new THREE.Vector3(...pos) });
    }

    // Via de condução ao longo da face anterior do septo.
    this.pathPoints = [
      new THREE.Vector3(0.95, 0.9, 0.25),
      new THREE.Vector3(0.25, 0.2, 0.55),
      new THREE.Vector3(0.05, -0.25, 0.6),
      new THREE.Vector3(-0.15, -0.95, 0.45),
      new THREE.Vector3(-0.08, -1.5, 0.3),
    ];
    this.spark = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
    this.spark.visible = false;
    this.inner.add(this.spark);

    // --- Zona de infarto: marca o LOCAL AFETADO na parede anterior do VE ---
    // (território da artéria descendente anterior). Anel + mancha + rótulo fixo.
    this.infarct = new THREE.Group();
    this.infarct.position.set(-0.28, -0.42, 1.15); // parede anterior do VE (ântero-lateral)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.36, 0.05, 14, 40),
      new THREE.MeshBasicMaterial({ color: 0xff2a1e, transparent: true, opacity: 0.9 })
    );
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 40),
      new THREE.MeshBasicMaterial({ color: 0xd11f12, transparent: true, opacity: 0.32, depthWrite: false })
    );
    patch.position.z = -0.01;
    this.infarct.add(patch, ring);
    this.infarct.visible = false;
    this.inner.add(this.infarct);

    // Rótulo do local afetado (sempre visível quando há isquemia).
    this.infarctLabel = makeLabel('⚠ Infarto · parede anterior (VE)');
    this.infarctLabel.visible = false;
    this.infarctLabel.position.set(-0.05, 0.55, 1.2);
    this.inner.add(this.infarctLabel);
  }

  setBeats(beats, duration, animation) {
    this.beats = beats || [];
    this.duration = duration || 10;
    if (animation) this.animation = animation;
    this._applyStructures(this.animation.structures || {});
  }

  setLabels(on) { this.showLabels = on; for (const l of this.labels) l.sprite.visible = on; }

  _applyStructures(st) {
    this._struct = st || {};
    const isch = this._struct.lv_wall === 'ischemic';
    if (this.infarct) this.infarct.visible = isch;
    if (this.infarctLabel) this.infarctLabel.visible = isch;
  }

  _activation(t) {
    let atrial = 0, ventric = 0, nearestQ = null, phase = 0;
    for (const b of this.beats) {
      const pT = (b.p !== null && b.p !== undefined) ? b.p : (b.qrs - 0.16);
      atrial = Math.max(atrial, pulse(t, pT, 0.05));
      ventric = Math.max(ventric, pulse(t, b.qrs, 0.045));
      const start = pT - 0.02, end = b.qrs + 0.05;
      if (t >= start && t <= end) { phase = (t - start) / (end - start); nearestQ = b.qrs; }
    }
    return { atrial, ventric, sparkPhase: nearestQ !== null ? phase : null };
  }

  _sparkPos(phase) {
    const seg = phase * (this.pathPoints.length - 1);
    const i = Math.min(this.pathPoints.length - 2, Math.floor(seg));
    return this.pathPoints[i].clone().lerp(this.pathPoints[i + 1], seg - i);
  }

  update(t) {
    this.controls.update();
    if (!this.loaded) return;
    const { atrial, ventric, sparkPhase } = this._activation(t);
    const st = this._struct || {};

    // Sístole ventricular: leve compressão do coração; bloqueio de ramo atrasa o VE.
    const lvDelay = st.bundle === 'block_left' ? 0.05 : 0;
    const lvAct = this._activation(t - lvDelay).ventric;
    this.heart.scale.setScalar(1 - 0.05 * ventric);

    // "Flush" emissivo do miocárdio a cada batimento; o comportamento muda por condição.
    let intensity = 0.04 + 0.20 * ventric + 0.04 * atrial;
    let color = FLUSH;
    if (st.lv_wall === 'ischemic') {
      // isquemia: pulsação avermelhada sustentada de sofrimento.
      intensity = Math.max(intensity, 0.12 + 0.10 * (0.5 + 0.5 * Math.sin(t * 3.2)));
      color = ISCHEMIC;
    } else if (st.atria === 'fibrillating') {
      // fibrilação: tremor rápido e irregular sobreposto.
      intensity += 0.07 * (0.5 + 0.5 * Math.sin(t * 38)) * (0.5 + 0.5 * Math.sin(t * 23.3));
    }
    for (const m of this.mats) { m.emissive.copy(color); m.emissiveIntensity = intensity; }

    // Marcador percorrendo a via de condução.
    if (sparkPhase !== null) { this.spark.visible = true; this.spark.position.copy(this._sparkPos(sparkPhase)); }
    else this.spark.visible = false;

    // Zona de infarto pulsa (chama a atenção para o local afetado).
    if (this.infarct && this.infarct.visible) {
      const p = 0.5 + 0.5 * Math.sin(t * 3.4);
      this.infarct.children[1].material.opacity = 0.55 + 0.45 * p; // anel
      this.infarct.children[0].material.opacity = 0.22 + 0.20 * p; // mancha
      const s = 1 + 0.07 * p;
      this.infarct.scale.set(s, s, s);
    }

    this.heart.rotation.y = Math.sin(t * 0.3) * 0.12;

    if (this.showLabels) {
      for (const l of this.labels) {
        const dir = l.anchor.clone().setLength(1);
        l.sprite.position.copy(l.anchor).add(dir.multiplyScalar(0.5));
      }
    }
  }

  start(getTime) {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.update(getTime());
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  _onResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
