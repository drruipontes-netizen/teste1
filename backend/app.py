"""API do Cardio3D — interpretação de ECG e molde cardíaco 3D em movimento.

Endpoints
---------
POST /api/analyze   : recebe foto/PDF do ECG -> digitaliza, analisa, interpreta.
GET  /api/demo      : gera um ECG sintético de demonstração (?rhythm=...).
GET  /api/health    : verificação de saúde.
GET  /              : serve o frontend estático.

Executar:
    uvicorn app:app --reload --port 8000
ou:
    python app.py
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from ecg import analyze as ecg_analyze
from ecg import extract as ecg_extract
from ecg import interpret as ecg_interpret
from ecg import synthetic as ecg_synthetic

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"

app = FastAPI(title="Cardio3D — Interpretação de ECG em Molde Cardíaco 3D", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Frequências cardíacas típicas por ritmo de demonstração.
_DEMO_HR = {
    "sinus": 72,
    "bradycardia": 47,
    "tachycardia": 118,
    "afib": 96,
    "pvc": 76,
    "st_elevation": 82,
}

# Tamanho máximo de upload aceito (20 MB).
_MAX_BYTES = 20 * 1024 * 1024


def _build_result(signal, fs, confidence, meta) -> dict:
    """Executa análise + interpretação e monta a resposta completa da API."""
    analysis = ecg_analyze.analyze(signal, fs, confidence=confidence)
    interpretation = ecg_interpret.interpret(analysis)

    # Sinal exibido no gráfico: usa o filtrado quando disponível.
    display_signal = analysis.get("filtered_signal") if analysis.get("ok") else list(signal)

    return {
        "meta": meta,
        "signal": {
            "samples": display_signal,
            "fs": analysis.get("fs", fs),
            "duration": analysis.get("duration"),
            "r_peaks": analysis.get("r_peaks", []),
        },
        "analysis": analysis,
        "interpretation": interpretation,
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "cardio3d", "version": app.version}


@app.get("/api/demo")
def demo(
    rhythm: str = Query("sinus", description="sinus|bradycardia|tachycardia|afib|pvc|st_elevation"),
    hr: float | None = Query(None, description="frequência cardíaca (bpm), opcional"),
    duration: float = Query(10.0, ge=3.0, le=30.0),
) -> JSONResponse:
    """Gera um ECG sintético e devolve a análise completa."""
    rhythm = rhythm if rhythm in _DEMO_HR else "sinus"
    heart_rate = hr if hr else _DEMO_HR[rhythm]
    syn = ecg_synthetic.generate(rhythm=rhythm, heart_rate=heart_rate, duration=duration)
    meta = {
        "mode": "demo",
        "rhythm_requested": rhythm,
        "source": syn["source"],
        "filename": f"demo_{rhythm}.synthetic",
        "confidence": 1.0,
    }
    result = _build_result(syn["signal"], syn["fs"], 1.0, meta)
    return JSONResponse(result)


@app.post("/api/analyze")
async def analyze_upload(file: UploadFile = File(...)) -> JSONResponse:
    """Recebe foto/PDF de um ECG, digitaliza e devolve a análise completa.

    Se a digitalização tiver confiança muito baixa, ainda devolve a melhor
    tentativa e sinaliza o problema em ``meta.warnings`` — o coração 3D continua
    animando com o sinal recuperado.
    """
    data = await file.read()
    if not data:
        return JSONResponse({"error": "Arquivo vazio."}, status_code=400)
    if len(data) > _MAX_BYTES:
        return JSONResponse({"error": "Arquivo excede 20 MB."}, status_code=413)

    warnings: list[str] = []
    try:
        dig = ecg_extract.digitize(data, file.filename or "")
    except Exception as exc:  # noqa: BLE001 — devolve erro amigável
        return JSONResponse(
            {"error": f"Falha ao processar o arquivo: {exc}"}, status_code=422
        )

    confidence = dig.get("confidence", 0.0)
    warnings.extend(dig.get("notes", []))

    # Fallback fisiológico se a digitalização falhar completamente.
    if confidence < 0.15 or len(dig.get("signal", [])) < int(dig.get("fs", 1) * 2):
        warnings.append(
            "Não foi possível recuperar o traçado da imagem com segurança; "
            "exibindo um ritmo sinusal de referência para o molde 3D."
        )
        syn = ecg_synthetic.generate(rhythm="sinus", heart_rate=72, duration=10)
        meta = {
            "mode": "fallback",
            "filename": file.filename,
            "source": "synthetic:sinus",
            "confidence": confidence,
            "warnings": warnings,
        }
        return JSONResponse(_build_result(syn["signal"], syn["fs"], confidence, meta))

    meta = {
        "mode": "upload",
        "filename": file.filename,
        "source": dig.get("source"),
        "confidence": confidence,
        "px_per_mm": dig.get("px_per_mm"),
        "warnings": warnings,
    }
    return JSONResponse(_build_result(dig["signal"], dig["fs"], confidence, meta))


# Servir o frontend estático (montado por último para não capturar /api/*).
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
