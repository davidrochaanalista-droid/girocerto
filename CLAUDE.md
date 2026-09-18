# GiroCerto — Status do Projeto

> Log cronológico completo de "O que foi feito" (itens 1-119) está em
> `CLAUDE-historico.md` (separado em 18/09/2026 pra manter este arquivo
> sob o limite de contexto). Este arquivo tem o estado atual, arquitetura
> e pendências — suficiente pro dia a dia; consulte o histórico só quando
> precisar do detalhe/motivo de uma decisão passada específica.

## Visão geral
Plataforma de logística de motoboy pra lojas locais (restaurantes, açaiterias,
padarias etc.), com foco em reduzir o ciclo ocioso do entregador (espera na loja +
volta vazia). Os mockups HTML estáticos (`cadastro-loja.html`, `painel-loja.html`,
`app-entregador.html`, `painel-admin.html`) falam DIRETO com Supabase via
`@supabase/supabase-js` (conectados ao projeto hospedado real desde 15/08/2026) e
continuam sem build step/SPA. **Hospedados publicamente na Vercel desde 18/08/2026**
(ver item 19) — antes disso nunca tiveram hospedagem nenhuma, só rodavam localmente
via `python -m http.server`:
- Cadastro da loja: https://girocerto-mockups.vercel.app/cadastro-loja.html
- Painel da loja: https://girocerto-mockups.vercel.app/painel-loja.html
- App do entregador: https://girocerto-mockups.vercel.app/app-entregador.html
  (o entregador chega aqui via link com `?loja=<tenant_id>`, copiado do painel
  da loja — não existe link fixo público pra essa tela)
- Painel admin (David + equipe, plataforma): https://girocerto-mockups.vercel.app/painel-admin.html
  (login real + checagem `eh_desenvolvedor_admin()`, mesma allowlist do
  `painel-dev.html` — quem não está na allowlist é deslogado na hora; ver item 25)

`painel-dev.html` continua existindo, mas só local (`mockups/.gitignore`), nunca
publicado — ferramenta interna do dev, não confundir com `painel-admin.html` (esse
sim é o painel de produção da equipe).

Desde 15/08/2026 **existe um backend Node/Express real**: `dispatch-engine/`, o
motor de despacho (ver item 10 em "O que foi feito" e
`dispatch-engine/README.md`) — roda separado dos mockups, usa a service_role key.
**Deployado no Railway desde 17/08/2026 e validado em produção** (projeto
`girocerto-dispatch-engine`, serviço `girocerto-dispatch-engine`, ID
`e124fea3-47c1-484e-b56c-1ded3b14fae9`) — ver item 15. `dispatch-engine/` **não**
está e nunca precisa estar na Vercel — só os 3 HTMLs estáticos foram publicados
lá; o motor de despacho continua exclusivamente no Railway. Caminho local:
C:\Users\Usuário\Projetos\giro certo

## Arquitetura conhecida
- Multi-tenant via `tenant_id`, com **RLS real desde o schema inicial** — policy por
  policy, não é `ENABLE ROW LEVEL SECURITY` vazio. Ponto forte real do projeto (Torre,
  por comparação, tem RLS habilitada sem policies numa auditoria antiga).
- `localizacoes_entregador` e `alertas_seguranca` **não têm `tenant_id` direto** — o
  escopo é sempre indireto via join com `entregadores` (`entregador_id in (select id
  from entregadores where tenant_id in (...))`). Isso importa pra qualquer filtro de
  Realtime, que só suporta comparação direta de coluna, não subquery/join.
- `rotas_entrega.rota_polyline` guarda o formato Google/OSRM encoded polyline
  (string compacta, não WKT/GeoJSON) — decodificado em SQL puro por
  `decodificar_polyline()` (plpgsql, algoritmo padrão de 5-bit varint + zigzag).
- Padrões do Torre foram adaptados pra essa arquitetura sem backend, não transplantados
  literalmente: `telemetryBuffer.js` (buffer server-side) → throttle client-side (não
  há servidor pra bufferizar); `telemetryHub.js` (WebSocket custom) → Supabase Realtime
  (`postgres_changes`), que já é RLS-aware nativamente; `computeStalledSeconds()`/
  `computeMissionAlerts()` (Node, polling a cada 4s) → funções `SECURITY DEFINER` em
  plpgsql + triggers em `localizacoes_entregador`, porque a lógica de segurança não
  pode depender de uma aba do navegador estar aberta.
- PostGIS (`create extension if not exists postgis`) foi adicionado — schema original
  usava `double precision` puro pra lat/lng, não `geography`.
- **RLS que precisa saber "de qual tenant esse usuário é" NUNCA pode fazer subselect cru
  em `usuarios_loja` dentro de uma policy** (nem da própria `usuarios_loja`, nem de
  qualquer outra tabela) — isso causa recursão infinita (Postgres `42P17`), porque
  resolver o subselect reaciona a própria RLS de `usuarios_loja`. Todo esse tipo de
  lookup passa por funções `SECURITY DEFINER` com `search_path` fixado
  (`minhas_tenant_ids()`, `minhas_tenant_ids_dono()`, `tenant_ja_tem_usuario()`,
  `config_fadiga_do_meu_tenant()`) — rodam como o dono da função (`BYPASSRLS`), então a
  consulta interna não reaciona a policy. Ao criar QUALQUER policy nova que precise do
  tenant do usuário logado, usar uma dessas funções, nunca escrever o subselect na mão
  de novo. `pgcrypto` (usado pelas funções de PIN) fica no schema `extensions` no
  Supabase hospedado, não em `public` — funções `SECURITY DEFINER` que chamam
  `crypt`/`gen_salt` precisam de `set search_path = public, extensions, pg_temp`.
- **REGRA GERAL (não é só sobre `usuarios_loja` — já se repetiu uma 2ª vez, entre
  `rotas_entrega` e `tentativas_despacho`, na sessão de 16/08/2026, ver item 12):
  QUALQUER policy nova que cruze `entregador_id`/`tenant_id` via subselect/join pra
  outra tabela que TAMBÉM tem RLS habilitada tem risco real de recursão infinita
  (`42P17`) SE aquela outra tabela também tiver uma policy que faz subselect de
  volta pra primeira** (ciclo de 2 tabelas se reavaliando uma à outra — não precisa
  ser auto-referência na mesma tabela pra recursão acontecer, só um ciclo entre
  quaisquer duas). Antes de escrever uma policy nova que subselects em outra
  tabela: perguntar "essa outra tabela tem alguma policy que subselects de volta
  aqui?" — se sim, usar uma função `SECURITY DEFINER` (mesmo formato de
  `minhas_tenant_ids()`: `language sql`, `security definer`, `stable`,
  `set search_path = public, pg_temp`) desde a PRIMEIRA versão da policy, não como
  correção depois de descobrir o 42P17 rodando contra o banco real. Exemplo
  concreto do 2º caso: `rotas_com_tentativa_para_mim()`.
- **`.insert().select()` em `tenants`/`usuarios_loja` quebra por RLS** mesmo com o
  insert em si correto: dentro do MESMO comando `INSERT ... RETURNING`, uma subquery
  que consulta a própria tabela (direto ou via função `SECURITY DEFINER`) não enxerga a
  linha que está sendo inserida agora (regra de snapshot do Postgres — não é bug da
  função, é MVCC padrão). Correção: gerar o `id` no cliente (`crypto.randomUUID()`) em
  vez de deixar o `default gen_random_uuid()` e ler de volta; ou simplesmente não
  encadear `.select()` quando o insert não precisa do retorno.
- `usuarios_loja` só permite auto-inserir como `papel='dono'` E só se for o PRIMEIRO
  vínculo daquele tenant (`tenant_ja_tem_usuario()`) — não existe hoje nenhum fluxo de
  auto-cadastro de FUNCIONÁRIO em lugar nenhum do produto; criar uma conta de
  funcionário exige passar pela service role (backend/admin), não há UI cliente pra
  isso ainda.
- **`selo_entrega_justa` é público de propósito, sem RLS/tenant-scoping — decisão de
  produto confirmada, não um gap** (ver comentário SQL direto na definição da view em
  `db/schema.sql`). A view não declara `security_invoker = true`, então roda com o
  privilégio de quem a criou e não escopa por tenant: qualquer sessão autenticada
  (e futuramente até anônima) vê o selo de QUALQUER tenant. Isso é intencional — o
  Selo Entrega Justa é uma marca de confiança pública, o cliente final precisa
  comparar lojas antes de logar em qualquer lugar; escopar por tenant mataria a
  função do selo. Seguro porque só expõe nome da loja + agregados (sem PII, sem
  financeiro) — a tabela base `avaliacoes_loja` continua sem policy de SELECT pra
  ninguém além do service role. Se um ultrareview futuro marcar isso como achado de
  novo, é falso positivo: já foi avaliado e confirmado (14/08/2026, PR #1).
- **`signUp()` sem e-mail confirmado NÃO abre sessão** (projeto tem
  `mailer_autoconfirm: false`) — `auth.uid()` fica `null` pro cliente que acabou de
  se cadastrar, então QUALQUER insert feito direto pela UI logo após `signUp()`
  bate em RLS (`42501`), e QUALQUER upload pro Storage também (as policies de
  `storage.objects` também exigem `auth.uid() is not null`). Não aparece em teste
  nenhum que use `admin.createUser({email_confirm:true})` — só se manifesta com
  `signUp()` de verdade (ver item 16). Padrão de correção estabelecido: provisionar
  via trigger `SECURITY DEFINER` `AFTER INSERT ON auth.users` (bypassa RLS, não
  depende de sessão), lendo os campos do formulário via `options.data` do
  `signUp()` (`raw_user_meta_data`); documentos/uploads ficam pra depois do
  primeiro login (sessão já existe nesse ponto).
- **GoTrue faz uma 2ª escrita própria em `auth.users` depois do INSERT** (achado
  real, sessão de 17-18/08/2026, ver item 16) — ao criar a linha em
  `auth.identities` (fluxo normal de signup com provider `email`), o GoTrue
  resincroniza `raw_user_meta_data` a partir do payload original que recebeu na
  requisição, uns 100-500ms depois do INSERT. Isso importa pra QUALQUER trigger
  nosso que dependa de "isso só roda uma vez por signup" em cima de
  `raw_user_meta_data` — o valor que a UI vê/lê depois pode não ser o que o NOSSO
  trigger `AFTER INSERT` gravou por último. Não há corrida real (triggers `AFTER
  ROW` são síncronos dentro do INSERT, a 2ª escrita do GoTrue só pode acontecer
  depois que o INSERT já retornou), mas qualquer lógica que dependa do estado
  final de `raw_user_meta_data` depois do signup precisa reagir a essa 2ª escrita
  (trigger `AFTER UPDATE`), não só ao INSERT.
- **CHECKLIST PERMANENTE — antes de criar QUALQUER canal `.channel()`/
  `postgres_changes` novo, nesta ordem** (não é só mais um registro de bug,
  é o primeiro passo obrigatório, sempre, antes de debugar filtro/handler/
  RLS): **(1) a tabela está na publication `supabase_realtime`?**
  (`select tablename from pg_publication_tables where pubname =
  'supabase_realtime'` — ou `alter publication ... add table` em
  `db/schema.sql`). Sem isso o canal nunca dispara evento nenhum,
  independente de RLS/filtro/handler estarem certos — é sempre a primeira
  coisa a checar, nunca a última. (2) a policy de SELECT já cobre o que
  precisa ser lido (Realtime filtra pelas mesmas policies); (3) o handler
  do canal (e o polling de fallback) só chama o `carregar*()`
  correspondente quando a aba/view relevante estiver visível
  (`style.display !== 'none'`), senão gasta banda/consulta escondido.
  **Esse erro de publication (item 1) já se repetiu 4 VEZES neste
  projeto** — `localizacoes_entregador`/`alertas_seguranca` (item 5),
  `tentativas_despacho` (item 10), `pedidos`/`rotas_entrega` (item 17),
  `entrega_rota` (módulo feira, item 23/continuação — confirmado ao vivo:
  o `UPDATE` aconteceu no banco, nada chegou no client, porque a tabela
  simplesmente não estava na publication). Todo `carregar*()` que só roda
  uma vez no login (sem Realtime nem polling) é candidato a esse mesmo
  bug — perguntar explicitamente "isso precisa refletir mudança feita por
  fora da própria aba?" antes de aceitar uma tela como pronta.

## O que foi feito (em ordem)

**Histórico completo (itens 1 a 119) movido pra `CLAUDE-historico.md`
em 18/09/2026** — o arquivo principal tinha passado de 400k caracteres
(limite recomendado: 150k), quase todo ele esse log cronológico.
Consulte esse arquivo pra entender o contexto/motivo de qualquer item
específico anterior a hoje. Não é pré-requisito de leitura pra retomar
o trabalho — Arquitetura conhecida (acima) e Pendências reais no
momento (abaixo) já cobrem o estado atual.

Últimos itens, resumo rápido (detalhe completo no histórico):
- **Item 118** (06/09/2026): repasse automático via Subcontas Asaas +
  Split de Pagamento — aloca por orçamento (freelance primeiro),
  acerto manual do fixo pela loja. Nenhuma subconta real criada ainda
  (depende do usuário abrir na Asaas).
- **Item 119** (18/09/2026): vagas de entregador — loja publica vaga de
  vínculo fixo, entregador aceita e já vira fixo pro dia/período
  (`vagas_entregador` + `entregador_turno_fixo` + `aceitar_vaga_entregador()`).
  Testado (14/14), não testado no navegador ainda. Também achado nesse
  item: projeto Railway inteiro ficou Offline ~12 dias (trial
  expirado) — ver Pendências.

## Pendências reais no momento
- [ ] **URGENTE: trial do Railway expirou, motor de despacho real fora
      do ar (item 119, 18/09/2026)** — os 3 serviços
      (`dispatch-engine`/`feira-dispatch`/`osrm`) estão Offline há ~12
      dias. Ação do usuário: adicionar forma de pagamento e trocar pro
      plano Hobby em
      `https://railway.com/project/014bc898-408b-4e38-9b92-0137b7b605a2`
      (conta `davidrocha.analista@gmail.com`), depois pedir pra rodar
      `railway up -c` nos 2 serviços reais. Depois disso, **transferir
      o projeto inteiro pra `davidrocha.coitinho@gmail.com`** (decisão
      do usuário, unificar conta) — só pelo painel web, sem comando de
      CLI pra isso.
- [ ] **Vagas de entregador (item 119) não testado no navegador ainda**
      — só via `tests/vagas_entregador.test.js` (14/14). Testar de
      verdade em `painel-loja.html` (publicar/cancelar vaga) e
      `app-entregador.html` (ver/aceitar vaga de uma loja sem vínculo
      nenhum) assim que o motor voltar ao ar.
- [ ] **Vercel não faz deploy automático — convenção nova, igual já
      valia pro Railway** (achado no item 75, 02/09/2026): ficou **9
      dias sem publicar nada**, mesmo com vários `git push` no meio.
      Depois de qualquer push que toque `mockups/*.html`, rodar
      `cd mockups && vercel --prod --yes` manualmente — não confiar em
      deploy automático.
- [x] ~~Rastreio de posição/alertas de segurança só cobrem a rota "em foco"~~ —
      **corrigido no item 56** (27/08/2026): `enviarPosicao()` grava posição em
      todas as rotas ativas agora, não só a focada na tela.
- [ ] **OSRM self-hospedado bloqueado por plano do Railway** (item 43,
      26/08/2026) — `osrm-server/` pronto (Dockerfile + start.sh),
      serviço `girocerto-osrm` criado e pausado. Falta só o usuário
      adicionar forma de pagamento e mudar do plano Trial pro Hobby (ou
      superior) no Railway — o Trial trava volume em 500MB, o extrato
      sozinho já tem 816MB. Depois disso: aumentar o volume pra ~5GB
      (dashboard → serviço → Volume → Live Resize) e rodar `railway up -c`
      de dentro de `osrm-server/` pra retomar o pré-processamento. Depois
      de confirmado no ar, trocar a URL do OSRM em `app-entregador.html`
      (`tracarRota()`) e `rastreio-pedido.html` de
      `router.project-osrm.org` pra `girocerto-osrm-production.up.railway.app`.
- [x] ~~`geocodificar()` regeocodifica o MESMO endereço via Nominatim a
      cada 8s~~ — **resolvido no item 102 (04/09/2026)**: `resolverPonto()`
      usa `pedidos.lat`/`lng`/`tenants.lat`/`lng` (já conhecidos) direto,
      só cai pra Nominatim quando faltar. Testado: zero chamada ao
      Nominatim com lat/lng conhecidos, nem no load nem no ciclo de 8s.
- [x] ~~MFA (TOTP) — decisão de produto pendente antes de implementar~~ —
      implementado (item 44), opcional, "dispositivo confiável" via
      sessão persistida do Supabase. 2 achados reais corrigidos no
      processo (factor unverified travando reenroll; F5 no meio do login
      pulando o desafio) — ver item 44 pro detalhe.
- [x] ~~Cobrança via Pix aparecendo em rota da sessão feira~~ — não era bug:
      usuário esclareceu a regra de negócio (item 41) e o fluxo certo
      (feirante confirma recebimento do Pix da taxa de entrega) foi
      construído em `painel-feirante.html`. Pendência nova, real, que ficou
      explícita nessa conversa: **falta decidir/implementar o "sistema que
      direciona o entregador na hora da entrega se é Pix ou dinheiro"**
      pra taxa de entrega no modo feira (campo/UI novos na tela de
      confirmação de entrega do entregador) — não escopado nem construído.
- [x] ~~Unificação visual das 5 telas HTML na identidade oficial da
      marca~~ — **concluída** (ver item 28/41/45/46/48). Migradas:
      `painel-feirante.html` (41), `painel-loja.html` (45),
      `painel-admin.html` (46), `app-entregador.html` +
      `capacitor-www/index.html` (48) — sincronizados, ambos migrados
      juntos. `mockups/rastreio-pedido.html` também ajustada de brinde
      (mapa/marcador que tinham herdado cor antiga). Só
      `painel-dev.html` fica de fora — ferramenta interna, nunca virou
      prioridade.
- [x] ~~PRÓXIMO PASSO GRANDE — painel operacional completo em
      `painel-admin.html`~~ — fechado no item 27 (v1: entregadores
      aprovado/pendente/online/offline/disponível/ocupado/pausado, lojas
      ativa/inativa/painel aberto/recebendo pedido). Fora de escopo
      registrado (não implementado de propósito): enforcement de
      `habilitado=false` em qualquer lugar (dispatch engine, painel-loja),
      "recebendo pedido" comparado com histórico em vez de só 24h, e lista
      detalhada de entregadores (só a de lojas entrou na v1).
- [x] ~~`db/schema.sql`/migration do item 22 não commitados~~ — commitado
      (`c6e162d`) depois de confirmar que o repositório é PÚBLICO (checado
      via API do GitHub sem credencial nenhuma: `"private": false`).
      `mockups/painel-dev.html` ficou de fora do commit por decisão
      explícita do usuário exatamente por causa disso — adicionado ao
      `mockups/.gitignore`, roda só local.
- [x] ~~Módulo feira — criar `feira-dispatch/` e reescrever a parte do
      entregador em `app-entregador.html`~~ — feito (item 23), testado
      (122/122 + 9 testes standalone do módulo), ainda não commitado.
- [x] ~~Módulo feira — commit pendente~~ — commitado (`f3b5368`).
- [x] ~~Bônus de deslocamento até a feira não portado~~ — portado e
      testado (ver item 23).
- [x] ~~Sem failover pra "Recusar" oferta de feira~~ — implementado
      (`redespachar_apos_recusa_feira()`, ver item 23) e commitado. Cobre
      só recusa EXPLÍCITA — ver pendência de timeout logo abaixo, que
      continua real.
- [x] ~~O motor de despacho da feira não roda em lugar nenhum em
      produção~~ — **construído e testado no item 63 (28/08/2026)**,
      decisão revertida a pedido do usuário (agora: serviço Railway
      separado, não mesclar no `dispatch-engine/`). Ver item 63 pro
      detalhe completo. `feira-dispatch/worker.js` (novo) roda
      `despacharPedido()` automaticamente via LISTEN/NOTIFY real + os 3
      crons (`fecharRotasExpiradas`, `expirar_pedidos_pendentes`,
      `processarLote`) — testado de ponta a ponta local contra o banco
      hospedado (fixtures isoladas, limpas depois). **Deployado em
      produção** no serviço Railway novo `girocerto-feira-dispatch`
      (28/08/2026), confirmado `● Online` — rodando 24/7 de verdade.
- [ ] **TIMEOUT no despacho de feira — parcialmente coberto agora** (ver
      item 63): `fecharRotasExpiradas()` (rota `em_montagem` presa) e
      `expirar_pedidos_pendentes()` (pagamento pendente) já rodam via cron
      no worker novo. **Ainda falta**: `proposta_consolidacao` pendente
      (entregador nunca responde o card de "parada nova", item 24,
      22/08/2026) não tem função de expiração nenhuma no banco — não é só
      "faltava rodar o cron", a função em si não existe ainda. Decisão de
      produto pendente (o que fazer no timeout: reverter a proposta e
      redespachar, ou outra coisa) antes de escrever a função — fora do
      escopo do item 63 de propósito, pra não expandir demais.
- [x] ~~`PainelFeirante`/`DashboardFeirante` e `CheckoutConsumidor`~~ —
      **`PainelFeirante` deixou de ser pendência**: `painel-feirante.html`
      existe desde o item 41 e ganhou bastante corpo nesta sessão
      (itens 87/89/91 — cancelar pedido, catálogo de produtos, novo
      pedido manual, cadastro self-service). **`CheckoutConsumidor`
      virou decisão consciente de NÃO construir** (item 91, "aja como
      especialista"): usuário confirmou que o pedido chega por WhatsApp
      direto com o feirante, não por um app — um checkout de consumidor
      seria um produto novo desproporcional, sem necessidade real hoje.
- [~] **Wrapper Capacitor (push nativo FCM, som customizado, entregador)** —
      ver itens 29 e 31. `dispatch-engine/android/`, `capacitor-www/` e
      `capacitor.config.json` já commitados (item 31), estrutura toda
      coerente. Resumo do que falta agora:
      - [x] ~~`AndroidManifest.xml` sem `POST_NOTIFICATIONS`~~ — corrigido
        no item 29.
      - [x] ~~`FIREBASE_SERVICE_ACCOUNT_JSON` não setado no Railway~~ —
        setado no item 31, redeploy confirmado saudável. Só falta um push
        real pra confirmar que funciona de ponta a ponta (item abaixo).
      - [x] ~~Nunca testado de ponta a ponta num dispositivo/emulador
        real~~ — testado de verdade nos itens 32 e 33, no `RMX3941`
        (Realme) já registrado. Buzina corrigida: normalizada (tocava
        baixo demais), 20s, `USAGE_ALARM`, sem empilhar notificação, limpa
        a notificação ao resolver, repique autocorrige sozinho se resolver
        sem `NOTIFY` chegar (item 33 — cobre inclusive testar manualmente
        num tenant `is_teste=true` sem precisar chamar o endpoint de teste
        depois de cada aceite). Rota ativa na tela recebendo 2ª oferta:
        confirmado que o entregador ocupado não é ofertado de novo. Script
        `dispatch-engine/__pedido_teste.js` continua local, não commitado.
      - [x] ~~Sobreposição de som na transição de destravar a tela~~ —
        corrigido no item 33 (`tocarSom=false` no caminho do poll de
        segurança, que só recupera oferta perdida — o som via JS fica só
        pro caminho de Realtime, oferta genuinamente nova). Testado ao
        vivo replicando o cenário exato, sem sobreposição depois do fix.
      - [ ] **Tracking em BACKGROUND de verdade (app minimizado/tela
        bloqueada)** — texto corrigido (04/09/2026): a afirmação antiga
        de "zero permissão/zero plugin/zero código" estava desatualizada
        — `@capacitor/geolocation` (`^8.2.2`) está instalado,
        `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` estão no
        `AndroidManifest.xml`, e `iniciarRastreioPosicao()`
        (`app-entregador.html`) já pede permissão e rastreia via
        `watchPosition()` real, testado em dispositivo (`RMX3941`). O que
        genuinamente falta é só tracking com o app EM SEGUNDO PLANO/tela
        bloqueada — o rastreio atual só funciona com o app aberto em
        primeiro plano (sem `ACCESS_BACKGROUND_LOCATION`, sem plugin de
        background geolocation tipo `@capacitor-community/background-geolocation`,
        sem foreground service). Não avaliado se isso é necessário pro
        piloto (entregador normalmente mantém o app aberto pra navegação
        mesmo) — decisão de produto, não implementado agora.
      - [x] ~~Keystore de release + `signingConfig`~~ — feito (item 47),
        `gradlew assembleRelease` testado de ponta a ponta, APK assinado
        confirmado com `apksigner verify`. **Falta o usuário fazer backup
        do keystore/senha fora desta máquina** — ver item 47, não é algo
        automatizável.
      - [x] ~~Ícone do app ainda é o placeholder padrão do Capacitor~~ —
        feito (item 49), ícone adaptativo + legado gerados (fundo leaf,
        glifo marigold/paper), `gradlew assembleDebug` validado.
      - **Lembrete de config do aparelho** (achado no item 32, não é
        código): em aparelhos ColorOS/Realme/Oppo, o app precisa estar
        liberado em Configurações > Bateria > Gerenciamento de apps >
        Sem restrições, senão a tela bloqueando congela o processo
        (`OplusHansManager`) e o card para de aparecer até destravar.
- [x] ~~Loja e entregador caem no mesmo `Site URL` de fallback após confirmar
      e-mail~~ — corrigido no item 25 (`emailRedirectTo` explícito nos 2
      `signUp()`). Testado com `signUp()` real: o entregador cai certo em
      `app-entregador.html?loja=<tenant_id>`.
- [x] ~~BLOQUEIA fluxo de entregador real — sem UI pra aprovar~~ — resolvido
      no item 25, mas não do jeito que essa pendência previa: não é a LOJA
      quem aprova, é o ADMIN da plataforma, pelo `painel-admin.html` novo
      (produção, publicado). `painel-loja.html` continua sem nenhuma UI de
      aprovação — decisão de produto, não pendência.
- [x] ~~Auditoria de outros gaps latentes de Realtime/publication~~ —
      **feita no item 72 (02/09/2026)**. Achado real (4º caso do mesmo
      padrão): `carregarSolicitacoesSaque()` em `painel-loja.html` nunca
      reagia a nada — um entregador solicitando saque pelo PRÓPRIO app
      não aparecia pra loja sem F5 manual. Entrou no fallback de polling
      já existente. `painel-feirante.html` tinha Realtime mas sem rede de
      segurança de polling — adicionada, mesmo padrão de `painel-loja.html`.
      `painel-admin.html` revisado e descartado: falta de Realtime/polling
      ali é decisão consciente já documentada (item 27), não é gap novo.
- [x] ~~`dispatch-engine/` não está deployado no Railway ainda~~ — deployado em
      17/08/2026, validado com teste real de ponta a ponta contra o serviço publicado
      (ver item 15). `DATABASE_URL` corrigida (pooler modo sessão, porta 5432),
      `tentativas_despacho` sendo criada em produção de verdade, confirmado via
      `railway logs` (a linha real do evento de despacho, não só "conectado").
- [ ] Testar `db/schema.sql` num ambiente com mais RAM (ex: Supabase local em outra
      máquina) se algum dia for necessário comparar comportamento local vs hospedado —
      não é bloqueio, hospedado já cobre tudo.
- [ ] Nenhum teste de integração pendente no momento — cobertura completa de operações
      agora versionada em `tests/` (122 asserts, 9 áreas, incluindo o motor de despacho
      real como subprocesso), ver `tests/COBERTURA.md` pro detalhe item a item do que
      está coberto vs. pendência real (link público de rastreio, Pix). Rodar com
      `cd tests && npm install && node run-all.js` (precisa do `.env` na raiz e de
      `cd dispatch-engine && npm install` rodado ao menos uma vez).
- [ ] Gap de cobertura de Realtime mais amplo que só `tentativas_despacho` (que já foi
      corrigido no item 13): `localizacoes_entregador` e `alertas_seguranca` nunca
      tiveram a ENTREGA via canal Realtime testada na suíte versionada — só o resultado
      final via query direta. Isolamento multi-tenant do Realtime já foi validado com
      usuários reais em sessão anterior (script avulso, não preservado), mas a entrega
      em si não está coberta em `tests/`. Não é urgente (mecanismo já confirmado
      confiável pra `tentativas_despacho`, mesmo código de canal), mas fica registrado.
- [x] ~~Freelance multi-loja (mesma pessoa em 2+ tenants) não é suportado pelo schema
      atual~~ — **resolvido estruturalmente no item 52 (27/08/2026)**: schema separado
      em `pessoas_entregadoras` (identidade) + `entregadores` (vínculo por loja),
      `idx_entregadores_auth_user` removido, pool de despacho aberto pro freelance
      (não precisa mais de vínculo pré-existente pra receber oferta de qualquer loja),
      `solicitar_saque()` agrega repasses de todas as lojas da mesma pessoa (fecha
      também a implicação de pagamento que tinha ficado registrada aqui no item 51).
      Testado 19/19 contra o banco real. O que ainda falta, ver pendências novas
      abaixo: Fase 2 (limite de rotas simultâneas), painel-dev.html não atualizado,
      feira não re-verificada de ponta a ponta, staleness de lat/lng no restaurante.
- [x] ~~Fase 2 do item 52 — limite de rotas simultâneas~~ — **feita no item 54
      (27/08/2026)**: freelance até 3, fixo com o limite configurado pela loja
      (default 1). Ver item 54 pro detalhe completo.
- [x] ~~`painel-dev.html` não foi atualizado no item 52~~ — **corrigido no item 69
      (31/08/2026)**: eram 3 lugares quebrados, não 2 (achado um a mais: embed
      `entregadores(nome)` em `carregarPedidosDev()`). Validado com script de
      teste dedicado (sessão dev-admin real, RLS de verdade) — não commitado, o
      arquivo continua fora do repo por decisão do usuário (`mockups/.gitignore`).
- [x] ~~Módulo feira: matching não foi re-testado de ponta a ponta depois
      do item 52~~ — **testado de verdade no item 89 (03/09/2026)**:
      feira geocodificada real (endereço de verdade), 3 bancas, 2
      entregadores freelance (`tenant_id=null`/`aceita_feira=true`,
      mesmo modelo do item 76), 3 pedidos pro mesmo cliente lançados via
      `criar_pedido_manual_feirante()`. Rodei `routeManager.despacharPedido()`
      de verdade (não simulado) — resultado: 2 pedidos com o mesmo
      destino foram CONSOLIDADOS automaticamente na mesma rota, o 3º
      abriu rota nova com o outro entregador. `buscar_entregador_mais_proximo()`
      e a lógica de consolidação (`encontrarMelhorInsercao`) confirmadas
      funcionando corretamente pós-item-52.
- [x] ~~Staleness de `lat/lng` no despacho de restaurante~~ — **investigado e
      corrigido no item 73 (02/09/2026)**. Achado bem mais sério do que a
      pendência original supunha: **não era só a feira** que fazia a
      atualização e o restaurante que ficava sem — `atualizar_localizacao_entregador()`
      nunca era chamada por NENHUM código real (só pelo router morto do
      item 62/63) — os DOIS motores rankeavam candidato com dado
      congelado desde o cadastro. `enviarPosicao()` em `app-entregador.html`
      agora chama a RPC sempre, inclusive quando o entregador só está
      'disponível' (sem rota ativa ainda) — antes só gravava posição
      durante entrega em andamento.
- [x] ~~Validar capacidade do `dispatch-engine/` em volume real de loja estabelecida
      (20.000–35.000+ pedidos/mês, ~1.000/dia)~~ — **testado no item 61 (28/08/2026)**.
      Resultado: latência de despacho excelente sob pressão sustentada (p50 0,96s,
      p95 1,43s, máx 2,03s), memória do processo estável (~215MB, sem sinal de
      vazamento em 5min). 1 achado real, raro (2/279 pedidos, 0,7%): ver item 61
      pro detalhe — não bloqueia o piloto, mas fica registrado pra investigar se
      reaparecer em volume maior.
- [ ] `.env` local tem as credenciais do projeto Supabase hospedado
      (`ntmxkwzhumiqspxijuln`) — nunca comitar, já está no `.gitignore`.
- [x] ~~`railway down` sem religar depois já causou 33h de produção
      offline sem ninguém perceber~~ — **mitigado no item 66 (30/08/2026)**:
      regra nativa do Railway (`railway.com/account/notifications` →
      "All Projects → Deployment Removed → Email & In-App") avisa por
      e-mail agora sempre que um deploy for removido, cobrindo os 2
      serviços do GiroCerto. Rotina de nuvem do item 65 (não funcional,
      bloqueada por rede) desabilitada.
- [ ] **Conta Railway no plano Trial, saldo/prazo expirando** (achado no
      item 66, 30/08/2026) — painel mostra "7 days or $4.06 left ·
      Upgrade to keep your services online." Não é pendência técnica, é
      decisão de negócio do usuário (fazer upgrade de plano) — registrado
      pra não passar despercebido, já que se o saldo acabar o próprio
      Railway pode derrubar os serviços de produção.
- [x] ~~Resíduo de teste no módulo feira~~ — **limpo no item 71 (02/09/2026)**,
      confirmado com o usuário antes. Removidos em cascata na ordem certa
      (`pedido_nota` → `pedido`/`pedido_item` → `pedido_grupo` →
      `feira_ocorrencia`/`feira_ocorrencia_excecao` → `feira` →
      `produtos` → `estabelecimentos` → `usuarios` →
      `entregadores`/`pessoas_entregadoras`). Achado no caminho: os `auth.users`
      correspondentes não foram removidos (as linhas de negócio já tinham
      sido apagadas antes de eu pensar em capturar `auth_user_id` pra
      limpar o auth também) — inofensivo (credencial órfã sem nada ligado),
      não vale a pena caçar retroativamente. Verificação final: 0 linhas
      restantes em todas as tabelas checadas.
- [x] ~~3 nits do `/ultrareview` de 14/08/2026~~ — **fechados no item 68
      (31/08/2026)**. `pin_integracoes_hash` era exposto via SELECT normal de
      `usuarios_loja` pra QUALQUER funcionário do tenant (achado real: RLS é
      por linha, não por coluna — a policy de SELECT existente deixava
      qualquer colega ler o hash do PIN do dono, explorável direto pela API
      sem UI nenhuma) — movido pra `usuarios_loja_pin`, tabela sem NENHUMA
      policy, só as 3 funções SECURITY DEFINER tocam. `set_pin_integracoes()`
      agora exige o PIN atual pra trocar um já existente. Comentário
      desatualizado ("RLS entra na Fase 2") corrigido. Migration aplicada no
      banco hospedado, 20/20 em `integracoes.test.js` (com cobertura nova).
- [x] ~~`calcular_segundos_parado` não foi re-testado com `iniciada_em` real~~ —
      **coberto no item 70 (31/08/2026)**: teste dedicado em `tests/seguranca.test.js`
      (31/31) — confirma o corte (leitura antes de `iniciada_em` não conta pro
      platô), o cálculo do tempo parado, o alerta `motoboy_parado` disparando via
      trigger de verdade, e o caso negativo (entregador se movendo não gera alerta).
- [x] ~~Link público de rastreio pro cliente final~~ — construído (item 42),
      `mockups/rastreio-pedido.html` + 2 RPCs SECURITY DEFINER, testado ao vivo
      com a chave anon de verdade. Ainda falta o disparo automático do envio do
      link (WhatsApp) pro `cliente_telefone` quando o pedido entra em `a_caminho`
      — a página existe e funciona, mas hoje precisa do link ser copiado/enviado
      manualmente; ninguém envia isso pro cliente sozinho ainda.
- [ ] **Integração real de Pix (transferência automática de repasse)** —
      **atualizado 06/09/2026 (item 118)**: arquitetura de Subcontas
      Asaas + alocação por orçamento (freelance > fixo) + acerto manual
      do fixo está TODA implementada e testada (260/260 na suite). Falta
      só o lado operacional: abrir a conta master Asaas (precisa ser
      CNPJ — pessoa física não cria subconta), passar pelo período de
      avaliação regulatória de 60 dias (teto de 10 subcontas/R$2000 por
      subconta até liberar volume maior — rollout tem que começar com
      piloto pequeno), e criar de fato a 1ª subconta real pra alguma
      loja piloto. Mercado Pago **não tem** endpoint público de PIX-OUT
      pra chave de terceiro (confirmado por pesquisa) — continua stub,
      só sai dessa situação com contato comercial direto. Stone ainda
      não foi pesquisada. Alternativas pesquisadas (Iugu/Efí/Cora) têm
      mais fricção que Asaas pro caso de uso. Ver itens 109-118 acima
      pro detalhe completo (arquitetura + achados da pesquisa + testes).
- [x] ~~Reteste real do fluxo de cadastro (item 16) antes do piloto valer pra
      valer~~ — feito em 18/08/2026 depois do rate limit resetar (ver item
      18). `signUp()` real + e-mail confirmado de verdade, PII limpa com
      sucesso. Único resíduo (`email_verified: true`, fora da janela de 2min)
      foi avaliado e aceito como decisão consciente — não é PII, não bloqueia.
- [ ] Estado de failover/timeout do motor de despacho vive em memória do processo —
      não sobrevive a um restart no meio de uma janela de espera (a reconciliação de
      startup cobre pedidos órfãos e tentativas já expiradas, mas não timers "no meio
      do caminho"). Aceitável pra um piloto de 2-3 lojas, documentado em
      `dispatch-engine/README.md`, não é bloqueio.
- [x] ~~Tentativa aceita/recusada com o NOTIFY de `tentativa_despacho_respondida`
      perdido nunca é reprocessada~~ — **corrigido no item 67 (31/08/2026)**.
      `agendarRepique()` agora chama `tratarRespostaDespacho()` de verdade quando
      descobre que uma tentativa já resolveu sem o NOTIFY avisar (antes só parava
      o repique). Guard de idempotência (`tentativasProcessadas`) fecha a janela
      de um NOTIFY atrasado (não perdido) chegando depois. Ganho de brinde:
      `reconciliarNaSubida()` ganhou `retomarRotasSemTentativaAberta()` — cobre
      o caso relacionado de o processo cair bem no meio de um failover (rota
      `planejada` sem nenhuma tentativa aberta nem timer sobrevivente). Commit
      `ce97527`, 160/160 testes.

**Pendências novas reveladas na sessão de 02-04/09/2026 (itens 74-91):**
- [ ] **Integração com plataforma de delivery externa (iFood/99/Rappi)** —
      bloqueio real pro cancelamento de pedido em rota (item 85) chegar
      de verdade. Depende do usuário: cadastro comercial + credenciais
      de API em cada plataforma, não é trabalho de código. Pesquisado
      (item 85): iFood tem uma API específica pra operador logístico
      terceirizado, "Entrega Fácil" — parece o encaixe mais direto pro
      papel do GiroCerto (não precisa virar PDV/cardápio completo).
      Rappi exige contato comercial direto pra aprovação. O código já
      está pronto do lado de dentro (reage a `pedidos.status='cancelado'`),
      só falta a integração de verdade escrever nesse campo.
      **Atualizado 05/09/2026 (item 109)**: painel-loja.html → Integrações
      já tem os campos de credencial (iFood Client ID/Secret, 99Food e
      Rappi API key), cifrados em repouso — só armazenamento, nenhuma
      chamada de API real ainda. Falta a mesma coisa de sempre: conta de
      parceiro em cada plataforma antes de escrever o receptor de
      webhook/polling de verdade.
- [ ] **Provedor de SMS não configurado** — bloqueia envio de código de
      verificação por SMS (item 88 pediu como alternativa à senha).
      Precisa contratar um provedor (Twilio ou equivalente) e configurar
      no Supabase Auth. Senha já implementada como alternativa que não
      depende disso.
- [ ] **Redesenho estilo 99 (itens 79-80 cobriram só telas 2 e o mapa)** —
      telas 1/3/5/6/8 do pedido original continuam sem construir:
      - Tela 1 ("aceitar N pedidos de uma vez"): motor de despacho do
        restaurante nunca agrupa pedidos numa oferta só (sempre 1
        pedido = 1 rota nova) — bundling exigiria mudar lógica de
        negócio do motor, fora do escopo que o usuário definiu pra
        telas. Decisão de produto pendente antes de tocar nisso.
      - Tela 3 (foto do estabelecimento): sem coluna nem bucket pra
        armazenar.
      - Tela 5 (expresso, "entregar em N minutos"): sem campo de SLA/
        prazo em `pedidos` — não tem de onde tirar o "N minutos".
      - Tela 6 (chat): sem tabela de mensagens nenhuma no schema.
      - Tela 8 (navegação turn-by-turn própria): reverte decisão de
        produto já tomada no item 37 (deep link Waze/Maps, sem mapa
        próprio).
- [x] ~~`repasses` de freelance multi-loja só mostra a loja "mais
      recente" na tela de Saque~~ — **resolvido no item 104 (04/09/2026)**:
      a decisão de produto "agregar entre lojas" já tinha sido tomada
      (mesmo critério de `solicitar_saque()`, item 52) — só a tela nunca
      foi atualizada. `.eq('entregador_id', entregadorId)` removido da
      query, RLS já agrega certo. Teste novo em `financeiro.test.js`.
- [ ] **Cancelamento de pedido de feira continua sem gatilho real** (item
      85/87) — mesmo com o botão "Cancelar pedido" no painel do
      feirante (item 87) fechando o ciclo tecnicamente, o módulo feira
      inteiro ainda não está em produção real (só os 2 serviços Railway
      rodando 24/7, mas sem volume de pedido real ainda) — dependência
      dupla, não é só "falta código".
- [x] ~~Cancelamento de pedido em rota, lado restaurante, sem teste em
      dispositivo real~~ — **testado no item 92** (04/09/2026): cenário
      real no celular do usuário, card/modal apareceu corretamente via
      Realtime/poll; achado (sem som, por `AudioContext` suspenso) já
      corrigido no mesmo item.

**Incidente de processo (03-04/09/2026, deploy do item 82-91):** `railway
up -c -s girocerto-feira-dispatch` retornou status "killed" no processo
local (CLI parou de streamar logs), o que pareceu indicar falha — mas o
deploy do lado do Railway continuou e terminou com sucesso. Confirmado
via 3 sinais independentes antes de seguir em frente: `railway status
--json` mostrando o `activeDeployments[0].id` batendo com o ID do build
log mais recente + timestamp mais novo que o deploy anterior;
`instances[0].status: "RUNNING"`; e `railway logs` mostrando a linha de
boot nova (`"...escutando pedido_grupo_pronto e pedido_grupo_cancelado_em_rota"`,
texto que só existe no código pós-item-85). **Lição pra próximas
sessões**: o status do processo local do `railway up` (completed/killed)
não é confiável sozinho pra confirmar deploy — sempre confirmar via
`railway logs`/`status --json` + healthcheck antes de declarar sucesso,
não só o exit code do CLI.

## Convenções de trabalho estabelecidas
- Nunca commitar nem dar push sem instrução explícita "commit e push", mesmo depois de
  fechar uma tarefa grande.
- Nunca mexer em configuração do git (`user.name`/`user.email`) — pedir pro usuário
  rodar via prefixo `!`.
- Nunca instalar/alterar software ou configuração de sistema que exija admin (Docker,
  WSL2, features do Windows) — só investigar/diagnosticar e reportar, deixando a ação
  que precisa de elevação para o usuário executar.
- Testes de integração devem bater num banco real (Supabase/Postgres de verdade), não
  mocks — convenção herdada do Torre, vale igual aqui assim que houver banco disponível.
- Testes de integração agora são versionados em `tests/` (desde o PR #1) — mudança
  consciente da convenção anterior ("scripts ficam só no scratchpad, não fazem parte
  do produto"), por pedido explícito do usuário. Scripts avulsos de verificação pontual
  (ex: conferir uma migração específica) continuam podendo ficar no scratchpad; a
  suíte que cobre operações do produto de forma duradoura vai em `tests/`.
- Antes de aceitar o resultado de um teste (próprio ou de um agente/fork), abrir e ler
  o código do teste, não só o resumo — a sessão do PR #1 achou 2 bugs nos próprios
  scripts de teste (comparação de tipo errada, id errado numa FK) que geravam "achados"
  falsos; um deles inclusive tinha o rótulo invertido ("BUG CONFIRMADO" custando exame
  quando na verdade o comportamento estava correto).
- **Antes de rodar `despacho_motor.test.js` (ou qualquer teste que dispare
  `pedido_pronto` de verdade), pausar o motor de despacho do Railway primeiro**
  (`railway down -y` → roda o teste → `railway up -y -c` — `down` remove a
  deployment record, então `redeploy` sozinho não acha nada; precisa de `up`
  de novo) — produção e teste local compartilham o MESMO banco hospedado (não
  existe staging), então o motor de produção intercepta os eventos que o
  teste local dispara e corrompe as asserções. Sempre confirmar
  `railway status`/`railway logs` mostrando online e escutando antes de seguir
  em frente, pra minimizar o tempo fora do ar.
- **O CLI do Railway mantém um link salvo por diretório, mas ele fica "grudado" no
  último serviço linkado explicitamente — não confiar nisso quando o projeto tem mais
  de 1 serviço** (achado real, item 67, 31/08/2026: `railway down` rodado de dentro de
  `dispatch-engine/` derrubou o `girocerto-feira-dispatch` por engano, porque o link
  tinha ficado preso no último `railway link` feito pra feira). Sempre rodar
  `railway link -p <project> -e <env> -s <service>` explícito logo antes de qualquer
  `down`/`up`/`status` num projeto multi-serviço, e passar `--service <nome>` como
  segurança extra nos comandos que aceitam a flag.
- **`.env` local: usar sempre o pooler do Supabase (`aws-0-us-east-2.pooler.supabase.com:5432`),
  nunca o host direto (`db.<ref>.supabase.co`)** — achado real, item 67 (31/08/2026): o
  host direto só resolve em IPv6, e essa máquina/rede tem rota IPv6 instável
  especificamente pra ele (`ETIMEDOUT` repetido em vários testes ao longo de toda a
  sessão — itens 61/62/65 — provavelmente a causa raiz de boa parte da flakiness de
  conexão pg direta documentada). O pooler (IPv4, o MESMO que o Railway já usa em
  produção) conectou de primeira, sem falha nenhuma, em todas as rodadas depois da
  troca. Se testes locais voltarem a falhar com `ECONNRESET`/`ETIMEDOUT` numa conexão
  `pg` direta, checar isso primeiro antes de assumir instabilidade geral do Supabase.
- **`signUp()` real (não `admin.createUser`) consome o rate limit de e-mail do
  Supabase** (free tier) — depois de poucas confirmações reais numa mesma
  sessão, novas tentativas retornam `429 email rate limit exceeded` (bloqueia
  inclusive tentativas via navegador, não só scripts). Não fica claro o tempo
  exato de reset. Ao testar fluxos de `signUp()` real, economizar tentativas
  (ex: usar `admin.createUser` + manipulação direta de `created_at`/campos via
  SQL pra simular cenários que não precisam do e-mail de verdade, reservando
  `signUp()` real pros casos que realmente exigem provar o fluxo ponta a
  ponta).
- **Migração de schema que MOVE uma coluna (ex: de `entregadores` pra
  `pessoas_entregadoras`, item 52) precisa de um grep pela coluna em TODO
  o `db/schema.sql`, não só nos pontos que a própria migração já sabe que
  toca.** Achado real, 2 vezes na mesma migração: `gerar_repasse_ao_entregar()`
  (item 55) e depois `aceitar_rota()`/`finalizar_rota_se_completa()` (item
  59) continuaram escrevendo na coluna antiga — `entregadores.status` —
  meses depois de ela deixar de existir, e nenhuma delas apareceu na nota
  do item 52 que listava "os pontos afetados" (a lista foi montada de
  memória/contexto, não por busca exaustiva). As duas só foram achadas
  porque um teste real EXERCITOU o caminho de código específico (o item
  55 só apareceu num teste sustentado que chegava até confirmar entrega
  de verdade; o item 59 só apareceu no primeiro teste real que levava uma
  oferta de feira até o aceite — o módulo feira nunca tinha rodado em
  produção). Lição: depois de qualquer `alter table ... drop column`/
  renomeação, rodar `grep -n "nome_da_coluna" db/schema.sql` (ou
  equivalente) contra o arquivo INTEIRO antes de considerar a migração
  completa, não confiar só na lista de "pontos afetados" que a sessão
  lembra de cabeça — módulos pouco exercitados (sem CI, sem uso em
  produção, como o de feira) são exatamente onde esse tipo de breakage
  fica invisível por mais tempo.
- **`signInAs()` (password grant real) em sequência rápida bate no rate
  limit de auth do Supabase por volta da 49ª chamada** (achado no teste
  de carga de 50 entregadores, item 60) — limite diferente do rate limit
  de e-mail do `signUp()` já documentado acima. Ao criar muitos
  entregadores/usuários de teste que precisam de sessão RLS de verdade,
  espaçar as chamadas (ex: ~400ms entre elas) e ter retry com backoff
  pronto pro erro "Request rate limit reached". Se parte dos
  entregadores nunca vai precisar de sessão própria (ex: um fluxo
  100% orientado a RPC/service role, sem UI de cliente ainda — era o
  caso do lado entregador do módulo feira), pular `signInAs()` pra esse
  grupo também ajuda a ficar longe do limite.
- **Scripts de teste avulsos que rodam mais que ~2-3 minutos: preferir o
  client Supabase-JS via PostgREST (`admin.from(...)`) a uma conexão
  `pg.Client` direta segurada por muito tempo** (achado no teste de
  capacidade do item 61, 28/08/2026) — a conexão direta morreu 2 de 3
  vezes nesta máquina no meio de uma rodada de 5-8min ("Client has
  encountered a connection error and is not queryable", sem reconexão
  automática, perdendo a rodada inteira incluindo o cleanup). O caminho
  PostgREST/HTTPS (o mesmo que o próprio `dispatch-engine/` usa em
  produção) ficou estável por HORAS na mesma máquina/sessão. Pra setup
  rápido (poucos segundos, muitas inserções em sequência) a conexão
  direta continua rápida e prática — o risco é especificamente em
  scripts que mantêm a MESMA conexão aberta por vários minutos.

## REGRA DE ATUALIZAÇÃO

Ao final de cada sessão de trabalho — quando o usuário disser algo como "por hoje é
só", "vamos parar por aqui", "encerra por hoje" ou equivalente — atualize este arquivo
antes de encerrar, cobrindo:

1. **O que foi feito nesta sessão**: desde 18/09/2026, o log cronológico completo
   ("O que foi feito", itens 1-119) mora em `CLAUDE-historico.md`, não mais aqui —
   isso foi feito porque o arquivo principal tinha passado de 400k caracteres. Ao
   fechar uma sessão: (a) adicione o novo item numerado (continuando a numeração)
   em `CLAUDE-historico.md`, com o mesmo nível de detalhe de sempre; (b) atualize o
   resumo curto "Últimos itens" na seção "O que foi feito" AQUI no `CLAUDE.md`
   principal, trocando pelo(s) item(ns) mais recente(s) — 2-3 linhas por item,
   suficiente pra próxima sessão saber que existe e ir consultar o histórico se
   precisar do detalhe. Nunca deixe o log completo crescer de novo neste arquivo.
2. **O que ficou pendente**: atualizar a lista "Pendências reais no momento" — marcar
   itens concluídos, remover o que deixou de ser relevante, adicionar pendências novas
   que a sessão revelou.
3. **Decisões de arquitetura importantes**: se alguma decisão consciente foi tomada
   nesta sessão (ex: escolher uma abordagem em vez de outra, adiar algo
   deliberadamente, descartar uma solução), registrar isso na seção de arquitetura ou
   como uma pendência explicitamente marcada como "decisão consciente".

O objetivo é que a próxima sessão comece lendo este arquivo e já saiba onde a anterior
parou, sem que o usuário precise reexplicar contexto do zero. Sempre editar este
arquivo diretamente (Edit/Write) como parte do encerramento da sessão — não é opcional
nem depende de o usuário pedir explicitamente naquele momento, pedir pra encerrar já
implica pedir essa atualização.
