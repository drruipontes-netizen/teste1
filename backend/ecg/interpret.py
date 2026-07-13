"""Interpretação clínica a partir das medidas de ECG.

Converte a saída de :func:`ecg.analyze.analyze` em:
  * classificação de ritmo;
  * lista de achados com severidade, **repercussão clínica** e as **estruturas
    cardíacas** envolvidas em cada alteração;
  * mapa completo do estado de cada estrutura do coração (átrios, ventrículos,
    septo, valvas, nó SA, nó AV, feixe de His, ramos, Purkinje, grandes vasos);
  * análise combinada (correlação entre os achados e sua repercussão global);
  * parâmetros de animação para o molde cardíaco 3D demonstrar a alteração.

IMPORTANTE: ferramenta educacional/demonstrativa. As conclusões são heurísticas
e NÃO substituem a avaliação de um médico.
"""

from __future__ import annotations

# Faixas de referência do adulto (ms).
REF = {"PR": (120, 200), "QRS": (70, 110), "QTc": (350, 450), "HR": (60, 100)}

SEV_INFO = "info"
SEV_WARN = "atencao"
SEV_CRIT = "critico"

# Catálogo de todas as estruturas cardíacas modeladas (chave -> nome exibido).
STRUCTURES = {
    "atrio_direito": "Átrio direito",
    "atrio_esquerdo": "Átrio esquerdo",
    "ventriculo_direito": "Ventrículo direito",
    "ventriculo_esquerdo": "Ventrículo esquerdo",
    "septo": "Septo interventricular",
    "valva_tricuspide": "Valva tricúspide",
    "valva_mitral": "Valva mitral",
    "valva_aortica": "Valva aórtica",
    "valva_pulmonar": "Valva pulmonar",
    "no_sa": "Nó sinoatrial (SA)",
    "no_av": "Nó atrioventricular (AV)",
    "feixe_his": "Feixe de His",
    "ramo_direito": "Ramo direito",
    "ramo_esquerdo": "Ramo esquerdo",
    "purkinje": "Fibras de Purkinje",
    "aorta": "Aorta",
    "arteria_pulmonar": "Artéria pulmonar",
    "veia_cava": "Veias cavas",
}


def _finding(titulo, detalhe, severidade, repercussao="", estruturas=None):
    return {
        "titulo": titulo,
        "detalhe": detalhe,
        "severidade": severidade,
        "repercussao": repercussao,
        "estruturas": estruturas or [],
    }


def interpret(analysis: dict) -> dict:
    """Gera achados, repercussão, estado das estruturas e análise combinada."""
    # Estado base de todas as estruturas: normal.
    structures = {k: {"nome": v, "estado": "normal", "obs": ""} for k, v in STRUCTURES.items()}

    def mark(keys, estado, obs):
        for k in keys:
            structures[k]["estado"] = estado
            structures[k]["obs"] = obs

    if not analysis.get("ok"):
        return {
            "ritmo": "Indeterminado",
            "achados": [_finding("Análise não conclusiva", analysis.get("reason", "Sinal insuficiente."), SEV_WARN)],
            "impressao": "Não foi possível interpretar o traçado com segurança. Envie uma imagem mais nítida.",
            "analise_combinada": "Sem dados suficientes para correlacionar achados.",
            "structures": structures,
            "animation": {"rhythm": "sinus", "highlight_atria": True, "structures": {}},
            "disclaimer": _DISCLAIMER,
        }

    hr = analysis["heart_rate"]["mean"]
    iv = analysis["intervals_ms"]
    var = analysis["variability"]
    morph = analysis["morphology"]

    achados: list[dict] = []
    anim_struct: dict[str, str] = {}  # estados para a animação 3D

    # ----- Frequência cardíaca -----
    if hr < 60:
        achados.append(_finding(
            "Bradicardia", f"Frequência cardíaca média de {hr:.0f} bpm (< 60 bpm).", SEV_WARN,
            repercussao="Débito cardíaco pode cair; se sintomática, causa fadiga, tontura ou síncope. "
                        "O nó sinoatrial dispara mais lentamente e o enchimento diastólico se prolonga.",
            estruturas=["no_sa"],
        ))
        mark(["no_sa"], "lento", "Disparo sinusal lento")
    elif hr > 100:
        sev = SEV_CRIT if hr > 150 else SEV_WARN
        achados.append(_finding(
            "Taquicardia", f"Frequência cardíaca média de {hr:.0f} bpm (> 100 bpm).", sev,
            repercussao="Encurta a diástole e o tempo de enchimento ventricular, aumentando o consumo de "
                        "oxigênio do miocárdio; em excesso, reduz o débito cardíaco.",
            estruturas=["no_sa", "ventriculo_esquerdo"],
        ))
        mark(["no_sa"], "rapido", "Disparo sinusal acelerado")
    else:
        achados.append(_finding(
            "Frequência normal", f"Frequência cardíaca média de {hr:.0f} bpm.", SEV_INFO,
            repercussao="Ritmo de disparo do nó sinoatrial dentro do esperado.",
            estruturas=["no_sa"],
        ))

    # ----- Regularidade do ritmo / onda P -----
    irregular = var["irregularity"] > 0.15
    p_absent = morph["p_wave_fraction"] < 0.5
    rhythm_anim = "sinus"

    if irregular and p_absent:
        ritmo = "Fibrilação atrial (provável)"
        achados.append(_finding(
            "Ritmo irregularmente irregular sem onda P",
            f"Variabilidade RR elevada (SDNN {var['SDNN_ms']:.0f} ms) e ausência de ondas P organizadas.",
            SEV_CRIT,
            repercussao="Os átrios não contraem de forma coordenada — perde-se a contribuição atrial ao "
                        "enchimento ventricular (~20% do débito) e há estase sanguínea nos átrios, com risco "
                        "de formação de trombos e embolia (AVC).",
            estruturas=["atrio_direito", "atrio_esquerdo", "no_av"],
        ))
        rhythm_anim = "afib"
        mark(["atrio_direito", "atrio_esquerdo"], "fibrilando", "Contração desorganizada")
        mark(["no_av"], "irregular", "Condução irregular aos ventrículos")
        anim_struct["atria"] = "fibrillating"
    elif irregular:
        ritmo = "Ritmo irregular"
        achados.append(_finding(
            "Ritmo irregular",
            f"Variabilidade dos intervalos RR acima do esperado (SDNN {var['SDNN_ms']:.0f} ms).",
            SEV_WARN,
            repercussao="Batimentos precoces ou pausas alteram o enchimento ventricular batimento a batimento, "
                        "podendo gerar palpitações. Considerar extrassístoles ou fibrilação atrial.",
            estruturas=["ventriculo_esquerdo", "ventriculo_direito"],
        ))
        rhythm_anim = "pvc"
        mark(["ventriculo_esquerdo", "ventriculo_direito"], "extrassistole", "Batimentos ectópicos")
        anim_struct["ventricles"] = "ectopic"
    else:
        if p_absent:
            ritmo = "Ritmo regular sem onda P clara"
            achados.append(_finding(
                "Onda P pouco visível",
                "Onda P não identificada de forma consistente.",
                SEV_WARN,
                repercussao="Pode ser limitação da imagem ou um ritmo de origem juncional (o nó AV assume o "
                            "comando), com perda da contração atrial efetiva.",
                estruturas=["atrio_direito", "atrio_esquerdo", "no_av"],
            ))
            mark(["atrio_direito", "atrio_esquerdo"], "silencioso", "Atividade atrial não identificada")
        else:
            base = "bradicárdico" if hr < 60 else "taquicárdico" if hr > 100 else "normal"
            ritmo = f"Ritmo sinusal ({base})"
            achados.append(_finding(
                "Ritmo sinusal",
                "Ondas P presentes precedendo cada QRS, ritmo regular.",
                SEV_INFO,
                repercussao="Condução elétrica normal: nó SA → átrios → nó AV → His-Purkinje → ventrículos.",
                estruturas=["no_sa", "atrio_direito", "atrio_esquerdo"],
            ))

    # ----- Intervalo PR / condução AV -----
    pr = iv.get("PR")
    if pr is not None:
        if pr > REF["PR"][1]:
            achados.append(_finding(
                "PR prolongado",
                f"Intervalo PR de {pr:.0f} ms (> 200 ms) — sugere bloqueio AV de 1º grau.",
                SEV_WARN,
                repercussao="A condução entre átrios e ventrículos está lentificada no nó AV. Isoladamente "
                            "costuma ser benigno, mas pode evoluir para graus maiores de bloqueio.",
                estruturas=["no_av", "feixe_his"],
            ))
            mark(["no_av"], "bloqueio_lento", "Condução AV lentificada")
            anim_struct["av"] = "delayed"
        elif pr < REF["PR"][0]:
            achados.append(_finding(
                "PR curto",
                f"Intervalo PR de {pr:.0f} ms (< 120 ms) — considerar pré-excitação (ex.: WPW).",
                SEV_WARN,
                repercussao="Pode haver uma via acessória conduzindo o impulso mais rápido que o nó AV, "
                            "predispondo a taquiarritmias.",
                estruturas=["no_av", "feixe_his"],
            ))
            mark(["no_av"], "pre_excitacao", "Condução acelerada / via acessória")

    # ----- Duração do QRS / ramos -----
    qrs = iv.get("QRS")
    if qrs is not None and qrs > REF["QRS"][1]:
        sev = SEV_CRIT if qrs > 140 else SEV_WARN
        achados.append(_finding(
            "QRS alargado",
            f"Duração do QRS de {qrs:.0f} ms (> 110 ms) — bloqueio de ramo ou origem ventricular.",
            sev,
            repercussao="A despolarização ventricular não segue a via rápida normal; um ventrículo é ativado "
                        "com atraso, gerando contração dessincronizada e menor eficiência de bombeamento.",
            estruturas=["ramo_direito", "ramo_esquerdo", "purkinje", "ventriculo_esquerdo"],
        ))
        mark(["ramo_esquerdo"], "bloqueado", "Bloqueio de ramo (condução tardia)")
        mark(["ventriculo_esquerdo", "ventriculo_direito"], "dessincronizado", "Contração assíncrona")
        anim_struct["bundle"] = "block_left"
        if qrs > 120 and rhythm_anim == "sinus":
            rhythm_anim = "pvc"

    # ----- QT / QTc -----
    qtc = iv.get("QTc_Bazett")
    if qtc is not None:
        if qtc > REF["QTc"][1]:
            sev = SEV_CRIT if qtc > 500 else SEV_WARN
            achados.append(_finding(
                "QTc prolongado",
                f"QTc (Bazett) de {qtc:.0f} ms (> 450 ms).",
                sev,
                repercussao="A repolarização ventricular está prolongada, aumentando o risco de arritmias "
                            "ventriculares graves (torsades de pointes), sobretudo acima de 500 ms.",
                estruturas=["ventriculo_esquerdo", "ventriculo_direito"],
            ))
            mark(["ventriculo_esquerdo", "ventriculo_direito"], "repolarizacao_lenta", "Repolarização prolongada")
        elif qtc < REF["QTc"][0]:
            achados.append(_finding(
                "QTc curto", f"QTc de {qtc:.0f} ms (< 350 ms).", SEV_WARN,
                repercussao="Repolarização acelerada; pode associar-se a canalopatias e arritmias.",
                estruturas=["ventriculo_esquerdo"],
            ))

    # ----- Segmento ST / isquemia -----
    st = morph["st_level_mv"]
    if st > 0.12:
        achados.append(_finding(
            "Supradesnivelamento de ST",
            f"Elevação do segmento ST de ~{st*1000:.0f} µV — padrão de infarto agudo com supra de ST (IAMCSST). "
            "Local afetado destacado no modelo 3D: parede anterior do ventrículo esquerdo (território da "
            "artéria descendente anterior). Nota: a localização definitiva do território exige o ECG de 12 derivações.",
            SEV_CRIT,
            repercussao="Uma região da parede ventricular está sem fluxo sanguíneo adequado (oclusão coronária) e "
                        "em sofrimento isquêmico — o músculo daquela área contrai mal, reduzindo o bombeamento. "
                        "É uma emergência tempo-dependente ('tempo é músculo').",
            estruturas=["ventriculo_esquerdo", "ramo_esquerdo"],
        ))
        rhythm_anim = "st_elevation"
        mark(["ventriculo_esquerdo"], "isquemico", "Sofrimento/lesão da parede ventricular")
        anim_struct["lv_wall"] = "ischemic"
    elif st < -0.12:
        achados.append(_finding(
            "Infradesnivelamento de ST",
            f"Depressão do segmento ST de ~{abs(st)*1000:.0f} µV — pode indicar isquemia.",
            SEV_WARN,
            repercussao="Pode refletir isquemia subendocárdica (oferta de oxigênio insuficiente para a demanda) "
                        "ou sobrecarga ventricular.",
            estruturas=["ventriculo_esquerdo"],
        ))
        mark(["ventriculo_esquerdo"], "isquemia_subendo", "Possível isquemia subendocárdica")

    # ----- Impressão diagnóstica + análise combinada -----
    criticos = [a for a in achados if a["severidade"] == SEV_CRIT]
    atencao = [a for a in achados if a["severidade"] == SEV_WARN]
    if criticos:
        cabecalho = "⚠ Alterações que exigem avaliação médica imediata: " + ", ".join(a["titulo"] for a in criticos) + "."
    elif atencao:
        cabecalho = "Alterações que merecem atenção: " + ", ".join(a["titulo"] for a in atencao) + "."
    else:
        cabecalho = "Traçado dentro dos parâmetros de normalidade para os itens avaliados."
    impressao = f"{ritmo}, frequência cardíaca média de {hr:.0f} bpm. {cabecalho}"

    conf = analysis.get("confidence", 1.0)
    if conf < 0.5:
        impressao += " Observação: a digitalização da imagem teve confiança baixa; as medidas são aproximadas."

    analise_combinada = _combined_analysis(achados, structures)

    return {
        "ritmo": ritmo,
        "achados": achados,
        "impressao": impressao,
        "analise_combinada": analise_combinada,
        "structures": structures,
        "animation": {
            "rhythm": rhythm_anim,
            "highlight_atria": not p_absent,
            "wide_qrs": bool(qrs and qrs > 120),
            "st_elevation": bool(st > 0.12),
            "structures": anim_struct,
        },
        "disclaimer": _DISCLAIMER,
    }


def _combined_analysis(achados: list[dict], structures: dict) -> str:
    """Correlaciona os achados e descreve a repercussão global sobre o coração."""
    alteradas = [v["nome"] for v in structures.values() if v["estado"] != "normal"]
    partes = []

    titulos = {a["titulo"] for a in achados}
    # Correlações clínicas combinadas mais relevantes.
    if "Ritmo irregularmente irregular sem onda P" in titulos:
        partes.append(
            "O conjunto (RR irregular + ausência de onda P) aponta para fibrilação atrial: os átrios "
            "deixam de bombear de forma organizada e a resposta ventricular fica irregular. A repercussão "
            "hemodinâmica é a perda do 'chute atrial' e o risco tromboembólico."
        )
    if "Supradesnivelamento de ST" in titulos:
        partes.append(
            "O supradesnivelamento de ST, associado à repolarização, indica lesão miocárdica ativa: uma "
            "parede ventricular está isquêmica e sua contração fica comprometida — quadro tempo-dependente."
        )
    if "QRS alargado" in titulos:
        partes.append(
            "O QRS alargado revela condução ventricular anômala (bloqueio de ramo), com contração "
            "dessincronizada dos ventrículos e redução da eficiência de bombeamento."
        )
    if "PR prolongado" in titulos:
        partes.append(
            "O PR prolongado indica lentificação da condução no nó AV, atrasando a chegada do impulso aos "
            "ventrículos."
        )
    if not partes:
        partes.append(
            "Os parâmetros elétricos e a condução (nó SA → átrios → nó AV → His-Purkinje → ventrículos) "
            "mostram-se coordenados, sem repercussão hemodinâmica evidente nos itens avaliados."
        )

    if alteradas:
        partes.append("Estruturas com alteração destacada no modelo 3D: " + ", ".join(alteradas) + ".")
    return " ".join(partes)


_DISCLAIMER = (
    "Ferramenta educacional e de demonstração. As interpretações são geradas por algoritmo heurístico e "
    "NÃO constituem diagnóstico médico. Procure sempre um profissional de saúde qualificado."
)
