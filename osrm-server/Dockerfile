# OSRM self-hospedado (item "agora" do relatório GiroCerto vs. Mercado,
# 26/08/2026) — substitui router.project-osrm.org, o servidor público de
# demonstração que o próprio projeto OSRM diz para não usar em produção
# (1 req/s, sem SLA). Extrato regional Sudeste (SP/RJ/MG/ES, Geofabrik) —
# cobre a região de operação atual do GiroCerto sem processar o Brasil
# inteiro. Pré-processamento acontece no primeiro start (start.sh), não
# no build da imagem — persistido no volume Railway montado em /data
# pra não reprocessar a cada deploy.
FROM ghcr.io/project-osrm/osrm-backend:latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /data
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 5000
ENTRYPOINT ["/start.sh"]
