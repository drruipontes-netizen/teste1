// Molde cardíaco 3D animado, sincronizado ao ritmo do ECG.
//
// Constrói um coração anatomicamente sugestivo (4 câmaras + grandes vasos +
// sistema de condução) a partir de geometria procedural — sem depender de
// arquivos de modelo externos. A cada batimento:
//   * a onda P dispara a contração atrial (sístole atrial);
//   * o complexo QRS dispara a contração ventricular (sístole ventricular);
//   * um marcador percorre a via de condução (nó SA -> nó AV -> His -> Purkinje).
//
// A cor e a intensidade das câmaras reagem à ativação elétrica, dando a
// sensação de um coração "vivo" que bate no tempo do traçado.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const RED_MYO = 0x8c1c1c;      // miocárdio em repouso
const RED_ATRIA = 0xb5433a;    // átrios
const HILITE = 0xff5a4d;       // realce de ativação

// Suaviza um pulso de ativação (envelope tipo sino) centrado em t0.
function pulse(t, t0, width) {
  if (t0 === null || t0 === undefined) return 0;
  const d = (t - t0) / width;
  return Math.exp(-d * d);
}

// Cria um elipsoide (esfera escalada) que serve de câmara cardíaca.
function chamber(rx, ry, rz, color, opacity = 0.92) {
  const geo = new THREE.SphereGeometry(1, 48, 32);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
    transparent: true,
    opacity,
    emissive: new THREE.Color(color).multiplyScalar(0.15),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(rx, ry, rz);
  mesh.castShadow = true;
  return mesh;
}

function vessel(radiusTop, radiusBottom, height, color) {
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 24, 1, true);
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
    transparent: true, opacity: 0.9,
  });
  return new THREE.Mesh(geo, mat);
}

export class HeartModel {
  constructor(container) {
    this.container = container;
    this.beats = [];
    this.duration = 10;
    this.animation = { rhythm: 'sinus', highlight_atria: true };
    this._initScene();
    this._buildHeart();
    this._raf = null;
    window.addEventListener('resize', () => this._onResize());
  }

  _initScene() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = null; // transparente sobre o gradiente CSS

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.camera.position.set(0, 0.6, 7.2);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 14;
    this.controls.target.set(0, 0, 0);

    // Iluminação: key + fill + rim para volume anatômico.
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(4, 6, 6);
    key.castShadow = true;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
    fill.position.set(-6, 2, 3);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xff8866, 0.7);
    rim.position.set(0, -3, -6);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x404050, 1.1));
  }

  _buildHeart() {
    this.heart = new THREE.Group();
    this.heart.rotation.z = -0.18; // inclinação anatômica
    this.scene.add(this.heart);

    // --- Ventrículos (parte inferior, maiores) ---
    this.lv = chamber(1.15, 1.5, 1.15, RED_MYO);       // ventrículo esquerdo
    this.lv.position.set(-0.45, -0.7, 0);
    this.rv = chamber(0.95, 1.25, 1.05, 0x7a1f1f, 0.9); // ventrículo direito
    this.rv.position.set(0.7, -0.55, 0.35);

    // --- Átrios (parte superior, menores) ---
    this.la = chamber(0.72, 0.62, 0.72, RED_ATRIA, 0.9); // átrio esquerdo
    this.la.position.set(-0.5, 0.95, -0.1);
    this.ra = chamber(0.7, 0.6, 0.72, RED_ATRIA, 0.9);   // átrio direito
    this.ra.position.set(0.75, 0.95, 0.3);

    for (const c of [this.lv, this.rv, this.la, this.ra]) this.heart.add(c);
    // Guarda escalas de repouso para animar a contração.
    for (const c of [this.lv, this.rv, this.la, this.ra]) c.userData.rest = c.scale.clone();

    // --- Grandes vasos ---
    const aorta = vessel(0.28, 0.32, 1.7, 0xb04b4b);
    aorta.position.set(-0.1, 1.7, -0.1);
    aorta.rotation.z = 0.15;
    const pulm = vessel(0.26, 0.3, 1.5, 0x5b6fb0);
    pulm.position.set(0.5, 1.75, 0.25);
    pulm.rotation.z = -0.2;
    const svc = vessel(0.2, 0.22, 1.1, 0x5b6fb0);
    svc.position.set(1.05, 1.7, 0.3);
    this.heart.add(aorta, pulm, svc);

    // --- Sistema de condução (nós + feixes) ---
    this.conduction = new THREE.Group();
    this.heart.add(this.conduction);

    const nodeMat = () => new THREE.MeshStandardMaterial({
      color: 0xffe08a, emissive: 0x332200, roughness: 0.4,
    });
    const nodeGeo = new THREE.SphereGeometry(0.12, 16, 16);

    // Caminho elétrico: SA (átrio D alto) -> AV -> His -> ramos -> ápice.
    this.pathPoints = [
      new THREE.Vector3(0.9, 1.25, 0.4),   // nó sinoatrial (SA)
      new THREE.Vector3(0.35, 0.35, 0.2),  // nó atrioventricular (AV)
      new THREE.Vector3(0.1, -0.1, 0.1),   // feixe de His
      new THREE.Vector3(-0.2, -1.0, 0.05), // ramo esquerdo
      new THREE.Vector3(-0.45, -2.0, 0),   // ápice / Purkinje
    ];
    this.saNode = new THREE.Mesh(nodeGeo, nodeMat());
    this.saNode.position.copy(this.pathPoints[0]);
    this.avNode = new THREE.Mesh(nodeGeo, nodeMat());
    this.avNode.position.copy(this.pathPoints[1]);
    this.conduction.add(this.saNode, this.avNode);

    // Linha da via de His-Purkinje.
    const pathGeo = new THREE.BufferGeometry().setFromPoints(this.pathPoints);
    this.pathLine = new THREE.Line(
      pathGeo,
      new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.55 })
    );
    this.conduction.add(this.pathLine);

    // Marcador que percorre a via de condução a cada batimento.
    this.spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff2b0 })
    );
    this.conduction.add(this.spark);
    this.spark.visible = false;

    // Halo de brilho para o pico de sístole ventricular.
    this.glow = new THREE.PointLight(HILITE, 0, 6);
    this.glow.position.set(-0.3, -0.6, 0.5);
    this.heart.add(this.glow);
  }

  setBeats(beats, duration, animation) {
    this.beats = beats || [];
    this.duration = duration || 10;
    if (animation) this.animation = animation;
  }

  // Encontra o batimento cujos eventos estão mais próximos do tempo atual.
  _activation(t) {
    let atrial = 0, ventric = 0, nearestQ = null, phase = 0;
    for (const b of this.beats) {
      const pT = b.p !== null && b.p !== undefined ? b.p : (b.qrs - 0.16);
      atrial = Math.max(atrial, pulse(t, pT, 0.05));
      ventric = Math.max(ventric, pulse(t, b.qrs, 0.045));
      // Fase da faísca de condução: começa em P/pré-QRS, termina no QRS.
      const start = pT - 0.02;
      const end = b.qrs + 0.04;
      if (t >= start && t <= end) {
        phase = (t - start) / (end - start);
        nearestQ = b.qrs;
      }
    }
    return { atrial, ventric, sparkPhase: nearestQ !== null ? phase : null };
  }

  // Interpola a posição do marcador ao longo da via de condução (0..1).
  _sparkPos(phase) {
    const seg = phase * (this.pathPoints.length - 1);
    const i = Math.min(this.pathPoints.length - 2, Math.floor(seg));
    const f = seg - i;
    return this.pathPoints[i].clone().lerp(this.pathPoints[i + 1], f);
  }

  update(t) {
    const { atrial, ventric, sparkPhase } = this._activation(t);

    // Contração: câmara encolhe proporcional à ativação (sístole).
    const applyContraction = (mesh, amount, maxShrink) => {
      const s = mesh.userData.rest;
      const k = 1 - maxShrink * amount;
      mesh.scale.set(s.x * k, s.y * k, s.z * k);
      const em = 0.15 + 0.85 * amount;
      mesh.material.emissive.setHex(HILITE).multiplyScalar(em * 0.5);
    };
    applyContraction(this.la, atrial, 0.16);
    applyContraction(this.ra, atrial, 0.16);
    applyContraction(this.lv, ventric, 0.2);
    applyContraction(this.rv, ventric, 0.2);

    // Nós brilham conforme a onda elétrica passa.
    this.saNode.material.emissive.setHex(0x332200).addScalar(atrial * 0.6);
    this.avNode.material.emissive.setHex(0x332200).addScalar(ventric * 0.6);

    // Marcador de condução.
    if (sparkPhase !== null) {
      this.spark.visible = true;
      this.spark.position.copy(this._sparkPos(sparkPhase));
    } else {
      this.spark.visible = false;
    }

    // Halo de brilho pulsa com a sístole ventricular.
    this.glow.intensity = ventric * 3.2;

    // Leve balanço do coração para dar vida.
    this.heart.rotation.y = Math.sin(t * 0.4) * 0.12;
  }

  start(getTime) {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const t = getTime();
      this.update(t);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
