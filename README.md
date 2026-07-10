# 🫀 Cardio3D — Interpretação de ECG em Molde Cardíaco 3D em Movimento

Sistema que **lê uma foto ou PDF de um eletrocardiograma**, digitaliza o
traçado, faz a **análise técnica completa** e transforma o resultado em um
**molde cardíaco 3D que bate em tempo real**, mostrando de forma realista as
câmaras contraindo e a onda elétrica percorrendo o sistema de condução —
sincronizado ao ritmo detectado no exame.

> ⚠️ **Aviso**: ferramenta educacional e de demonstração. As interpretações são
> geradas por algoritmo heurístico e **não constituem diagnóstico médico**.
> Procure sempre um profissional de saúde qualificado.

---

## O que ele faz

1. **Entrada** — envie uma foto (JPG/PNG) ou um PDF do ECG, ou escolha um dos
   ritmos de demonstração.
2. **Digitalização** — o backend remove a grade do papel milimetrado, calibra a
   escala (mm/s e mm/mV) e reconstrói o sinal em milivolts × tempo.
3. **Análise técnica completa** — frequência cardíaca, intervalos PR / QRS / QT /
   QTc (Bazett e Fridericia), segmento ST, amplitude de R, presença de onda P,
   variabilidade RR e contagem de batimentos.
4. **Interpretação** — classificação de ritmo (sinusal, bradicardia, taquicardia,
   fibrilação atrial, extrassístoles, supra de ST…) e achados com nível de
   severidade (OK / Atenção / Crítico). Cada achado traz a sua **repercussão
   clínica** e as **estruturas cardíacas envolvidas**, além de uma **análise
   combinada** que correlaciona os achados e descreve a repercussão global.
5. **Molde cardíaco 3D animado** — coração completo (4 câmaras + septo + 4 valvas
   + grandes vasos + sistema de condução: nó SA, nó AV, feixe de His, ramos e
   Purkinje) que **bate no tempo do ECG** e **demonstra a alteração** sobre a
   estrutura correspondente:
   - onda **P** → contração dos **átrios** (ou fibrilação, na FA);
   - complexo **QRS** → contração dos **ventrículos** (assíncrona no bloqueio de ramo);
   - marcador luminoso percorre **nó SA → nó AV → feixe de His → Purkinje**;
   - **supra de ST** → parede do ventrículo esquerdo destacada (região em sofrimento);
   - **rótulos** opcionais nomeiam cada estrutura sobre o modelo.

Toda a análise técnica aparece integrada à estrutura visual: tabela completa de
medidas, achados com repercussão, análise combinada, painel com o **estado de
todas as estruturas cardíacas** (normais x alteradas) e cursor de reprodução
sobre o traçado.

---

## Como executar

Requisitos: **Python 3.10+**. O frontend não precisa de build — o `three.js`
está empacotado localmente (`frontend/vendor/`), então funciona **offline**.

```bash
# 1. clonar e entrar no projeto
cd teste1

# 2. subir o servidor (instala dependências na primeira vez)
./run.sh
#   ou manualmente:
#   cd backend && pip install -r requirements.txt && uvicorn app:app --port 8000

# 3. abrir no navegador
#   http://localhost:8000
```

---

## Arquitetura

```
teste1/
├── backend/
│   ├── app.py                 # API FastAPI + serve o frontend estático
│   ├── requirements.txt
│   ├── ecg/
│   │   ├── extract.py         # foto/PDF → sinal calibrado (OpenCV + PyMuPDF)
│   │   ├── analyze.py         # detecção de QRS (Pan–Tompkins) + medidas
│   │   ├── interpret.py       # medidas → ritmo, achados e laudo (pt-BR)
│   │   └── synthetic.py       # ECG sintético (demo + fallback fisiológico)
│   └── tests/test_pipeline.py # testes de ponta a ponta
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── app.js             # orquestração + relógio de reprodução
│   │   ├── heart3d.js         # coração 3D (three.js) sincronizado ao ritmo
│   │   └── ecgchart.js        # traçado com grade e cursor
│   └── vendor/three/          # three.js empacotado (offline)
├── samples/                   # exemplos de ECG para teste
└── run.sh
```

### API

| Método | Rota           | Descrição                                                        |
|--------|----------------|-----------------------------------------------------------------|
| `POST` | `/api/analyze` | Recebe foto/PDF (`multipart/form-data`, campo `file`) e devolve sinal + análise + interpretação. |
| `GET`  | `/api/demo`    | ECG sintético. `?rhythm=sinus\|bradycardia\|tachycardia\|afib\|pvc\|st_elevation`. |
| `GET`  | `/api/health`  | Verificação de saúde.                                            |

Exemplo de resposta (resumido):

```json
{
  "meta": { "mode": "upload", "confidence": 0.78, "source": "image" },
  "signal": { "samples": [ ... ], "fs": 250, "duration": 6.0, "r_peaks": [ ... ] },
  "analysis": {
    "heart_rate": { "mean": 75.2, "min": 74.6, "max": 76.5 },
    "intervals_ms": { "PR": 152, "QRS": 100, "QT": 372, "QTc_Bazett": 417 },
    "beats": [ { "p": 0.6, "qrs": 0.8, "t": 1.1 }, ... ]
  },
  "interpretation": {
    "ritmo": "Ritmo sinusal (normal)",
    "achados": [ { "titulo": "Frequência normal", "severidade": "info" } ],
    "impressao": "Ritmo sinusal (normal), frequência cardíaca média de 75 bpm..."
  }
}
```

---

## Como a digitalização funciona

O papel de ECG tem grade rosa/vermelha e traçado preto. O extrator:

1. separa a tinta do traçado por cor (mantém pixels escuros e neutros,
   descartando os avermelhados da grade);
2. estima `px/mm` pela **autocorrelação** da projeção da grade — usando o
   **primeiro pico prominente** (a periodicidade fundamental de 1 mm) para não
   travar em harmônicos de 2 mm/5 mm que distorceriam a escala de tempo;
3. seleciona a banda horizontal mais densa (a tira de ritmo) e rastreia o
   traçado coluna a coluna;
4. calibra para 25 mm/s e 10 mm/mV e reamostra para 250 Hz.

A análise usa um detector de QRS no estilo **Pan–Tompkins** (derivada → quadrado
→ integração em janela móvel → limiar adaptativo) e delimita P, Q, R, S e T por
batimento para medir os intervalos.

Cada etapa devolve uma **confiança**; se a imagem não permitir uma leitura
segura, o sistema exibe um ritmo de referência para o molde 3D e sinaliza o
problema, em vez de falhar.

---

## Testes

```bash
cd backend && python tests/test_pipeline.py     # ou: python -m pytest tests/ -v
```

Cobrem: ECG sinusal normal, bradicardia, fibrilação atrial, supra de ST e o
round-trip completo (renderiza um ECG em imagem e recupera a frequência).
