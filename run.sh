#!/usr/bin/env bash
# Inicia o Cardio3D: instala dependências do backend e sobe o servidor.
# O frontend é servido pelo próprio backend em http://localhost:8000
set -e

cd "$(dirname "$0")/backend"

if ! python3 -c "import fastapi" 2>/dev/null; then
  echo "Instalando dependências do backend..."
  pip3 install -r requirements.txt
fi

echo "Cardio3D em execução → abra http://localhost:8000"
exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-8000}"
