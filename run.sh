#!/usr/bin/env bash
# Cardio3D roda 100% no navegador (sem backend). Basta servir a pasta frontend/
# como um site estático — usa apenas a biblioteca padrão do Python, sem pip install.
set -e
cd "$(dirname "$0")/frontend"
PORT="${PORT:-8000}"
echo "Cardio3D em execução → abra http://localhost:${PORT}"
exec python3 -c "
import http.server, socketserver
H = http.server.SimpleHTTPRequestHandler
H.extensions_map['.mjs'] = 'text/javascript'
H.extensions_map['.js'] = 'text/javascript'
socketserver.TCPServer(('0.0.0.0', ${PORT}), H).serve_forever()
"
