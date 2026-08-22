# Motor de despacho — GiroCerto

Serviço Node separado (não lógica só em Postgres) que escuta `pedidos.status = 'pronto'`
via `LISTEN/NOTIFY` do próprio Postgres, chama entregadores disponíveis dentro do raio da
loja, gerencia timeout/failover, e atribui a rota quando alguém aceita. Ver decisão de
arquitetura completa e o teste de confiabilidade do LISTEN/NOTIFY em `CLAUDE.md`.

## Como rodar localmente

```bash
cd dispatch-engine
npm install
cp .env.example .env   # preencha com as credenciais reais (não commitar o .env)
npm start
```

Precisa de `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `DATABASE_URL` — a
`DATABASE_URL` deve ser a conexão **direta** (`db.<ref>.supabase.co:5432`), não o
pooler transacional (pgbouncer recicla a conexão e quebraria o `LISTEN`).

Também precisa de `FIREBASE_SERVICE_ACCOUNT_JSON` (planejamento FCM, 22/08/2026)
pra notificar o entregador via push nativo (só buzina, sem voz) quando uma nova
oferta é criada — o JSON inteiro da service account do Firebase (Project Settings
> Service Accounts > Generate new private key), como string numa única variável.
Sem essa variável, `enviarPushBuzinaEntregador()` falha silenciosamente (logada,
nunca bloqueia o despacho) — só afeta a notificação, a oferta em si continua
chegando pro app via Realtime/polling.

## Deploy no Railway

Configurar as mesmas variáveis de ambiente no painel do Railway (não usar `.env`
commitado — Railway injeta via dashboard). Deploy como serviço padrão Node
(`npm install && npm start`); expõe `/health` na porta de `PORT` (Railway define
automaticamente).

## O que o serviço faz (v1)

1. Na subida, reconcilia: pedidos `'pronto'` sem rota que ficaram pra trás (ex: o
   serviço caiu no meio) são despachados; tentativas de despacho abertas que já
   deveriam ter expirado são forçadas a `sem_resposta` e o failover continua;
   tentativas ainda dentro da janela têm o timeout reagendado.
2. `LISTEN pedido_pronto` — pedido virou `'pronto'` (trigger `notificar_pedido_pronto`
   em `db/schema.sql`): cria a `rotas_entrega` (se ainda não existir), busca o
   entregador `disponivel` mais próximo dentro de `raio_chamada_motoboy_km` (sem
   geofiltro se a loja ainda não definiu `tenants.lat/lng` em painel-loja.html), cria
   `tentativas_despacho`, agenda o timeout.
3. `LISTEN tentativa_despacho_respondida` (trigger `notificar_resposta_despacho`):
   `aceito` → atribui a rota ao entregador (`status = 'a_caminho_da_loja'`), ignora se
   a rota já tinha entregador (late accept); `recusado` → tenta o próximo candidato
   imediatamente, sem esperar o timeout.
4. Timeout sem resposta → marca `sem_resposta`, tenta o próximo candidato (failover).
5. Sem candidatos restantes → loga claramente e para; **não** inventa retry
   automático nem escalonamento que não foi pedido — fica pra intervenção manual da
   loja (visível em `painel-loja.html`, rota sem entregador atribuído).

## Limitações conhecidas (v1, documentadas — não escondidas)

- Estado de failover (quem já foi tentado por rota) e os timers de timeout vivem em
  memória do processo — não sobrevivem a um restart no meio da janela de espera. A
  reconciliação de startup cobre o caso comum, mas um timer específico perdido só é
  recuperado na próxima subida do processo, não instantaneamente.
- 1 pedido por rota — sem agrupamento/roteirização de múltiplos pedidos ainda (decisão
  de escopo já registrada em sessões anteriores; o nearest-neighbor
  `ordenarParadasPorProximidade()` de `painel-loja.html` fica pronto pra quando isso
  for implementado).
- Sem geofiltro se a loja não definiu `tenants.lat/lng` — despacha pro primeiro
  disponível do tenant, sem considerar distância.
