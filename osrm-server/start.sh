#!/bin/bash
set -e

DATA_DIR="/data"
PBF_URL="https://download.geofabrik.de/south-america/brazil/sudeste-latest.osm.pbf"
PBF_FILE="$DATA_DIR/sudeste-latest.osm.pbf"
OSRM_BASE="$DATA_DIR/sudeste-latest.osrm"
MARKER="$DATA_DIR/.processed"

if [ ! -f "$MARKER" ]; then
  echo "[osrm-server] Nenhum dado pré-processado no volume — baixando e processando (só acontece 1x, pode levar alguns minutos)."
  wget -q -O "$PBF_FILE" "$PBF_URL"
  osrm-extract -p /opt/car.lua "$PBF_FILE"
  osrm-partition "$OSRM_BASE"
  osrm-customize "$OSRM_BASE"
  rm -f "$PBF_FILE"
  touch "$MARKER"
  echo "[osrm-server] Pré-processamento concluído e persistido em $DATA_DIR."
else
  echo "[osrm-server] Dado já processado encontrado em $DATA_DIR — pulando pré-processamento."
fi

PORT="${PORT:-5000}"
echo "[osrm-server] Subindo osrm-routed (MLD) na porta $PORT"
exec osrm-routed --algorithm mld --port "$PORT" "$OSRM_BASE"
