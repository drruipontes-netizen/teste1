"""Digitalização de ECG a partir de foto ou PDF.

Pipeline:
  1. Carregar bytes -> imagem em escala de cinza (PDF renderizado com PyMuPDF).
  2. Remover a grade rosa/vermelha do papel milimetrado usando informação de cor.
  3. Estimar a escala da grade (px por milímetro) para calibrar tempo e amplitude.
  4. Selecionar a faixa horizontal com maior atividade (a tira de ritmo) e
     rastrear o traçado coluna a coluna -> sinal 1-D em mV.

A digitalização de ECG de papel é intrinsecamente aproximada; cada etapa
devolve uma medida de confiança e o sistema recorre ao ECG sintético quando
a confiança é baixa, de modo que o coração 3D sempre tem um sinal para animar.
"""

from __future__ import annotations

import io
from typing import Optional

import cv2
import numpy as np

# Padrões de calibração do ECG clínico.
DEFAULT_MM_PER_S = 25.0   # velocidade do papel: 25 mm/s
DEFAULT_MM_PER_MV = 10.0  # ganho padrão: 10 mm/mV


def load_grayscale(data: bytes, filename: str = "") -> np.ndarray:
    """Converte bytes de imagem ou PDF em BGR uint8 (para análise de cor)."""
    name = (filename or "").lower()
    is_pdf = name.endswith(".pdf") or data[:5] == b"%PDF-"
    if is_pdf:
        import fitz  # PyMuPDF

        doc = fitz.open(stream=data, filetype="pdf")
        page = doc.load_page(0)
        # Renderiza a ~200 DPI para resolver a grade fina.
        pix = page.get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72))
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
        if pix.n == 4:
            img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        elif pix.n == 1:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        else:
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        doc.close()
        return img

    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Não foi possível decodificar o arquivo como imagem ou PDF.")
    return img


def _isolate_trace(bgr: np.ndarray) -> np.ndarray:
    """Retorna máscara binária (255 = tinta do traçado) removendo a grade.

    O papel de ECG tem grade vermelha/rosa e traçado preto. Realçamos pixels
    escuros e neutros (baixa saturação vermelha) para manter apenas a curva.
    """
    b, g, r = cv2.split(bgr.astype(np.int16))
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    # "Vermelhidão": grade tem r >> g,b. Traçado preto tem r≈g≈b e é escuro.
    redness = r - np.maximum(g, b)
    is_grid = redness > 25
    is_dark = gray < 110

    mask = np.where(is_dark & ~is_grid, 255, 0).astype(np.uint8)

    # Limpeza morfológica: conecta o traçado, remove pontos de grade residuais.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    return mask


def estimate_grid_px_per_mm(bgr: np.ndarray) -> tuple[float, float]:
    """Estima px/mm via autocorrelação do padrão de grade vertical.

    Retorna (px_por_mm, confiança 0..1). Recorre a heurística por DPI se falhar.
    """
    b, g, r = cv2.split(bgr.astype(np.int16))
    grid = ((r - np.maximum(g, b)) > 20).astype(np.float32)
    if grid.sum() < grid.size * 0.002:
        # Poucos pixels de grade -> estimativa por tamanho (assume ~200 DPI).
        return 200.0 / 25.4, 0.2

    # Projeção de colunas -> picos periódicos = linhas verticais da grade.
    col = grid.sum(axis=0)
    col = col - col.mean()
    ac = np.correlate(col, col, mode="full")[col.size - 1:]
    ac[0] = 0
    max_lag = min(80, ac.size - 1)
    search = ac[1:max_lag]
    if search.size == 0 or search.max() <= 0:
        return 200.0 / 25.4, 0.2

    # A grade de 1 mm é a periodicidade FUNDAMENTAL -> primeiro pico prominente
    # da autocorrelação. Máximos globais podem cair em harmônicos (2 mm, 5 mm),
    # o que dobraria/quintuplicaria a escala de tempo; por isso pegamos o
    # primeiro pico relevante, não o mais alto.
    from scipy.signal import find_peaks

    peaks, props = find_peaks(search, prominence=search.max() * 0.15, distance=2)
    if peaks.size == 0:
        return 200.0 / 25.4, 0.25
    # menor lag entre os picos cuja altura seja pelo menos 35% do pico máximo.
    strong = [p for p in peaks if search[p] >= 0.35 * search.max()]
    lag = int((strong[0] if strong else peaks[0]) + 1)
    px_per_mm = float(lag)
    conf = float(min(1.0, search[lag - 1] / (np.abs(search).mean() * 6 + 1e-6)))

    # Sanidade: px/mm plausível entre 3 e 40.
    if not (3.0 <= px_per_mm <= 40.0):
        return 200.0 / 25.4, 0.25
    return px_per_mm, max(0.2, min(1.0, conf))


def _select_strip(mask: np.ndarray) -> tuple[int, int]:
    """Escolhe a banda de linhas com maior densidade de traçado (tira de ritmo)."""
    row_density = mask.sum(axis=1).astype(np.float32)
    h = mask.shape[0]
    band = max(20, h // 8)
    # Média deslizante para achar a banda mais densa.
    kernel = np.ones(band, dtype=np.float32) / band
    smooth = np.convolve(row_density, kernel, mode="same")
    center = int(np.argmax(smooth))
    top = max(0, center - band)
    bottom = min(h, center + band)
    return top, bottom


def _trace_signal(mask: np.ndarray, top: int, bottom: int) -> tuple[np.ndarray, float]:
    """Rastreia o traçado coluna a coluna dentro da banda -> sinal em px.

    Retorna (sinal_px invertido para cima=positivo, cobertura de colunas 0..1).
    """
    band = mask[top:bottom, :]
    h, w = band.shape
    ys = np.full(w, np.nan, dtype=np.float32)
    for x in range(w):
        rows = np.where(band[:, x] > 0)[0]
        if rows.size:
            ys[x] = float(rows.mean())

    covered = float(np.isfinite(ys).mean())
    # Interpola lacunas.
    idx = np.arange(w)
    good = np.isfinite(ys)
    if good.sum() < 10:
        return np.zeros(w, dtype=np.float32), 0.0
    ys = np.interp(idx, idx[good], ys[good])
    # Coordenada de imagem cresce para baixo; ECG positivo é para cima.
    baseline = np.median(ys)
    sig = -(ys - baseline)
    return sig.astype(np.float32), covered


def digitize(data: bytes, filename: str = "") -> dict:
    """Digitaliza um ECG de foto/PDF em um sinal calibrado.

    Returns
    -------
    dict com ``signal`` (mV), ``fs`` (Hz), ``duration``, ``confidence`` (0..1),
    ``source`` e ``notes``.
    """
    notes: list[str] = []
    bgr = load_grayscale(data, filename)
    h, w = bgr.shape[:2]

    # Redimensiona imagens muito grandes para acelerar mantendo a resolução da grade.
    if w > 2600:
        scale = 2600.0 / w
        bgr = cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        h, w = bgr.shape[:2]

    px_per_mm, grid_conf = estimate_grid_px_per_mm(bgr)
    mask = _isolate_trace(bgr)
    ink_frac = float(mask.mean() / 255.0)

    top, bottom = _select_strip(mask)
    sig_px, covered = _trace_signal(mask, top, bottom)

    # Calibração: px -> mV e px de coluna -> segundos.
    px_per_s = px_per_mm * DEFAULT_MM_PER_S
    signal_mv = sig_px / (px_per_mm * DEFAULT_MM_PER_MV)
    duration = w / px_per_s
    fs = float(px_per_s)  # uma amostra por coluna de pixel

    # Reamostra para uma frequência de amostragem estável de 250 Hz.
    target_fs = 250.0
    n_target = max(4, int(duration * target_fs))
    if n_target > 4 and np.isfinite(signal_mv).all():
        xp = np.linspace(0, duration, num=signal_mv.size)
        xnew = np.linspace(0, duration, num=n_target)
        signal_mv = np.interp(xnew, xp, signal_mv)
        fs = target_fs

    # Confiança combinada da digitalização.
    confidence = float(np.clip(0.45 * grid_conf + 0.35 * covered + 0.20 * min(1.0, ink_frac * 40), 0, 1))

    if covered < 0.35:
        notes.append("Cobertura baixa do traçado — imagem pode estar cortada ou com pouco contraste.")
    if grid_conf < 0.3:
        notes.append("Grade não detectada com clareza — calibração de tempo/amplitude aproximada.")
    if duration < 1.5 or duration > 60:
        notes.append("Duração estimada fora do usual — verifique o recorte da tira de ritmo.")

    return {
        "signal": np.asarray(signal_mv, dtype=float).tolist(),
        "fs": float(fs),
        "duration": float(signal_mv.size / fs),
        "confidence": confidence,
        "source": "pdf" if (filename.lower().endswith(".pdf") or data[:5] == b"%PDF-") else "image",
        "px_per_mm": float(px_per_mm),
        "notes": notes,
    }
