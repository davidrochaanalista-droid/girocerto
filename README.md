# GiroCerto

Plataforma de logística de motoboy para lojas locais (restaurantes, açaiterias,
padarias etc.), com foco em reduzir o **ciclo ocioso** do entregador: tempo de
espera na loja + volta vazia após a entrega.

MVP multi-tenant desde o início (via `tenant_id`), **com RLS implementada de
verdade desde o schema inicial** — policy por policy, escopando cada tabela
sensível por `tenant_id`/`entregador_id` via `auth.uid()` (não é só
`ENABLE ROW LEVEL SECURITY` sem nada por trás). Esse texto dizia antes que a
RLS ficaria pra Fase 2, mas isso nunca refletiu o `schema.sql` — correção
feita na revisão A3 (achado real).

## Estrutura

```
db/
  schema.sql        # schema Supabase/Postgres — versão mais recente e corrigida
mockups/
  cadastro-loja.html    # onboarding do proprietário + dados da loja
  painel-loja.html      # painel operacional da loja (pedidos, rotas, integrações)
  app-entregador.html   # app do motoboy (cadastro, verificação, rotas)
dispatch-engine/
  index.js          # motor de despacho real (Node/Express) — ver dispatch-engine/README.md
tests/
  run-all.js        # suíte de testes de integração real, contra o Supabase hospedado
```

## Domínio (principais tabelas)

`tenants` (lojas), `usuarios_loja` (papéis: dono/funcionário), `entregadores`,
`horarios_funcionamento`, `turnos`, `rotas_entrega`, `tentativas_despacho`,
`localizacoes_entregador` (rastreio ao vivo), `alertas_seguranca`, `pedidos`,
`tentativas_contato`, `comprovantes_entrega`, `repasses`, `avaliacoes_loja`,
`integracoes` (Brendi, WhatsApp Business API, Pix).

## Análise de mercado

Ver [`ANALISE_MERCADO_E_TORRE.md`](./ANALISE_MERCADO_E_TORRE.md) — comparação
com concorrentes reais do setor (Foody Delivery, InstaDelivery, Entregador
Online, Wappa, Loggi Expresso, Lalamove) e cruzamento com o Torre
(fleet-orchestrator, projeto irmão) pra padrões de arquitetura reaproveitáveis.
As correções e gaps críticos identificados lá (rastreio ao vivo, alerta de
motoboy parado, desvio de rota, etc.) já foram aplicados no `db/schema.sql` e
nos mockups — ver histórico de commits.

## Status

Os 3 mockups HTML falam direto com o Supabase hospedado real (client-side,
sem build step). Desde 15/08/2026 existe também um backend Node/Express real,
`dispatch-engine/` — o motor de despacho, que escuta `pedidos.status='pronto'`
via `LISTEN/NOTIFY` do Postgres, chama entregadores disponíveis por raio,
gerencia timeout/failover e atribui rotas (ver `dispatch-engine/README.md`).
Ainda não deployado no Railway (pendência de infra, não de código — ver
`CLAUDE.md`). Duas versões dos mockups e do schema circulavam soltas na pasta
originalmente; consolidadas na versão mais recente/correta de cada arquivo
(ver histórico do commit inicial pra detalhes de que mudou entre elas).

Funcionalidades que ainda dependem de decisão externa ou não foram
construídas (ver `CLAUDE.md` pras pendências atualizadas): integração real de
Pix (decisão de produto — qual provedor contratar; o resto do sistema já
funciona sem depender disso), link público de rastreio pro cliente final,
geração de `rota_polyline` via OSRM.
