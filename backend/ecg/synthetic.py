"""Geração de ECG sintético fisiologicamente plausível.

Usado para:
  * modo demonstração (o usuário pode ver o coração 3D sem enviar arquivo);
  * fallback quando a digitalização de uma foto/PDF tem baixa confiança.

O modelo soma ondas gaussianas (P, Q, R, S, T) posicionadas dentro de cada
ciclo cardíaco. Suporta variações de ritmo para demonstrar como o coração 3D
reage a cada padrão.
"""

from __future__ import annotations

import numpy as np


# Morfologia de cada onda dentro de um batimento, em segundos relativos ao pico R.
# (deslocamento_s, amplitude_mV, largura_s)
_WAVES = {
    "P": (-0.20, 0.15, 0.025),
    "Q": (-0.035, -0.10, 0.012),
    "R": (0.0, 1.10, 0.020),
    "S": (0.035, -0.25, 0.012),
    "T": (0.22, 0.32, 0.05),
}


def _beat(t: np.ndarray, r_time: float, morph: dict, scale: float = 1.0) -> np.ndarray:
    """Retorna a contribuição de um único batimento centrado em ``r_time``."""
    sig = np.zeros_like(t)
    for offset, amp, width in morph.values():
        sig += (amp * scale) * np.exp(-((t - (r_time + offset)) ** 2) / (2 * width ** 2))
    return sig


def generate(
    rhythm: str = "sinus",
    heart_rate: float = 72.0,
    duration: float = 10.0,
    fs: int = 250,
    seed: int = 7,
) -> dict:
    """Gera um traçado de ECG sintético.

    Parameters
    ----------
    rhythm: um de ``sinus``, ``bradycardia``, ``tachycardia``,
            ``afib`` (fibrilação atrial), ``pvc`` (extrassístoles) ou
            ``st_elevation``.
    heart_rate: frequência média em bpm.
    duration: duração em segundos.
    fs: frequência de amostragem (Hz).

    Returns
    -------
    dict com ``signal`` (lista mV), ``fs``, ``duration`` e ``source``.
    """
    rng = np.random.default_rng(seed)
    t = np.arange(0, duration, 1.0 / fs)
    signal = np.zeros_like(t)

    base_rr = 60.0 / max(30.0, min(220.0, heart_rate))

    # Constrói a sequência de tempos R conforme o ritmo.
    r_times = []
    morphs = []
    tcur = 0.4
    while tcur < duration - 0.4:
        rr = base_rr
        morph = {k: list(v) for k, v in _WAVES.items()}
        scale = 1.0
        # QT encurta com frequências mais altas: escala a posição/largura da onda T.
        qt_scale = float(np.clip((base_rr / 0.85) ** 0.5, 0.6, 1.25))
        morph["T"][0] *= qt_scale
        morph["T"][2] *= qt_scale

        if rhythm == "afib":
            # RR irregularmente irregular + ausência de onda P.
            rr = base_rr * rng.uniform(0.62, 1.45)
            morph["P"][1] = 0.0  # sem onda P organizada
        elif rhythm == "pvc":
            # A cada ~4 batimentos, um complexo ventricular prematuro largo.
            if len(r_times) > 0 and len(r_times) % 4 == 3:
                rr = base_rr * 0.62
                morph["P"][1] = 0.0
                morph["R"][1] = 1.5
                morph["R"][2] = 0.05  # QRS alargado
                morph["S"][1] = -0.6
                morph["T"][1] = -0.45  # onda T discordante
        elif rhythm == "st_elevation":
            morph["T"][0] = 0.24
            morph["T"][1] = 0.45
            # segmento ST elevado: platô positivo largo logo após o QRS (ponto J).
            morph["ST_extra"] = [0.085, 0.28, 0.06]

        r_times.append(tcur)
        morphs.append(morph)
        # pequena variabilidade fisiológica normal
        jitter = rng.normal(0, 0.012) if rhythm in ("sinus", "st_elevation") else 0.0
        tcur += rr + jitter

    for rt, morph in zip(r_times, morphs):
        signal += _beat(t, rt, morph)

    # Ruído basal + deriva da linha de base para realismo.
    signal += rng.normal(0, 0.012, size=t.shape)
    signal += 0.03 * np.sin(2 * np.pi * 0.25 * t)

    return {
        "signal": signal.astype(float).tolist(),
        "fs": fs,
        "duration": float(duration),
        "source": f"synthetic:{rhythm}",
        "n_samples": int(t.size),
    }
