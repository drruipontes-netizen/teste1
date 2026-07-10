"""Testes do pipeline de ECG: geração -> (imagem) -> digitalização -> análise -> laudo.

Executar:
    cd backend && python -m pytest tests/ -v
ou sem pytest:
    cd backend && python tests/test_pipeline.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ecg import analyze, extract, interpret, synthetic  # noqa: E402


def test_synthetic_sinus_is_normal():
    s = synthetic.generate(rhythm="sinus", heart_rate=72, duration=8)
    a = analyze.analyze(s["signal"], s["fs"], confidence=1.0)
    assert a["ok"], a.get("reason")
    assert 66 <= a["heart_rate"]["mean"] <= 78, a["heart_rate"]
    assert "sinusal" in interpret.interpret(a)["ritmo"].lower()


def test_bradycardia_detected():
    s = synthetic.generate(rhythm="bradycardia", heart_rate=46, duration=10)
    a = analyze.analyze(s["signal"], s["fs"], confidence=1.0)
    assert a["ok"]
    assert a["heart_rate"]["mean"] < 60
    titles = [f["titulo"] for f in interpret.interpret(a)["achados"]]
    assert any("Bradicardia" in t for t in titles)


def test_afib_flagged_as_irregular():
    s = synthetic.generate(rhythm="afib", heart_rate=95, duration=12)
    a = analyze.analyze(s["signal"], s["fs"], confidence=1.0)
    it = interpret.interpret(a)
    assert a["variability"]["irregularity"] > 0.12
    assert "atrial" in it["ritmo"].lower() or "irregular" in it["ritmo"].lower()


def test_st_elevation_flagged():
    s = synthetic.generate(rhythm="st_elevation", heart_rate=82, duration=10)
    a = analyze.analyze(s["signal"], s["fs"], confidence=1.0)
    assert a["morphology"]["st_level_mv"] > 0.1
    titles = [f["titulo"] for f in interpret.interpret(a)["achados"]]
    assert any("ST" in t for t in titles)


def _render_ecg_image(signal, fs, px_per_mm=6):
    """Rasteriza um sinal em uma imagem de papel milimetrado (para round-trip)."""
    import cv2

    sig = np.asarray(signal)
    mm_s, mm_mv = 25, 10
    w = int(len(sig) / fs * mm_s * px_per_mm)
    h = 300
    img = np.full((h, w, 3), 255, np.uint8)
    for x in range(0, w, px_per_mm):
        c = (150, 150, 255) if (x // px_per_mm) % 5 else (90, 90, 255)
        cv2.line(img, (x, 0), (x, h), c, 1)
    for y in range(0, h, px_per_mm):
        c = (150, 150, 255) if (y // px_per_mm) % 5 else (90, 90, 255)
        cv2.line(img, (0, y), (w, y), c, 1)
    base = h // 2
    xs = np.linspace(0, w - 1, len(sig)).astype(int)
    ys = (base - sig * mm_mv * px_per_mm).astype(int)
    for i in range(1, len(xs)):
        cv2.line(img, (xs[i - 1], ys[i - 1]), (xs[i], ys[i]), (0, 0, 0), 2)
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def test_image_roundtrip_recovers_heart_rate():
    """Renderiza um ECG sinusal como imagem e verifica que a FC é recuperada."""
    s = synthetic.generate(rhythm="sinus", heart_rate=75, duration=6)
    png = _render_ecg_image(s["signal"], s["fs"])
    dig = extract.digitize(png, "roundtrip.png")
    assert dig["confidence"] > 0.4, dig
    a = analyze.analyze(dig["signal"], dig["fs"], dig["confidence"])
    assert a["ok"]
    # Tolerância de ~15% no round-trip de digitalização.
    assert abs(a["heart_rate"]["mean"] - 75) < 12, a["heart_rate"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"ERROR {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} testes passaram.")
    sys.exit(1 if failed else 0)
