"""Interpretação clínica a partir das medidas de ECG.

Converte a saída de :func:`ecg.analyze.analyze` em:
  * classificação de ritmo;
  * lista de achados com severidade (info / atenção / crítico);
  * impressão diagnóstica em texto (português);
  * parâmetros de animação para o coração 3D (quais câmaras/vias destacar).

IMPORTANTE: esta é uma ferramenta educacional/demonstrativa. As conclusões
são heurísticas e NÃO substituem a avaliação de um médico.
"""

from __future__ import annotations

# Faixas de referência do adulto (ms), usadas para sinalizar desvios.
REF = {
    "PR": (120, 200),
    "QRS": (70, 110),
    "QTc": (350, 450),
    "HR": (60, 100),
}

SEV_INFO = "info"
SEV_WARN = "atencao"
SEV_CRIT = "critico"


def _finding(titulo: str, detalhe: str, severidade: str) -> dict:
    return {"titulo": titulo, "detalhe": detalhe, "severidade": severidade}


def interpret(analysis: dict) -> dict:
    """Gera achados, ritmo e impressão diagnóstica a partir da análise."""
    if not analysis.get("ok"):
        return {
            "ritmo": "Indeterminado",
            "achados": [_finding("Análise não conclusiva", analysis.get("reason", "Sinal insuficiente."), SEV_WARN)],
            "impressao": "Não foi possível interpretar o traçado com segurança. "
                         "Envie uma imagem mais nítida da tira de ritmo.",
            "animation": {"rhythm": "sinus", "highlight_atria": True},
            "disclaimer": _DISCLAIMER,
        }

    hr = analysis["heart_rate"]["mean"]
    iv = analysis["intervals_ms"]
    var = analysis["variability"]
    morph = analysis["morphology"]

    achados: list[dict] = []

    # ----- Frequência cardíaca -----
    if hr < 60:
        achados.append(_finding("Bradicardia", f"Frequência cardíaca média de {hr:.0f} bpm (< 60 bpm).", SEV_WARN))
    elif hr > 100:
        sev = SEV_CRIT if hr > 150 else SEV_WARN
        achados.append(_finding("Taquicardia", f"Frequência cardíaca média de {hr:.0f} bpm (> 100 bpm).", sev))
    else:
        achados.append(_finding("Frequência normal", f"Frequência cardíaca média de {hr:.0f} bpm.", SEV_INFO))

    # ----- Regularidade do ritmo / onda P -----
    irregular = var["irregularity"] > 0.15
    p_absent = morph["p_wave_fraction"] < 0.5
    rhythm_anim = "sinus"

    if irregular and p_absent:
        ritmo = "Fibrilação atrial (provável)"
        achados.append(_finding(
            "Ritmo irregularmente irregular sem onda P",
            f"Variabilidade RR elevada (SDNN {var['SDNN_ms']:.0f} ms) e ausência de ondas P organizadas — "
            "padrão compatível com fibrilação atrial.",
            SEV_CRIT,
        ))
        rhythm_anim = "afib"
    elif irregular:
        ritmo = "Ritmo irregular"
        achados.append(_finding(
            "Ritmo irregular",
            f"Variabilidade dos intervalos RR acima do esperado (SDNN {var['SDNN_ms']:.0f} ms). "
            "Considerar arritmia sinusal, extrassístoles ou fibrilação atrial.",
            SEV_WARN,
        ))
        rhythm_anim = "pvc"
    else:
        if p_absent:
            ritmo = "Ritmo regular sem onda P clara"
            achados.append(_finding(
                "Onda P pouco visível",
                "Onda P não identificada de forma consistente — pode ser limitação da imagem ou ritmo juncional.",
                SEV_WARN,
            ))
        else:
            base = "Ritmo sinusal"
            ritmo = f"{base} ({'bradicárdico' if hr < 60 else 'taquicárdico' if hr > 100 else 'normal'})"
            achados.append(_finding("Ritmo sinusal", "Ondas P presentes precedendo cada QRS, ritmo regular.", SEV_INFO))

    # ----- Intervalo PR / condução AV -----
    pr = iv.get("PR")
    if pr is not None:
        if pr > REF["PR"][1]:
            achados.append(_finding(
                "PR prolongado",
                f"Intervalo PR de {pr:.0f} ms (> 200 ms) — sugere bloqueio atrioventricular de 1º grau.",
                SEV_WARN,
            ))
        elif pr < REF["PR"][0]:
            achados.append(_finding(
                "PR curto",
                f"Intervalo PR de {pr:.0f} ms (< 120 ms) — considerar pré-excitação (ex.: WPW).",
                SEV_WARN,
            ))

    # ----- Duração do QRS -----
    qrs = iv.get("QRS")
    if qrs is not None and qrs > REF["QRS"][1]:
        sev = SEV_CRIT if qrs > 140 else SEV_WARN
        achados.append(_finding(
            "QRS alargado",
            f"Duração do QRS de {qrs:.0f} ms (> 110 ms) — compatível com bloqueio de ramo ou origem ventricular.",
            sev,
        ))
        if qrs > 120 and rhythm_anim == "sinus":
            rhythm_anim = "pvc"

    # ----- QT / QTc -----
    qtc = iv.get("QTc_Bazett")
    if qtc is not None:
        if qtc > REF["QTc"][1]:
            sev = SEV_CRIT if qtc > 500 else SEV_WARN
            achados.append(_finding(
                "QTc prolongado",
                f"QTc (Bazett) de {qtc:.0f} ms (> 450 ms) — risco aumentado de arritmias ventriculares.",
                sev,
            ))
        elif qtc < REF["QTc"][0]:
            achados.append(_finding("QTc curto", f"QTc de {qtc:.0f} ms (< 350 ms).", SEV_WARN))

    # ----- Segmento ST -----
    st = morph["st_level_mv"]
    if st > 0.1:
        achados.append(_finding(
            "Supradesnivelamento de ST",
            f"Elevação do segmento ST de ~{st*1000:.0f} µV — avaliar isquemia/lesão aguda com urgência.",
            SEV_CRIT,
        ))
        rhythm_anim = "st_elevation"
    elif st < -0.1:
        achados.append(_finding(
            "Infradesnivelamento de ST",
            f"Depressão do segmento ST de ~{abs(st)*1000:.0f} µV — pode indicar isquemia.",
            SEV_WARN,
        ))

    # ----- Impressão diagnóstica -----
    criticos = [a for a in achados if a["severidade"] == SEV_CRIT]
    atencao = [a for a in achados if a["severidade"] == SEV_WARN]
    if criticos:
        cabecalho = "⚠ Alterações que exigem avaliação médica imediata: " + \
            ", ".join(a["titulo"] for a in criticos) + "."
    elif atencao:
        cabecalho = "Alterações que merecem atenção: " + ", ".join(a["titulo"] for a in atencao) + "."
    else:
        cabecalho = "Traçado dentro dos parâmetros de normalidade para os itens avaliados."

    impressao = (
        f"{ritmo}, frequência cardíaca média de {hr:.0f} bpm. " + cabecalho
    )

    # Confiança da digitalização afeta o texto.
    conf = analysis.get("confidence", 1.0)
    if conf < 0.5:
        impressao += (
            " Observação: a digitalização da imagem teve confiança baixa; "
            "as medidas são aproximadas."
        )

    return {
        "ritmo": ritmo,
        "achados": achados,
        "impressao": impressao,
        "animation": {
            "rhythm": rhythm_anim,
            "highlight_atria": not p_absent,
            "wide_qrs": bool(qrs and qrs > 120),
            "st_elevation": bool(st > 0.1),
        },
        "disclaimer": _DISCLAIMER,
    }


_DISCLAIMER = (
    "Ferramenta educacional e de demonstração. As interpretações são geradas "
    "por algoritmo heurístico e NÃO constituem diagnóstico médico. Procure "
    "sempre um profissional de saúde qualificado."
)
