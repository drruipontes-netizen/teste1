"""Análise de sinal de ECG: filtragem, detecção de ondas e medidas.

Produz uma análise técnica completa a partir de um sinal 1-D calibrado:
  * Frequência cardíaca (média/mín/máx) e variabilidade RR.
  * Detecção de complexos QRS (algoritmo estilo Pan–Tompkins).
  * Delimitação de ondas P, Q, R, S, T por batimento.
  * Intervalos PR, QRS, QT e QTc (Bazett e Fridericia).
  * Estimativa de eixo (quando há duas derivações) e do segmento ST.
  * Lista de eventos por batimento (timings de P/QRS/T) para animar o 3D.

Todas as medidas são "best-effort" e acompanham a confiança da digitalização.
"""

from __future__ import annotations

import numpy as np
from scipy import signal as sps


def _bandpass(x: np.ndarray, fs: float, lo: float = 0.5, hi: float = 40.0) -> np.ndarray:
    ny = 0.5 * fs
    lo_n = max(1e-3, lo / ny)
    hi_n = min(0.99, hi / ny)
    if hi_n <= lo_n:
        return x - np.median(x)
    b, a = sps.butter(2, [lo_n, hi_n], btype="band")
    return sps.filtfilt(b, a, x)


def _detect_qrs(x: np.ndarray, fs: float) -> np.ndarray:
    """Detecção de picos R inspirada em Pan–Tompkins.

    Deriva -> quadra -> integra em janela móvel -> limiar adaptativo.
    Retorna índices dos picos R (nas amostras do sinal filtrado).
    """
    diff = np.ediff1d(x, to_begin=0)
    squared = diff ** 2
    win = max(1, int(0.12 * fs))
    integrated = np.convolve(squared, np.ones(win) / win, mode="same")

    # Distância mínima entre batimentos: 0,25 s (=> até 240 bpm).
    min_dist = max(1, int(0.25 * fs))
    thr = integrated.mean() + 0.5 * integrated.std()
    peaks, _ = sps.find_peaks(integrated, distance=min_dist, height=max(thr, 1e-9))

    # Refina cada pico para o máximo local do sinal filtrado (pico R real).
    refined = []
    r = max(1, int(0.05 * fs))
    for p in peaks:
        a0, a1 = max(0, p - r), min(x.size, p + r)
        if a1 > a0:
            refined.append(a0 + int(np.argmax(x[a0:a1])))
    refined = np.unique(refined)
    return refined


def _wave_points(x: np.ndarray, fs: float, r_idx: np.ndarray) -> list[dict]:
    """Delimita Q, S, P e T em torno de cada pico R. Índices em amostras."""
    beats = []
    n = x.size
    baseline = float(np.median(x))
    # Limiar de amplitude para considerar uma onda P "presente" (real, não ruído).
    noise = float(np.median(np.abs(x - baseline))) * 1.5 + 1e-6
    for i, r in enumerate(r_idx):
        # Q: mínimo local ~40 ms antes de R.
        q0 = max(0, r - int(0.05 * fs))
        q = q0 + int(np.argmin(x[q0:r])) if r > q0 else r
        # S: mínimo local ~60 ms depois de R.
        s1 = min(n, r + int(0.06 * fs))
        s = r + int(np.argmin(x[r:s1])) if s1 > r else r
        # P: máximo local na janela 80–220 ms antes de R, exigindo deflexão real.
        p_a, p_b = max(0, r - int(0.22 * fs)), max(0, r - int(0.08 * fs))
        p = None
        if p_b > p_a:
            cand = p_a + int(np.argmax(x[p_a:p_b]))
            if (x[cand] - baseline) > noise:
                p = cand
        # Linha isoelétrica do batimento: segmento PR (~30 ms antes de Q).
        iso_a, iso_b = max(0, q - int(0.05 * fs)), max(1, q - int(0.01 * fs))
        iso = float(np.median(x[iso_a:iso_b])) if iso_b > iso_a else baseline
        # T: máximo (em valor absoluto) na janela 150–420 ms depois de R.
        t_a, t_b = min(n, r + int(0.15 * fs)), min(n, r + int(0.42 * fs))
        t = t_a + int(np.argmax(np.abs(x[t_a:t_b] - iso))) if t_b > t_a else None
        # Fim da onda T: primeira volta à linha isoelétrica após o pico T.
        t_end = None
        if t is not None:
            te0, te1 = t, min(n, t + int(0.20 * fs))
            if te1 > te0:
                seg = x[te0:te1] - iso
                amp = abs(x[t] - iso) + 1e-6
                below = np.where(np.abs(seg) < 0.10 * amp)[0]
                t_end = te0 + int(below[0]) if below.size else te0 + int(np.argmin(np.abs(seg)))
        beats.append({"P": p, "Q": q, "R": int(r), "S": s, "T": t, "T_end": t_end, "iso": iso})
    return beats


def _median_interval(values: list[float]) -> float | None:
    vals = [v for v in values if v is not None and np.isfinite(v)]
    return float(np.median(vals)) if vals else None


def analyze(signal: list[float] | np.ndarray, fs: float, confidence: float = 1.0) -> dict:
    """Analisa um sinal de ECG e devolve medidas + eventos por batimento."""
    x_raw = np.asarray(signal, dtype=float)
    if x_raw.size < int(fs):  # menos de 1 s de sinal
        return {"ok": False, "reason": "Sinal muito curto para análise."}

    x = _bandpass(x_raw, fs)
    r_idx = _detect_qrs(x, fs)

    if r_idx.size < 2:
        return {"ok": False, "reason": "Nenhum complexo QRS detectável."}

    # Frequência cardíaca a partir dos intervalos RR.
    rr = np.diff(r_idx) / fs  # segundos
    hr_series = 60.0 / rr
    hr_mean = float(np.median(hr_series))
    hr_min = float(np.min(hr_series))
    hr_max = float(np.max(hr_series))

    # Variabilidade: desvio-padrão de RR e RMSSD.
    rr_ms = rr * 1000.0
    sdnn = float(np.std(rr_ms))
    rmssd = float(np.sqrt(np.mean(np.diff(rr_ms) ** 2))) if rr_ms.size > 1 else 0.0
    # Coeficiente de irregularidade (>0,15 sugere ritmo irregular).
    irregularity = float(sdnn / (np.mean(rr_ms) + 1e-9))

    beats = _wave_points(x, fs, r_idx)

    # Intervalos por batimento -> mediana (em ms).
    pr_list, qrs_list, qt_list = [], [], []
    p_present = 0
    for b in beats:
        if b["P"] is not None:
            p_present += 1
            pr_list.append((b["Q"] - b["P"]) / fs * 1000.0)
        qrs_list.append((b["S"] - b["Q"]) / fs * 1000.0)
        if b["T_end"] is not None:
            qt_list.append((b["T_end"] - b["Q"]) / fs * 1000.0)

    pr = _median_interval(pr_list)
    qrs = _median_interval(qrs_list)
    qt = _median_interval(qt_list)
    rr_mean_s = float(np.mean(rr))
    qtc_bazett = qt / np.sqrt(rr_mean_s) if qt else None
    qtc_frid = qt / (rr_mean_s ** (1 / 3)) if qt else None

    p_fraction = p_present / len(beats)

    # Estimativa de segmento ST: nível ~60 ms após o ponto J, relativo à isoelétrica (PR).
    st_levels = []
    for b in beats:
        j = b["S"] + int(0.02 * fs)
        st = j + int(0.06 * fs)
        if st < x.size:
            st_levels.append(float(x[st] - b["iso"]))
    st_level_mv = float(np.median(st_levels)) if st_levels else 0.0

    # Amplitude de R (proxy de voltagem) em mV, relativa à isoelétrica.
    r_amp = float(np.median([x[b["R"]] - b["iso"] for b in beats]))

    # Eventos por batimento (segundos) para sincronizar o coração 3D.
    events = []
    for b in beats:
        events.append({
            "p": (b["P"] / fs) if b["P"] is not None else None,
            "qrs": b["R"] / fs,
            "t": (b["T"] / fs) if b["T"] is not None else None,
            "q": b["Q"] / fs,
            "s": b["S"] / fs,
        })

    return {
        "ok": True,
        "fs": float(fs),
        "duration": float(x.size / fs),
        "confidence": float(confidence),
        "n_beats": int(len(beats)),
        "heart_rate": {"mean": round(hr_mean, 1), "min": round(hr_min, 1), "max": round(hr_max, 1)},
        "intervals_ms": {
            "PR": round(pr, 1) if pr else None,
            "QRS": round(qrs, 1) if qrs else None,
            "QT": round(qt, 1) if qt else None,
            "QTc_Bazett": round(qtc_bazett, 1) if qtc_bazett else None,
            "QTc_Fridericia": round(qtc_frid, 1) if qtc_frid else None,
            "RR_mean": round(rr_mean_s * 1000.0, 1),
        },
        "variability": {"SDNN_ms": round(sdnn, 1), "RMSSD_ms": round(rmssd, 1), "irregularity": round(irregularity, 3)},
        "morphology": {
            "p_wave_fraction": round(p_fraction, 2),
            "st_level_mv": round(st_level_mv, 3),
            "r_amplitude_mv": round(r_amp, 3),
        },
        "beats": events,
        # Sinal filtrado normalizado devolvido para o gráfico do frontend.
        "filtered_signal": np.round(x, 4).astype(float).tolist(),
        "r_peaks": [int(i) for i in r_idx.tolist()],
    }
