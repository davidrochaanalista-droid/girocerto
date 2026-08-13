# GiroCerto

Plataforma de logística de motoboy para lojas locais (restaurantes, açaiterias,
padarias etc.), com foco em reduzir o **ciclo ocioso** do entregador: tempo de
espera na loja + volta vazia após a entrega.

MVP multi-tenant desde o início (via `tenant_id`), mas sem RLS robusta ainda —
cliente único no piloto, RLS entra na Fase 2.

## Estrutura

```
db/
  schema.sql        # schema Supabase/Postgres — versão mais recente e corrigida
mockups/
  cadastro-loja.html    # onboarding do proprietário + dados da loja
  painel-loja.html      # painel operacional da loja (pedidos, rotas, integrações)
  app-entregador.html   # app do motoboy (cadastro, verificação, rotas)
```

## Domínio (principais tabelas)

`tenants` (lojas), `usuarios_loja` (papéis: dono/operador), `entregadores`,
`horarios_funcionamento`, `turnos`, `rotas_entrega`, `tentativas_despacho`,
`localizacoes_entregador` (rastreio ao vivo), `alertas_seguranca`, `pedidos`,
`tentativas_contato`, `comprovantes_entrega`, `repasses`, `avaliacoes_loja`,
`integracoes` (Brendi, WhatsApp Business API, Pix).

## Gap conhecido (encontrado ao consolidar as versões)

`db/schema.sql` espera que o cadastro do entregador grave
`verificacao_prazo_limite` (prazo de 7 dias pra avaliação, calculado pela
aplicação — deixou de ser coluna gerada porque `timestamptz + interval` não é
IMMUTABLE pro Postgres, dava erro `42P17` na criação da tabela). O
`mockups/app-entregador.html` atual só grava `verificacao_enviada_em` e ainda
não calcula/envia esse prazo — precisa ser ajustado antes de virar código real.

## Status

Ainda é só design/schema (mockups HTML estáticos + schema SQL), sem app real
rodando. Duas versões dos mockups e do schema circulavam soltas na pasta —
consolidadas aqui na versão mais recente/correta de cada arquivo (ver histórico
do commit inicial pra detalhes de que mudou entre elas).
