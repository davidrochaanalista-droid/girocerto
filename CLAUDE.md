# GiroCerto — Status do Projeto

## Visão geral
Plataforma de logística de motoboy pra lojas locais (restaurantes, açaiterias,
padarias etc.), com foco em reduzir o ciclo ocioso do entregador (espera na loja +
volta vazia). Os 3 mockups HTML estáticos (`cadastro-loja.html`, `painel-loja.html`,
`app-entregador.html`) falam DIRETO com Supabase via `@supabase/supabase-js`
(conectados ao projeto hospedado real desde 15/08/2026) e continuam sem build
step/SPA. **Hospedados publicamente na Vercel desde 18/08/2026** (ver item 19) —
antes disso nunca tiveram hospedagem nenhuma, só rodavam localmente via
`python -m http.server`:
- Cadastro da loja: https://girocerto-mockups.vercel.app/cadastro-loja.html
- Painel da loja: https://girocerto-mockups.vercel.app/painel-loja.html
- App do entregador: https://girocerto-mockups.vercel.app/app-entregador.html
  (o entregador chega aqui via link com `?loja=<tenant_id>`, copiado do painel
  da loja — não existe link fixo público pra essa tela)

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
- **REGRA GERAL — Realtime "ao vivo" em `painel-loja.html`/`app-entregador.html`
  precisa de 3 coisas, não só de escrever o canal**: (1) a tabela estar na
  publication `supabase_realtime` (`alter publication ... add table`, ver
  `db/schema.sql`) — sem isso o canal nunca dispara evento nenhum,
  independente de RLS estar certa; (2) a policy de SELECT já cobrir o que
  precisa ser lido (Realtime filtra pelas mesmas policies); (3) o handler do
  canal (e o polling de fallback) só chamar o `carregar*()` correspondente
  quando a aba/view relevante estiver visível (`style.display !== 'none'`),
  senão gasta banda/consulta escondido. **Esse exato gap (item 1) já se
  repetiu 3 vezes** — `localizacoes_entregador`/`alertas_seguranca` (item 5),
  `tentativas_despacho` (item 10), `pedidos`/`rotas_entrega` (item 17). Ao
  adicionar QUALQUER `.channel()`/`postgres_changes` novo num mockup, checar
  a publication ANTES de assumir que vai funcionar, não descobrir testando
  ao vivo sem F5. Todo `carregar*()` que só roda uma vez no login (sem
  Realtime nem polling) é candidato a esse mesmo bug — perguntar
  explicitamente "isso precisa refletir mudança feita por fora da própria
  aba?" antes de aceitar uma tela como pronta.

## O que foi feito (em ordem)
1. Inicialização do projeto — duas versões soltas de mockups/schema foram comparadas e
   consolidadas na mais recente/correta de cada arquivo, `git init` local, primeiro
   commit `abd2a7e`.
2. PDF de todo o conteúdo (`GiroCerto-conteudo-completo.pdf`, via Playwright).
3. Análise profunda de mercado (`ANALISE_MERCADO_E_TORRE.md`/`.pdf`) — comparação com
   concorrentes reais (Foody Delivery, InstaDelivery, Entregador Online, Wappa, Loggi
   Expresso, Lalamove) e cruzamento com o Torre pra padrões reaproveitáveis.
4. Prompt consolidado de correções (Parte A + Parte B), todo aplicado em
   `db/schema.sql`, `mockups/app-entregador.html`, `mockups/painel-loja.html` e
   `README.md`:
   - **A1** `verificacao_prazo_limite` deixou de ser coluna gerada (erro `42P17`,
     `timestamptz + interval` não é IMMUTABLE) — app agora calcula e grava
     `verificacao_enviada_em + 7 dias` no cadastro.
   - **A2** `codigo_retirada`/`codigo_entrega` ganharam índice único parcial + trigger
     `BEFORE INSERT` com retry (até 50 tentativas) pra evitar colisão dos 4 dígitos.
   - **A3** README corrigido (RLS é real desde o início, não "Fase 2"); auditoria
     encontrou `tentativas_despacho` fora do bloco de RLS — corrigido.
   - **A4** comentários em `motivo_reprovacao`/`motivo_cancelamento` documentando que
     são TEXT único (não array).
   - **B1** rastreio real de posição (`navigator.geolocation.watchPosition`) em
     `app-entregador.html`, ativo durante turno ativo, gravando em
     `localizacoes_entregador`.
   - **B2** Supabase Realtime (`postgres_changes`) + polling de segurança (15s) em
     `painel-loja.html`, alimentando banner de alertas e posição ao vivo dos
     entregadores.
   - **B3+B4** detecção de "motoboy parado" (`segundos_parado_alerta`, tenant-
     configurável, default 180s) e "desvio de rota" (exige 2+ leituras consecutivas
     fora da rota) — ambos como triggers `SECURITY DEFINER` em
     `localizacoes_entregador`, porta do `computeStalledSeconds()` do Torre.
   - **B5** aba "Relatórios" implementada (`carregarRelatorios()`).
   - **B6** nearest-neighbor guloso (`ordenarParadasPorProximidade()`) pra ordenar
     paradas de uma rota — não há fluxo de criação de rota em nenhum mockup ainda,
     então só a função pura foi entregue, sem inventar UI nova.
   - Fora de escopo, registrado só como TODO (decisão consciente): link público de
     rastreio pro cliente, seguro do entregador, chat in-app, precificação dinâmica
     (risco explícito de contradizer a promessa de previsibilidade), ETA por IA
     (prematuro sem rastreio ao vivo consolidado), **gamificação/ranking de
     entregadores — decisão consciente de NÃO implementar**, contradiria o "Selo
     Entrega Justa"; placa/Renavam pra bike elétrica/ciclomotor (monitoramento
     regulatório, sem ação imediata).
5. **Banco real subiu e schema validado pela primeira vez** (14/08/2026). Docker local
   não coube na máquina (só 3.8GB de RAM total — `supabase start` derrubava depois de
   puxar as 12 imagens, timeout de health check em serviços concorrentes; ver
   "decisão consciente" abaixo). Optamos por Supabase hospedado (plano grátis, projeto
   `ntmxkwzhumiqspxijuln`) — credenciais em `.env` local (gitignored, nunca commitado).
   `db/schema.sql` (agora ~1290 linhas) aplicado com sucesso via script Node com `pg`
   (sem precisar de `psql` nem `supabase link`, que exige token de conta).
   **Achados reais, todos corrigidos no próprio `db/schema.sql` (fonte de verdade) e
   reaplicados no banco hospedado**:
   - **Recursão infinita em RLS** (crítico, derrubava a aplicação inteira): toda policy
     que dependia de `usuarios_loja` (16 policies) fazia subselect cru na própria tabela
     — corrigido com funções `SECURITY DEFINER` (`minhas_tenant_ids()` etc, ver
     "Arquitetura conhecida" acima).
   - **`cadastro-loja.html` quebrava 100% das vezes** no cadastro de loja nova: o
     `.insert().select()` em `tenants` falhava por RLS (ver "Arquitetura conhecida").
     Corrigido gerando o `id` no cliente.
   - **Auto-vínculo sem convite** em `usuarios_loja`: qualquer autenticado conseguia
     virar "funcionário" de qualquer tenant alheio. Corrigido restringindo a insert ao
     primeiro vínculo do tenant, só como `dono` (não havia fluxo real de funcionário
     pra quebrar).
   - **Motoboy nunca lia a config de fadiga do próprio tenant**: join
     `entregadores -> tenants` em `app-entregador.html` sempre voltava `null` (RLS de
     `tenants` só cobre `usuarios_loja`), caía em silêncio pro padrão hardcoded 8h/8h.
     Corrigido com RPC estreita `config_fadiga_do_meu_tenant()` (só os 2 campos, nunca
     CPF/Pix/etc do tenant).
   - **Realtime nunca funcionaria em produção**: a publication `supabase_realtime`
     estava vazia (nenhuma tabela habilitada) — independente de RLS, os canais de
     `painel-loja.html` nunca disparariam evento nenhum. Corrigido adicionando
     `localizacoes_entregador`/`alertas_seguranca` à publication.
   - `search_path` fixado (`public, pg_temp` ou `public, extensions, pg_temp` pras que
     usam `pgcrypto`) em TODAS as 7 funções `SECURITY DEFINER` do schema — vetor de
     escalonamento de privilégio via schema injection, achado que não veio de teste
     funcional, foi pedido explícito de revisão de segurança.
   - Achado documentado, não corrigido: freelance "multi-loja" não é suportado hoje —
     `idx_entregadores_auth_user` é único por `auth_user_id` (1 conta = no máximo 1
     linha em `entregadores`, nunca 2 tenants simultâneos pra mesma pessoa). Fica pra
     decisão de produto futura se isso for virar prioridade.
   **Auditoria B2 (isolamento do Realtime) RESOLVIDA, sem vazamento**: testado com 2
   lojas autenticadas de verdade, canais `postgres_changes` SEM `filter` (exatamente
   como `painel-loja.html` já faz) em `localizacoes_entregador` e `alertas_seguranca` —
   RLS nativa do Realtime isolou corretamente nos dois casos. A correção preventiva
   cogitada (tenant_id desnormalizado + filter) **não é necessária**, conforme o próprio
   critério já registrado aqui ("só implementar se o teste confirmar vazamento").
   **Todos os testes de integração pendentes rodaram contra o banco real** e passaram:
   constraints/defaults, RLS multi-tenant (2+ usuários reais), A1 (prazo = enviada_em +
   7 dias exatos, view `entregadores_verificacao_vencida` certa nos 3 casos), A2 (retry
   de código sob 40 inserts concorrentes reais — 1 colisão real aconteceu no teste, é o
   caso raro já documentado no próprio schema, índice único pegou certo), view
   `selo_entrega_justa` (5 cenários: ativo, volume baixo, média baixa, sem
   infraestrutura, janela de 30 dias), funções de PIN (dono define/verifica, funcionário
   não consegue nem ler nem escrever), cenário de carga (3 tenants, 6 entregadores, 45
   pedidos concorrentes multi-tenant, failover real de despacho, repasse batendo com
   entrega). Scripts de teste ficaram só no scratchpad da sessão (não fazem parte do
   produto, não foram commitados).
   **Decisão consciente**: Docker/Supabase local abandonado nesta máquina (3.8GB RAM
   total é fisicamente insuficiente pra rodar a stack completa de 12 serviços) — o
   projeto passa a depender de Supabase hospedado pra qualquer teste de integração
   futuro nesta máquina.
6. **`/ultrareview` na branch master rodado e 6 achados corrigidos** (14/08/2026),
   nesta ordem de prioridade (segurança/regressão primeiro, depois fluxos quebrados,
   depois o resto):
   - **XSS armazenado** (`painel-loja.html`: `carregarPedidos`, `renderizarAlertasBanner`,
     `carregarRotas`, `carregarMotoboys`; `app-entregador.html`: `montarRota`) —
     `cliente_nome`/`endereco`/`entregadores.nome` iam direto pra `innerHTML`, e
     `app-entregador.html` ainda montava um `onclick` por concatenação de string (quebrava
     com apóstrofo em endereço, ex: "Rua d'Ávila"). Corrigido com um helper `escapeHtml()`
     em cada mockup + troca do `onclick` inline por `data-*` e `addEventListener`
     delegado.
   - **`supabase/migrations/20260813000000_initial_schema.sql` estava obsoleto**: era
     uma cópia pré-auditoria (sem os 4 helpers `SECURITY DEFINER`, sem `search_path`, sem
     a policy restrita de `usuarios_loja`, sem a publication do Realtime) — `supabase db
     push`/`db reset` reintroduziria todos os bugs já corrigidos no item 5. Corrigido
     sincronizando o arquivo com `db/schema.sql` (cópia integral — os dois arquivos são
     idênticos agora; `db/schema.sql` continua sendo a fonte de verdade editada
     primeiro).
   - **`alertas_seguranca` sem policy de UPDATE pra loja**: "Confirmar OK"/"Escalar" no
     painel batiam contra RLS, filtravam pra 0 linhas em silêncio (sem erro do
     PostgREST) — o alerta nunca saía de `aguardando_confirmacao`. Corrigido com a
     policy `"loja resolve alertas dos seus entregadores"` (mesmo predicado da policy de
     SELECT já existente); `resolverAlerta()` no painel agora também loga `error` em vez
     de engolir silenciosamente.
   - **`pedidos` sem policy nenhuma pro entregador**: `app-entregador.html` sempre via a
     rota com 0 paradas, e `confirmarEntrega()` quebrava com null deref. Corrigido com
     policy de SELECT (escopo `rota_id -> rotas_entrega -> entregadores.auth_user_id`) e
     UPDATE com `WITH CHECK (status = 'entregue')` — restringe à única transição que o
     app realmente faz, não abre brecha pra reverter/cancelar via update direto.
   - **`calcular_segundos_parado` contava a espera na loja como "motoboy parado"**: o
     walk pra trás não recortava por `rotas_entrega.iniciada_em`, então o platô de
     espera normal na loja (o próprio ciclo ocioso que o produto ataca) virava alerta de
     segurança assim que a rota entrava em `em_entrega`. Corrigido filtrando por
     `registrado_em >= iniciada_em` nas duas consultas da função.
   - **Fluxo de pausa do motoboy era um beco sem saída**: `clicarPausar()` nunca setava
     `turnos.teve_pausa`, então o gate de fadiga sempre disparava no finalize
     independente de quantas pausas o motoboy tivesse feito; e não existia botão pra
     "despausar" (`checarTurnoAtivo()` só olhava `turnos.status`, nunca
     `entregadores.status`). Corrigido: `clicarPausar()` agora grava `teve_pausa=true`;
     botão "Continuar" novo, visível quando `entregadores.status='pausado'`, chama
     `clicarContinuar()` que volta pra `disponivel`.

   **Deploy + testes reais**: as mudanças de policy/função foram aplicadas no Supabase
   hospedado (`ntmxkwzhumiqspxijuln`) via script Node/`pg`, e um novo lote de 18 testes
   de integração rodou contra o banco real antes do commit — cobrindo especificamente
   RLS multi-tenant nas policies novas (SELECT/UPDATE de `pedidos` por entregador,
   UPDATE de `alertas_seguranca` por loja, isolamento cross-tenant sob concorrência) e
   um cenário de carga (3 tenants, 45 inserts concorrentes de pedidos sem colisão de
   `codigo_entrega`, confirmações de entrega simultâneas de 6 entregadores + tentativas
   cross-tenant concorrentes bloqueadas). 18/18 passou. Script ficou só no scratchpad da
   sessão (não commitado), tenants/usuários de teste removidos ao final (cascade).

   Os 6 achados corrigidos viraram 5 commits atômicos no `master`: XSS (finding #5),
   sync da migration + gaps de RLS em `alertas_seguranca`/`pedidos` (#2, #6),
   `calcular_segundos_parado` (#1), fluxo de pausa + error-logging (#4), e a
   atualização deste arquivo.
7. **2ª rodada de `/ultrareview`** (14/08/2026), validando os 5 commits acima como um
   todo. 3 achados; só 1 era acionável hoje:
   - **Corrigido**: a policy `"entregador confirma entrega das suas rotas"` (item 6, on
     `pedidos`) tinha `WITH CHECK (status = 'entregue')` sem rechecar posse de
     `rota_id` — como `WITH CHECK` substitui o `USING` pra validar a linha resultante,
     um UPDATE direto via PostgREST (fora da UI) podia trocar o `rota_id` do próprio
     pedido pra qualquer rota alheia (inclusive de outro tenant) junto com a
     confirmação de entrega. Corrigido reincluindo a mesma condição de posse de
     `rota_id` dentro do `WITH CHECK`. Testado contra o banco real: confirmação
     legítima continua funcionando, reatribuição pra rota de outro tenant agora é
     bloqueada.
   - **Não corrigido, registrado como limitação conhecida** (decisão consciente,
     escolha explícita do usuário: só corrigir o achado acionável, não construir
     feature nova pra validar os outros dois): o fix de `calcular_segundos_parado`
     (item 6) depende de `rotas_entrega.iniciada_em`, que nenhum mockup escreve hoje —
     fica inerte até existir motor de despacho de verdade (mesmo estado de
     "adiantado em relação ao app" que o resto do subsistema de segurança já tem: o
     próprio trigger só avalia quando `rotas_entrega.status = 'em_entrega'`, que
     também não é setado por nenhum mockup). `clicarContinuar()` em
     `app-entregador.html` sempre volta `entregadores.status` pra `'disponivel'` sem
     lembrar o status anterior à pausa — inofensivo hoje porque `status` só transita
     entre `offline/disponivel/pausado` no app atual (os status de rota em progresso
     nunca são setados em lugar nenhum ainda); só vira risco real quando o despacho
     de verdade existir.
8. **PR #1 — "Pente fino de mercado + teste real de todas as operações"** (14/08/2026),
   primeira vez usando branch + Pull Request nesta sessão (`pente-fino-mercado-e-teste-
   operacoes` → `master`) em vez de commitar direto — 5 commits, mergeado com sucesso
   (merge commit `c58980f`). Duas frentes independentes, rodadas em paralelo:
   - **Parte A** — `ANALISE_MERCADO_AVANCADA.md`: continuação de
     `ANALISE_MERCADO_E_TORRE.md`, cobrindo fontes novas (Reclame Aqui, blogs de
     engenharia DoorDash/iFood, literatura acadêmica, regulamentação emergente —
     Califórnia AB-578, votação federal —, mercados fora do Brasil). 5 diferenciais
     potenciais priorizados por esforço x defensabilidade de marca; 3 fontes-chave
     conferidas manualmente antes de aceitar o documento.
   - **Parte B** — `tests/`: suíte de testes de integração REAL versionada no projeto
     (desvio consciente da convenção anterior de scripts avulsos em scratchpad — pedido
     explícito do usuário), organizada por área (onboarding, pedido, despacho,
     financeiro, seguranca, reputacao, lgpd, integracoes), 90 asserts, todos passando
     contra o Supabase hospedado. `tests/COBERTURA.md` documenta item a item o que já
     estava coberto antes, o que é novo, e o que ficou pendência por depender de feature
     inexistente. A rodada de background que gerou a suíte bateu no limite de sessão da
     conta no meio do trabalho e deixou 3 tenants + 11 usuários de teste órfãos no banco
     hospedado — limpos manualmente antes de continuar. Dois bugs nos PRÓPRIOS scripts
     de teste foram achados e corrigidos antes de confiar no resultado (comparação de
     `count(*)` como string em vez de `Number()`; `aprovado_por` recebendo
     `auth.users.id` em vez de `usuarios_loja.id`, violando a FK) — lição: sempre abrir
     e ler o código do teste antes de aceitar um "achado", não só o resumo.
   - **Achado real corrigido**: `tentativas_despacho.entregador_id` sem
     `ON DELETE CASCADE` (diferente de `rota_id`, que já tinha) — apagar um tenant
     travava com FK violation assim que um entregador tivesse tentativa de despacho
     registrada. Corrigido, deployado no banco hospedado, verificado com reprodução
     real.
   - **Achado testado e decidido**: `selo_entrega_justa` não escopa por tenant sob RLS
     — a hipótese inicial (avaliacoes_loja sem policy de SELECT quebraria a view pra
     loja) foi testada e REFUTADA; o comportamento real é o oposto (funciona pra
     qualquer dono, de qualquer tenant). Usuário confirmou que é intencional (selo
     público) — documentado com comentário SQL na view (ver "Arquitetura conhecida"
     acima), não corrigido.
   - **Pendência nova, não corrigida**: `bloqueado_ate` (bloqueio de fadiga) só é
     enforced no client (`iniciarTurno()` em `app-entregador.html`) — um insert direto
     em `turnos` via RLS ignora o bloqueio. Registrado, não corrigido nesta rodada.
   - PR aberto e mergeado via navegador (Chrome automation) — `gh` CLI não está
     instalado nesta máquina; usado o fluxo `compare/new PR` do GitHub direto.
9. **Resolução de pendências conhecidas + avaliação de go-to-market** (15/08/2026).
   Prompt cobria 4 pendências (`bloqueado_ate`, reprovação automática, link de
   rastreio, motor de despacho) e pedia avaliação de ordem/dependência antes de codar.
   - **Avaliação de dependência**: `bloqueado_ate` e reprovação automática são
     totalmente independentes do motor de despacho (fixes isolados em `turnos`/
     `entregadores`); só o link de rastreio depende de verdade do despacho (pra
     posição ao vivo). Resolvidos os dois independentes primeiro.
   - **Avaliação honesta de go-to-market** (pergunta direta do usuário: dá pra colocar
     em 2-3 lojas reais agora?): **NÃO**, com evidência concreta levantada nos
     mockups, não suposição — `marcarPronto()` em `painel-loja.html` não dispara
     nada (sem motor de despacho, tudo seria manual); `app-entregador.html` não tem
     NENHUMA UI pra receber/aceitar oferta de entrega (zero referências a
     `tentativas_despacho` no arquivo); `app-entregador.html` tem `TENANT_ID` fixo
     hardcoded (`'COLE_AQUI_O_ID_DO_TENANT'`) — só serve 1 loja por cópia do arquivo,
     sem seleção de loja; Pix é decorativo (`<div class="qr-placeholder">`, sem
     nenhuma chamada de API); as 3 páginas têm credenciais Supabase placeholder
     nunca substituídas pelas reais. A fundação de dados (RLS, segurança, testes) está
     genuinamente sólida — o que falta é a camada operacional.
   - **Corrigido — `bloqueado_ate` agora enforced no banco**: policy antiga `FOR ALL`
     em `turnos` foi dividida em SELECT/UPDATE/DELETE (só posse) + uma policy de
     INSERT dedicada que também nega se `entregadores.bloqueado_ate` está no futuro.
     UPDATE de turno já existente (pausar/finalizar) não é afetado — só abrir turno
     NOVO trava. Testado: bloqueado rejeitado, bloqueio expirado passa, nunca
     bloqueado passa.
   - **Corrigido — reprovação automática por documento vencido**: função
     `verificar_documentos_vencidos()` agendada via `pg_cron` (hora em hora, extensão
     confirmada disponível no plano gratuito hospedado) reprova CNH/CRLV vencidos —
     inclusive quem já estava `aprovado` antes (documento pode vencer depois da
     aprovação). Só afeta `tipo_veiculo='moto'` (bicicleta não tem essas colunas de
     validade). Aviso prévio 15 dias antes (`cnh_alerta_enviado_em`/
     `crlv_alerta_enviado_em`), não repete, reseta ao renovar o documento (trigger
     `trg_resetar_alerta_documento`). Entrega do aviso: só banner in-app em
     `app-entregador.html` (`carregarEntregador()`) — WhatsApp/push real fica
     pendente de `integracoes.whatsapp_*`, que não tem nenhuma chamada de API ainda.
     Nova view `view-reprovado` em `app-entregador.html` (antes, reprovado e
     em_avaliacao mostravam a mesma mensagem "aguarde 7 dias", enganoso agora que
     reprovação pode acontecer automaticamente sem ação humana visível).
   - **Investigação de infra pro motor de despacho** (decisão de arquitetura, não
     construído ainda — ver "Pendências" abaixo): `LISTEN/NOTIFY` testado de ponta a
     ponta contra a conexão direta do Supabase hospedado, confirmado confiável (5/5,
     ~135ms, sobrevive a ociosidade) — viável pro backend Node/Express no Railway que
     o motor de despacho vai precisar. `pg_cron` também confirmado disponível (já
     em uso pela reprovação automática acima).
   - Testes novos em `tests/seguranca.test.js` (bloqueado_ate, 3 cenários) e
     `tests/onboarding.test.js` (reprovação automática, 7 cenários) — suíte total
     agora em 100/100. `tests/COBERTURA.md` atualizado.
10. **"Implemente tudo que for necessário" — escopo expandido de go-to-market**
    (15/08/2026, mesmo dia, sessão seguinte). Instrução direta do usuário: não plano,
    implementação de verdade dos 5 itens abaixo, sem parar pra aprovação. Cada peça
    confirmada no código real antes de mexer (grep/read, não suposição) — ver histórico
    de tool calls da sessão se precisar reconstituir o "antes" exato.
    - **Credenciais Supabase reais** nas 3 páginas — troca de `SEU-PROJETO`/
      `SUA_CHAVE_ANON_AQUI` pela URL e anon/publishable key reais do projeto hospedado.
      Anon key é segura por design pra embutir client-side (RLS é a fronteira real,
      não o segredo da chave) — só a service_role key e a DATABASE_URL nunca vão pro
      client (ficam em `dispatch-engine/` e nos scripts de deploy).
    - **`TENANT_ID` hardcoded corrigido**: `app-entregador.html` agora lê o tenant de
      `?loja=<uuid>` na URL (com fallback `localStorage` pra quem já cadastrou uma vez)
      em vez de uma constante fixa no arquivo. `painel-loja.html` (aba Entregadores,
      antes vazia — "essa tela ainda não foi construída") ganhou um campo com o link
      pronto pra copiar e compartilhar com motoboys.
    - **`tenants.lat`/`lng` adicionados** (pré-requisito descoberto, não pedido
      originalmente): sem isso, `raio_chamada_motoboy_km` não tinha como ser calculado
      pelo motor de despacho. Geocodificar `endereco_loja` exigiria contratar um
      provedor externo (mesma categoria de dependência do Pix) — resolvido SEM
      terceiro, via geolocalização do próprio navegador (botão em `painel-loja.html`,
      mesmo mecanismo já usado em `entregadores`). Nullable — motor de despacho trata
      `null` como "sem geofiltro", não bloqueia.
    - **Pix confirmado 100% decorativo e isolado, NÃO implementado** (decisão
      correta, não corte de escopo): confirmado por grep completo que nenhuma chamada
      de API de pagamento existe em lugar nenhum do projeto. `confirmarEntrega()` não
      depende de `pago=true` — o fluxo de entrega já é independente de pagamento hoje,
      então plugar Pix depois não exige mudar mais nada. Isolado em comentário nos 2
      pontos de contato (`app-entregador.html` e `painel-loja.html`). O que falta
      decidir (produto, não técnico): provedor (`mercado_pago`/`asaas`/`stone`/`outro`
      já são as opções no schema), contratar a conta, e onde a geração do QR
      Code/webhook roda (`dispatch-engine/` é o candidato natural).
    - **Motor de despacho real, construído e testado** — `dispatch-engine/`, serviço
      Node/Express separado (arquitetura já prevista nos comentários do próprio
      schema desde antes de existir código: "o backend Node.js usa a service_role
      key"). `LISTEN pedido_pronto` / `LISTEN tentativa_despacho_respondida` via
      triggers novas em `db/schema.sql` (`notificar_pedido_pronto`,
      `notificar_resposta_despacho`) — conexão DIRETA do Supabase hospedado (não o
      pooler transacional, que reciclaria a conexão do listener). Busca entregador
      `disponivel` mais próximo (Haversine) dentro do raio, cria `tentativas_despacho`,
      timeout configurável por tenant, failover por recusa OU por timeout (exclui
      candidatos já tentados, nunca relaxa o raio), atribui a rota ao aceitar
      (`entregadores.status='a_caminho_da_loja'`). Reconciliação no startup (pedidos
      `'pronto'` órfãos, tentativas expiradas sem resposta) — estado de failover/timeout
      vive em memória do processo, não sobrevive a restart no meio da janela (limitação
      documentada em `dispatch-engine/README.md`, não escondida). Nova trigger
      `concluir_rota_ao_entregar` fecha o ciclo: pedido `'entregue'` → rota
      `'concluida'` + entregador de volta a `'disponivel'`, automaticamente.
    - **UI de oferta de entrega + confirmar retirada** em `app-entregador.html`: modal
      "nova entrega disponível" via Realtime em `tentativas_despacho` (tabela
      adicionada à publication `supabase_realtime`, que antes só tinha
      `localizacoes_entregador`/`alertas_seguranca`), aceitar/recusar escrevendo
      direto via a mesma policy RLS que já existia (`entregador ve e responde suas
      proprias tentativas`) — só faltava a UI, não a permissão. Banner de "confirmar
      retirada" quando `rota.status='a_caminho_da_loja'`, populando
      `rotas_entrega.iniciada_em` de verdade pela primeira vez.
    - **Testado de ponta a ponta contra o Supabase hospedado real**, incluindo o
      `dispatch-engine/` rodando como processo de verdade (subido, testado, derrubado,
      resubido pra provar a reconciliação) — não simulado. `tests/despacho_motor.test.js`
      versiona esse teste (sobe o serviço via `child_process.spawn`). Suíte total: 90 →
      **109/109**. `tests/COBERTURA.md` atualizado com seção própria de go-to-market.
    - **Achado de consequência, não corrigido, sinalizado com prioridade elevada**:
      as duas limitações dormentes do item 7 (2ª rodada do ultrareview) estavam
      "inertes até existir motor de despacho real" — agora ele existe. `calcular_segundos_parado`
      deve estar ativo de verdade agora (`iniciada_em` é populado pelo fluxo real) mas
      não foi re-testado nesta sessão especificamente. **`clicarContinuar()` virou
      risco real, não mais teórico**: ele sempre reseta `entregadores.status` pra
      `'disponivel'`, mas agora `a_caminho_da_loja`/`em_rota` são estados reais que o
      motor de despacho usa — se um entregador pausar no meio de uma entrega em
      andamento e apertar "Continuar", ele aparenta `'disponivel'` de novo pro motor de
      despacho enquanto ainda está com uma entrega em mãos. Ver pendências abaixo.
11. **Fix do achado do item 10** (15/08/2026, mesmo dia): `clicarContinuar()`
    corrigido. `entregadores` ganhou a coluna `status_antes_pausa`; duas funções SQL
    novas, `pausar_entregador()`/`retomar_entregador()`, fazem a leitura+escrita
    ATÔMICA (`set status_antes_pausa = status, status = 'pausado'` numa única
    instrução) — evita corrida com o motor de despacho escrevendo
    `entregadores.status` no mesmo instante (ex: aceite de oferta concorrendo com o
    clique de pausar). `clicarPausar()`/`clicarContinuar()` em `app-entregador.html`
    passaram a chamar essas RPCs em vez de `update()` direto. Testado contra o motor
    de despacho REAL (não simulado): entregador forçado pra `em_rota`, pausado,
    confirmado que NENHUMA `tentativas_despacho` nova chega pra ele mesmo com pedido
    pronto no mesmo tenant, retomado, confirmado que volta pra `em_rota` (não
    `disponivel`). 5 novos asserts em `tests/despacho_motor.test.js` — suíte total
    109 → **114/114**.
12. **2ª rodada de `/ultrareview`, contra o `dispatch-engine/` novo** (16/08/2026).
    15 achados, todos verificados manualmente antes de corrigir (não é achismo em
    cima do resumo do agente), todos corrigidos e retestados — ver
    `tests/COBERTURA.md` pra tabela completa achado-por-achado. Destaques:
    - **Crítico**: RLS bloqueava o modal de "nova oferta" de ler a rota/pedido ANTES
      do aceite — a UI de oferta inteira (item 10) ficaria muda em produção real,
      apesar de todos os testes anteriores passarem (eles escreviam o aceite direto,
      nunca exercitavam essa leitura). **Corrigir isso introduziu, na hora, o mesmo
      tipo de recursão infinita de RLS (42P17) já documentado neste arquivo pra
      `usuarios_loja`** — só que agora entre `rotas_entrega` e `tentativas_despacho`
      — resolvido com o mesmo padrão já estabelecido: função `SECURITY DEFINER`
      (`rotas_com_tentativa_para_mim()`) em vez de subselect cru. **Lição
      reforçada**: qualquer policy nova que faça subselect numa tabela que TAMBÉM
      tem policy fazendo subselect de volta cria esse risco — não é exclusividade de
      `usuarios_loja`, é uma classe geral de problema.
    - **Segurança**: os 2 bypasses do `bloqueado_ate` (a policy de UPDATE em
      `entregadores`/`turnos` não tinha `WITH CHECK` nenhum — um entregador bloqueado
      podia limpar o próprio campo ou reviver um turno finalizado via update direto,
      contornando completamente a policy de INSERT que o item 11 tinha construído).
      2 triggers novas fecham isso.
    - **Regressão do próprio item 11**: o trigger `concluir_rota_ao_entregar` (criado
      nesta mesma sessão) resetava `status='disponivel'` sem checar se o entregador
      tinha pausado no meio da entrega — reintroduzindo, num lugar diferente, o
      exato bug que o `status_antes_pausa` do item 11 tinha acabado de fechar. Guard
      simples resolveu.
    - **Achado colateral, durante o debug**: um processo `dispatch-engine` órfão
      de um teste manual anterior (nunca encerrado corretamente) ficou escutando
      `LISTEN/NOTIFY` em paralelo com o processo do teste novo, causando um
      resultado que parecia bug de concorrência real (2 tentativas pro mesmo
      pedido). Diagnosticado via `tasklist`/`wmic` antes de mexer em qualquer
      código — lição prática: sempre matar processos de teste em background
      explicitamente, `run_in_background`/spawns manuais não se limpam sozinhos.
    - 6 races de concorrência reais no `dispatch-engine/index.js` (criação
      duplicada de rota, dupla atribuição no aceite, timeout sobrescrevendo
      resposta real, reconexão duplicada do listener, vazamento de memória em rota
      esgotada, mesmo entregador recebendo 2 ofertas simultâneas) — todas
      corrigidas trocando SELECT-depois-UPDATE por UPDATE...WHERE atômico com
      checagem de linhas afetadas, mesmo princípio das RPCs do item 11.
    - `tests/seguranca.test.js` tinha um teste de pausar/retomar que usava
      `.update()` direto em vez das RPCs reais — reescrito pra exercitar o código
      de produção de verdade.
    - Suíte: 114 → **120/120**.
13. **Confirmações pedidas antes de commitar a rodada acima** (16/08/2026, mesmo
    dia). 4 pontos, todos verificados — ver `tests/COBERTURA.md` pro detalhe:
    - `rotas_com_tentativa_para_mim()` confirmada estruturalmente idêntica ao
      padrão `minhas_tenant_ids()` (mesmo em produção: `security definer`,
      `stable`, `set search_path = public, pg_temp`) — não uma variante ad-hoc.
    - Regra geral sobre recursão de RLS entre duas tabelas documentada acima em
      "Arquitetura conhecida" (não só no changelog).
    - Auditoria de "teste passa mas testa o caminho errado" em toda a suíte:
      achou 2 casos novos do mesmo padrão do achado #1 (`config_fadiga_do_meu_tenant()`
      nunca testada via `.rpc()`; nenhum teste da suíte inteira assinava um canal
      Realtime de verdade — só confirmava resultado final via query direta).
      Ambos corrigidos. Confirmado que as outras RPCs (PIN, pausar/retomar,
      confirmar retirada) já estavam testadas do jeito certo.
    - Confirmado, via `tasklist`, que não sobrou processo `dispatch-engine`
      órfão antes de qualquer commit — um desses órfãos (de um teste manual
      anterior nesta mesma sessão) chegou a produzir um resultado que parecia
      race condition real durante o debug do achado #1; diagnosticado antes de
      mexer em código, não depois.
    - Suíte final: 120 → **122/122**.
14. **Deploy do `dispatch-engine/` no Railway + verificação pós-deploy — deploy OK,
    validação FALHOU** (17/08/2026). Projeto Railway `girocerto-dispatch-engine`
    (project ID `014bc898-408b-4e38-9b92-0137b7b605a2`), serviço
    `girocerto-dispatch-engine` (service ID `e124fea3-47c1-484e-b56c-1ded3b14fae9`,
    deployment ID `530fe9c4-66e3-4c61-805d-dbcbb5070d05`, região `sfo`), com as 3 env
    vars configuradas. Build passou, container sobe, `railway logs` mostra
    `[listener] conectado — escutando pedido_pronto e tentativa_despacho_respondida`
    e `[http] healthcheck em http://localhost:8080/health` — mas isso NÃO significa
    que o LISTEN/NOTIFY funciona de verdade em produção (exatamente o motivo de não
    aceitar "buildou" como prova).
    - **Restart policy confirmada OK**: `railway status --json` mostra
      `restartPolicyType: "ON_FAILURE"`, `restartPolicyMaxRetries: 10` — reinicia
      sozinho em caso de crash.
    - **Teste real de ponta a ponta contra o serviço PUBLICADO (não o processo
      local)**: confirmado antes via `tasklist` que nenhum `node.exe` local estava
      rodando (mesmo cuidado do achado de processo órfão da rodada anterior, pra não
      mascarar o resultado). Criado tenant + entregador dentro do raio + pedido
      `status='pronto'` direto no Supabase hospedado real. Esperado 8s, consultado
      `tentativas_despacho` — **nenhuma tentativa foi criada**. `railway logs`
      (`--since 5m`, `--since 30m`, `--lines 100`) não mostrou NENHUMA linha nova
      correspondente ao evento — nem log de oferta, nem erro, nem reconexão. Serviço
      seguiu `RUNNING`/`Online` o tempo todo.
    - **Causa raiz identificada**: `railway variables` mostra `DATABASE_URL` apontando
      pro **pooler transacional do Supabase** (`aws-0-us-east-2.pooler.supabase.com:6543`,
      pgbouncer modo transaction), não pra conexão direta
      (`db.ntmxkwzhumiqspxijuln.supabase.co:5432`, a mesma usada no `.env` local e já
      documentada como obrigatória pro listener — ver item 10 e comentário no próprio
      `dispatch-engine/README.md`). Pooler em modo transaction recicla a conexão de
      backend entre transações, o que quebra sessões `LISTEN` persistentes — explica
      exatamente o sintoma: conecta e loga "conectado" (o comando `LISTEN` em si roda
      numa transação que sucede), mas nunca recebe os `NOTIFY` disparados depois, sem
      erro nenhum (falha silenciosa, não crash).
    - **Não corrigido nesta sessão, por instrução explícita** ("se algo não funcionar,
      não tente contornar ou simular — reporte o erro real... e pare"). A correção en
      si é conhecida (trocar a variável `DATABASE_URL` no Railway pra apontar pra porta
      5432 direta, não 6543) mas é uma mudança de configuração em infraestrutura de
      produção — fica pra o usuário decidir/autorizar.
    - Dado de teste limpo ao final (`cleanup()` padrão, tenant + auth user removidos,
      confirmado sem resíduo).
15. **Re-teste pós-correção: motor de despacho VALIDADO em produção no Railway**
    (17/08/2026, mesmo dia). A `DATABASE_URL` no Railway foi corrigida (porta 6543 →
    5432, ainda no host do pooler Supavisor — modo sessão, que fixa a conexão de
    backend por sessão em vez de reciclar por transação, ao contrário do modo
    transação da porta 6543; suficiente pra LISTEN/NOTIFY funcionar, diferente da
    conexão direta usada localmente, mas equivalente pro efeito que importa aqui).
    Novo deployment automático (`87d6efab-64bb-4176-826e-ceb739c8ad1e`), `railway
    logs` confirmou startup limpo (`[listener] conectado...`). Repetido o MESMO teste
    real do item 14 (nenhum processo local rodando, confirmado via `tasklist` antes e
    depois; tenant + entregador dentro do raio + pedido `status='pronto'` direto no
    Supabase hospedado): dessa vez `tentativas_despacho` foi criada em ~1.7s, e
    `railway logs` mostrou a linha real do evento —
    `[despacho] pedido <id> -> oferecido ao entregador <id> (tentativa <id>)` — com os
    MESMOS IDs da linha criada no banco (não só "conectado" nos logs, que por si só
    não prova nada, como já tinha acontecido no deploy anterior que falhou em
    silêncio). Dado de teste limpo ao final, confirmado 0 resíduo no banco hospedado.
    **O motor de despacho está de fato rodando e funcional em produção agora.**
16. **Roteiro de teste manual pré-piloto — achado crítico real de cadastro,
    corrigido e commitado** (17-18/08/2026). Pedido inicial: preparar um roteiro
    passo a passo pro usuário testar os 3 mockups como loja + entregador reais,
    antes de convidar a primeira loja. Mockups servidos localmente via
    `python -m http.server 8080` (não há hospedagem nenhuma configurada pros
    mockups em si — só o `dispatch-engine/` está no Railway).
    - **Achado crítico, nunca pego pelos 122 testes**: reproduzindo `signUp()`
      real (não `admin.createUser`) com e-mail descartável real, confirmado que
      TANTO `cadastro-loja.html` QUANTO `app-entregador.html` quebravam com
      `42501` (RLS) logo após o cadastro — ver "Arquitetura conhecida" acima
      pro porquê. Bug real, não achismo: reproduzido ao vivo antes de reportar.
    - **Corrigido sem desativar a confirmação de e-mail** (decisão explícita do
      usuário): 2 triggers novos em `auth.users`, ver "Arquitetura conhecida":
      `provisionar_cadastro_pos_signup()` (`AFTER INSERT`, cria
      `tenants`+`usuarios_loja`+`horarios_funcionamento` ou `entregadores` a
      partir de `options.data` do `signUp()`) e
      `limpar_metadata_apos_provisionamento()` (`AFTER UPDATE`, limpa a PII que
      o GoTrue reintroduz na 2ª escrita). O 2º trigger passou por 2 rodadas de
      revisão do usuário antes de aprovado: 1ª rodada corrigiu 3 ajustes
      (índices únicos pro `ON CONFLICT` — já existiam —, comentário sobre
      idempotência real, limpeza de PII); 2ª rodada endureceu a condição do
      `WHEN` — proteção explícita contra loop (`OLD` vs `NEW`), condição
      específica de janela de tempo (2min desde `created_at`, não só "não está
      vazio" — evita apagar uma atualização legítima futura de metadata) e
      documentação da garantia de ordem de execução (Postgres, não corrida).
    - **Upload de documentos movido pra depois do primeiro login** (upload pro
      Storage também exige sessão, mesma trava): telas novas "completar
      cadastro" em `painel-loja.html` (banner + 2 arquivos) e
      `app-entregador.html` (view dedicada, campos variam por
      `tipo_veiculo`), usando as policies de UPDATE que já existiam.
    - **Achado operacional colateral**: o motor de despacho do Railway
      (produção, item 15) e o `despacho_motor.test.js` local competem pelo
      MESMO banco hospedado (não existe staging separado) — o motor de
      produção intercepta os `pedido_pronto` que o teste local dispara,
      corrompendo as asserções (mesma classe de sintoma do achado de processo
      órfão do item 12, mas entre produção e teste local, não 2 processos
      locais). Protocolo estabelecido: `railway down -y` antes de rodar
      `despacho_motor.test.js`/`run-all.js`, `railway up -y -c` (ou
      `railway redeploy` se a deployment record ainda existir — `down` remove
      a record, `redeploy` sozinho não acha nada pra redeployar depois disso)
      logo depois, confirmando `railway status`/`railway logs` antes de seguir.
    - **Validado**: suíte 122/122 (2x, uma vez por rodada de revisão) com
      Railway pausado; roteiro manual completo do fluxo de LOJA com `signUp()`
      real via navegador (Mailinator — inbox pública descartável, sem
      necessidade de conta), e-mail de confirmação recebido e confirmado de
      verdade (clique real no link), login, upload dos 2 documentos, banner
      sumindo, tudo confirmado no banco (`tenants`/`usuarios_loja`/
      `horarios_funcionamento` corretos, `raw_user_meta_data` vazio). Proteção
      de janela de tempo do 2º trigger testada nos dois sentidos via
      `admin.createUser` + `created_at` manipulado (sem depender de e-mail):
      dentro da janela limpa, fora da janela preserva um update legítimo
      simulado.
    - **Fluxo de entregador não testado manualmente nesta sessão** (decisão do
      usuário — piloto desta semana começa só pelo fluxo de loja; o link
      `?loja=` fica pronto no banco mas sem divulgação nenhuma por enquanto),
      mas coberto pela suíte automatizada.
    - Commitado (`6653431`, branch `master`), **não** dado push. `db/schema.sql`
      e `supabase/migrations/20260813000000_initial_schema.sql` re-sincronizados
      como sempre.
    - **Pendência real, não decisão consciente**: o Supabase (free tier) tem
      rate limit de envio de e-mail — depois de várias confirmações reais
      nesta sessão, `signUp()` real passou a retornar
      `429 email rate limit exceeded`, bloqueando um reteste completo de ponta
      a ponta (signUp real + clique real no e-mail) contra a versão FINAL
      (pós-2ª-revisão) do 2º trigger. A evidência aceita como suficiente pra
      commitar foi: suíte 122/122 + verificação isolada da janela de tempo
      (não depende de e-mail) + dedução lógica de que o comportamento real já
      comprovado (rodada anterior, trigger menos restrito) continua batendo
      com a condição nova (que só ADICIONA condições `AND`, não afrouxa
      nenhuma). Ver pendência abaixo — reteste real fica pendente pra antes do
      piloto valer pra valer.
17. **Teste operacional de ponta a ponta contra Railway+Supabase reais — achado
    crítico do painel, corrigido no mesmo dia** (18/08/2026). Pedido: percorrer
    o ciclo completo (pedido chega → preparo → pronto → despacho → aceite →
    retirada → entrega) na tela real de `painel-loja.html`, contra o motor de
    despacho de PRODUÇÃO no Railway (não um processo local) — sem nenhum
    entregador real cadastrado ainda (link `?loja=` não divulgado), então um
    entregador de teste foi criado direto no banco (já aprovado, pra não
    depender do link). Confirmado antes: **não existia tenant real da
    hamburgueria no banco** (tabela `tenants` vazia) — resolvido criando um
    tenant de teste dedicado, claramente marcado (`[TESTE] ... NAO USAR`), sem
    misturar com nada real.
    - **Ciclo completo funcionou de ponta a ponta**: pedido criado via UI →
      Recebido → Aceitar → Em preparo → Marcar pronto (`pedido_pronto` real) →
      motor do Railway despachou (log real com os mesmos IDs do banco) →
      aceite do entregador de teste via RLS real (mesma escrita do app) →
      `confirmar_retirada_rota()` → posição gravada → entrega confirmada →
      trigger `concluir_rota_ao_entregar` fechou o ciclo sozinho (rota
      `concluida`, entregador `disponivel`). Delay do despacho: poucos
      segundos.
    - **Achado crítico, bloqueante pro piloto**: o painel operacional **não
      era "tempo real" pra pedidos e rotas**, só pra motoboys.
      `carregarMotoboys()` já tinha Realtime (`localizacoes_entregador`) +
      polling de 15s — funcionava ao vivo de verdade. `carregarRotas()` e
      `carregarPedidos()` **não tinham Realtime nem polling nenhum** — só
      carregavam uma vez no login ou após ação feita na própria aba.
      Reproduzido 3x seguidas (aceite, retirada, entrega): todas as 3
      aconteceram de verdade no banco, mas a UI continuou mostrando o status
      antigo até um F5 manual. Um funcionário da loja veria a tela parada
      enquanto pedidos são processados de verdade por trás.
    - **Corrigido no mesmo padrão já usado em `carregarMotoboys()`**: (1)
      `pedidos` e `rotas_entrega` adicionadas à publication
      `supabase_realtime` (mesmo achado de causa raiz dos itens B2/go-to-
      market — tabela fora da publication, Realtime nunca dispara
      independente de RLS); (2) canais `pedidos-ao-vivo`/`rotas-ao-vivo` em
      `iniciarAtualizacoesAoVivo()`, chamando `carregarPedidos()`/
      `carregarRotas()` quando a aba correspondente (`mv-pedidos`/
      `mv-operacional`) está visível; (3) as duas entraram também no
      `setInterval` de polling de 15s já existente, como rede de segurança
      independente do Realtime (mesmo princípio do comentário original: "se a
      assinatura cair silenciosamente, o painel não fica cego").
    - **Revalidado sem F5 nenhum**: repeti o mesmo ciclo (tenant/entregador de
      teste novos) e observei ao vivo: "Rota A caminho da loja" → "Rota Em
      entrega" mudou sozinha entre uma chamada de ferramenta e a próxima (
      Realtime, quase instantâneo); "Rotas ativas: 1" → "0" ao finalizar a
      entrega, sozinho; aba "Pedidos" mostrou "Pronto" → "Entregue" sozinha
      depois de ~17s sem tocar em nada (dentro da janela de polling de 15s,
      confirma o fallback funcionando mesmo se o Realtime não tivesse
      pegado). Suíte 122/122 de novo (Railway pausado/restaurado, mesmo
      protocolo). Dado de teste limpo ao final, 0 tenants restantes.
    - **Achado colateral, sem impacto**: não existe mapa nenhum em
      `painel-loja.html` — a posição do motoboy é gravada e usada
      internamente (alertas de segurança), só aparece como texto ("última
      posição às HH:MM") no card do motoboy, não visualmente. Não é bug, é
      falta de UI — registrado, não é bloqueio.
18. **Reteste final do `signUp()` real (fluxo de loja) — fecha a pendência do
    item 16, rate limit resetou** (18/08/2026, mesmo dia). Roteiro completo
    de novo, e-mail descartável real (Mailinator), contra a versão FINAL do
    trigger (pós-2ª-revisão, ver item 16): 6 passos → "Cadastro enviado" →
    e-mail de confirmação real recebido e link clicado de verdade → login →
    banner "falta documentos" → upload dos 2 → banner some. Confirmado no
    banco: `tenants`/`usuarios_loja` criados corretamente.
    - **PII sensível limpa com sucesso**: CPF, endereço, data de nascimento,
      chave Pix, nome — nada disso sobrou em `auth.users.raw_user_meta_data`.
      Objetivo real de LGPD cumprido.
    - **Achado, decisão consciente (não é bug)**: `raw_user_meta_data` NÃO
      ficou 100% `{}` — sobrou `{"email_verified": true}`. Causa confirmada
      com timestamps reais: `created_at` 17:54:44 → `email_confirmed_at`
      17:58:00 (3min16s) — passou da janela de 2 minutos do trigger
      `limpar_metadata_apos_provisionamento()` (ver item 16). O GoTrue faz
      uma 3ª escrita em `raw_user_meta_data` (marcando `email_verified:
      true`) no exato momento em que o USUÁRIO clica no link de confirmação
      — timing fora do nosso controle, pode ser minutos, horas ou dias.
      **Decisão do usuário, explícita**: aceitar como está, não perseguir
      esse resíduo. `email_verified` é um metadado booleano do próprio
      GoTrue, nunca é PII de negócio — tentar zerá-lo também criaria
      dependência de timing imprevisível do GoTrue sem ganho real de
      segurança/LGPD. Se aparecer de novo num ultrareview futuro, é
      comportamento esperado e já avaliado, não achado novo.
    - Suíte 122/122 rodada mais uma vez (Railway pausado/restaurado, mesmo
      protocolo). Dado de teste limpo ao final.
    - **Pendência do item 16 (reteste real bloqueado por rate limit) agora
      RESOLVIDA.**
19. **Hospedagem pública dos 3 mockups na Vercel — última peça bloqueante pro
    piloto, achado real do usuário** (18/08/2026, mesmo dia). Depois de tudo
    validado (cadastro, painel em tempo real, motor de despacho), o usuário
    perguntou diretamente onde a pessoa da hamburgueria ia abrir o sistema —
    e um relatório anterior meu tinha dito "HTTP 200 em painel-loja.html" de
    um jeito ambíguo o suficiente pra parecer que já havia hospedagem
    pública, quando na real era só `localhost:8080` (servidor de teste local
    da sessão). **Confirmado por busca no histórico completo do repositório
    (não só o estado atual): os 3 mockups NUNCA tiveram hospedagem nenhuma**
    — nem Vercel, nem Netlify, nem GitHub Pages, nada. Isso teria bloqueado o
    piloto de verdade se não tivesse sido perguntado antes.
    - **Corrigido**: deploy da pasta `mockups/` (só os 3 arquivos, nada mais)
      via Vercel CLI (já logado nesta máquina, `davidrochaanalista-9912`),
      projeto `girocerto-mockups`, domínio estável
      `girocerto-mockups.vercel.app` (ver as 3 URLs na "Visão geral" acima).
    - **Validado**: as 3 URLs responderam HTTP 200 de verdade (não local);
      conteúdo publicado confere em tamanho com os arquivos do repo; a
      correção do Realtime (`pedidos-ao-vivo`/`rotas-ao-vivo`, commit
      `cb738ef`) está presente na versão publicada (`grep` confirmou os 2
      canais no HTML servido pela Vercel); o SDK do Supabase (`supabase-
      js@2`, via jsdelivr) está presente e carregando nos 3 arquivos.
    - **Confirmação de segurança pedida explicitamente**: as 3 páginas usam
      só a chave `sb_publishable_...` (anon/publishable) — nenhuma
      `service_role`/`sb_secret_...` aparece em nenhum dos 3 arquivos
      (checado com grep antes de publicar). Isso é seguro por design — RLS
      no banco é a fronteira real (122 asserts testando isso ao longo da
      sessão), não o segredo dessa chave. `dispatch-engine/` (que usa a
      service_role key de verdade) nunca foi tocado nesse deploy — continua
      só no Railway, isolado dos mockups estáticos.
    - `dispatch-engine/` no Railway não tem deploy automático conectado ao
      GitHub (`source: null` confirmado via `railway status --json`) — push
      pro GitHub nunca dispara redeploy lá; deploys do motor de despacho
      continuam manuais via `railway up`/`railway redeploy`, como sempre
      foram nesta sessão. A Vercel (mockups) também não está conectada ao
      GitHub — foi um deploy direto via CLI a partir dos arquivos locais,
      não um deploy automático por push. **Se o código de qualquer um dos 3
      mockups mudar de novo, é preciso rodar `vercel --prod` de novo dentro
      de `mockups/` pra publicar — não acontece sozinho.**
    - **Auto-deploy via GitHub tentado e depois revertido, decisão
      consciente do usuário** (mesmo dia): cheguei a conectar o projeto
      Vercel ao repositório via `vercel git connect` (confirmado — pediu
      confirmação explícita pra desconectar depois, o que prova que a
      conexão era real, com a conta `davidrochaanalista-droid`) e ajustar o
      `Root Directory` do projeto pra `mockups` (sem isso, o build a partir
      do git tentaria rodar da raiz do repo inteiro, que não tem os HTMLs).
      O Railway nunca chegou a ser conectado — não existe comando de CLI pra
      isso (`railway --help` confirmado, só dashboard web), e a ação manual
      foi pedida mas o usuário decidiu adiar antes de fazer.
      **Decisão explícita do usuário: adiar a conexão automática via GitHub
      pros dois (Vercel e Railway) pra depois do piloto estabilizar** — mais
      controle durante a semana de uso real na hamburgueria, evita qualquer
      deploy automático de algo ainda não revisado enquanto a loja está
      usando o sistema. Revertido com `vercel git disconnect` (confirmado).
      **Fluxo continua 100% manual por enquanto**: `git push` (código) +
      `vercel --prod` dentro de `mockups/` (mockups) + `railway up`/`railway
      redeploy` dentro de `dispatch-engine/` (motor de despacho), sempre
      como passos separados e deliberados, nunca automáticos. Reconectar via
      GitHub é uma escolha válida pra revisitar depois do piloto, não uma
      pendência esquecida.
20. **"Definir localização" ganhou alternativa de endereço manual — GPS
    sozinho não escalava** (18/08/2026, mesmo dia). Antes de qualquer
    cadastro real acontecer, o usuário pediu a explicação técnica exata do
    botão de GPS existente e decidiu, a partir disso, que dependência 100%
    de `navigator.geolocation` sem fallback nenhum não era aceitável — nem
    só pra hamburgueria de agora, nem pros próximos clientes.
    - **Adicionado em `painel-loja.html`**: campo de endereço livre (texto)
      como alternativa ao GPS, os dois convivem lado a lado — geocoding via
      **Nominatim/OpenStreetMap** (gratuito, sem API key). Só dispara em
      clique explícito no botão "Buscar" (nunca por tecla digitada), dentro
      da política de uso deles (~1 req/s, sem autocomplete). Atribuição "©
      colaboradores do OpenStreetMap" exibida sempre que um resultado
      aparece (exigência da licença ODbL dos dados).
    - **Ambiguidade tratada com lista de candidatos** (não erro genérico):
      se o Nominatim retorna mais de 1 resultado, mostra todos pro usuário
      escolher; endereço não encontrado mostra erro claro pedindo pra
      revisar, nunca falha silenciosamente.
    - **Confirmação antes de salvar**: mostra endereço formatado + lat/lng
      + link "abrir no mapa" (OpenStreetMap, nova aba) — só grava em
      `tenants.lat/lng` depois de um clique explícito de confirmação.
    - **Testado com o endereço real da hamburgueria** (Avenida Basiléia,
      97, Lauzane Paulista, São Paulo - SP, CEP 02440-060), contra um
      tenant de teste (não o real, que ainda não existia no banco nesse
      momento):
      - **Achado real**: incluir a palavra "CEP" antes do número quebra a
        busca no Nominatim (retorna vazio) — só o número isolado funciona.
        Confirmado 2x, reproduzível. O proprietário precisa buscar SEM a
        palavra "CEP" (só o número do CEP, se quiser incluir).
      - **Achado real, mais importante**: o Nominatim **nunca** usou o
        número "97" pra achar um ponto específico nessa avenida — com ou
        sem o número na busca, os 3 resultados retornados são idênticos
        (segmentos de via, `class: highway`, não endereço pontual). O OSM
        não tem esse número mapeado como ponto de endereço nessa rua. A
        lista de 3 candidatos (cada um com CEP diferente) permitiu
        escolher o certo (`02440-060`) mesmo assim.
      - Resultado salvo: lat `-23.4774474`, lng `-46.647413` — **118,3
        metros** (Haversine exato, não estimativa) da referência de
        sanidade fornecida pelo usuário, mesmo bairro (Lauzane Paulista,
        Mandaqui, confirmado no próprio `display_name` do Nominatim). Bem
        dentro do `raio_chamada_motoboy_km` default (1.5km).
      - Fallback de ambiguidade retestado isolado (com e sem o número 97,
        sem a palavra "CEP") — comportamento idêntico e consistente nos
        dois casos, nunca falha silenciosamente.
    - Suíte 122/122 (Railway pausado/restaurado, mesmo protocolo). Tenant
      de teste limpo do banco ao final.
    - **Limitação honesta, não escondida**: geocoding por endereço aqui
      chega no nível "trecho de rua certo", não "casa exata" — suficiente
      pro raio de despacho de motoboy (não é navegação turn-by-turn), mas
      não é geocoding ponto-a-ponto perfeito. Documentado tanto pro
      usuário quanto aqui, não apresentado como mais preciso do que é.
    - Deploy manual na Vercel feito depois de revisão explícita do diff
      pelo usuário (mesmo protocolo — nada de deploy sem aprovação
      prévia).
21. **Teste real do fluxo de cadastro de entregador (`app-entregador.html`)
    + achado crítico de configuração (Site URL apontando pra localhost) —
    corrigido e revalidado em produção** (18-19/08/2026, mesmo dia).
    Pedido: validar `signUp()` real de entregador contra um TENANT DE TESTE
    (não a hamburgueria real, que ainda não existia no banco) mas usando o
    endereço real dela (mesmo endereço do item 20), pra já exercitar
    geolocalização/raio de despacho com coordenada real.
    - **Fluxo completo testado com sucesso contra produção**
      (`girocerto-mockups.vercel.app`): `signUp()` real (moto) sem erro
      42501, trigger `provisionar_cadastro_pos_signup()` criou a linha em
      `entregadores` corretamente vinculada ao tenant de teste, e-mail de
      confirmação real recebido (Mailinator), login, tela "Falta pouco",
      upload dos 3 documentos (CNH/CRLV/comprovante) pro bucket
      `documentos-privados` com paths corretos, `verificacao_enviada_em`/
      `verificacao_prazo_limite` gravados com a diferença exata de 7 dias
      (A1 confirmado com dado real de entregador, não só de loja).
    - **Achado crítico, real, pego durante o teste**: o link de
      confirmação de e-mail do Supabase Auth apontava pra
      `redirect_to=http://localhost:3000` — configuração de `Site URL` no
      projeto hospedado nunca tinha sido trocada do valor padrão. Clicando
      no link real (não simulado), o navegador ia parar em
      `http://localhost:3000/#access_token=...`, página inacessível, com o
      token de sessão preso na URL. A confirmação em si funcionava no
      backend (`email_confirmed_at` gravado normalmente), mas um usuário
      real — loja OU entregador, o bug afeta os dois igualmente, já que
      nenhum dos dois `signUp()` no código passa `emailRedirectTo` — veria
      "site inacessível" logo depois de confirmar o e-mail, sem noção de
      como voltar pro app. Quase passou despercebido até o primeiro
      cliente real confirmar o e-mail dele.
    - **Corrigido via dashboard do Supabase** (`Authentication > URL
      Configuration`, ação que exige login na conta do usuário — não é
      algo que dá pra automatizar sem credenciais, então o usuário logou
      manualmente e eu apliquei a mudança depois de autenticado): `Site
      URL` trocado de `http://localhost:3000` pra
      `https://girocerto-mockups.vercel.app/painel-loja.html`; adicionada
      `https://girocerto-mockups.vercel.app/**` em `Redirect URLs`
      (wildcard cobre os 3 mockups, inclusive querystring
      `?loja=<tenant_id>` do link do entregador).
    - **Revalidado com um novo cadastro de teste (loja) do zero**: link do
      e-mail real veio com `redirect_to=https://girocerto-mockups.vercel.app/
      painel-loja.html`; clicado de verdade, o navegador foi parar em
      produção normalmente (não mais em localhost); `email_confirmed_at`
      gravado. Fix confirmado funcionando ponta a ponta.
    - **Limitação residual, não corrigida, registrada como pendência
      nova**: como nenhum dos dois `signUp()` (loja em `cadastro-loja.html`,
      entregador em `app-entregador.html`) passa `emailRedirectTo`
      explícito, os dois caem no MESMO `Site URL` de fallback
      (`painel-loja.html`). Isso resolve o bug crítico (não trava mais em
      localhost), mas um entregador que confirmar o e-mail dele vai
      aterrissar no painel da LOJA, não em `app-entregador.html` — página
      errada pra ele, ainda que não quebrada. Fix completo exigiria passar
      `options.emailRedirectTo` específico em cada `signUp()` (e, no caso
      do entregador, preservar `?loja=<tenant_id>` nesse redirect) — não
      feito nesta sessão, fica como pendência.
    - Todo o dado de teste (2 tenants, incluindo um segundo criado só pra
      revalidar o fix, 3 auth users — dono x2, entregador x1 — e os 3
      arquivos no bucket `documentos-privados`) limpo do banco ao final,
      confirmado sem resíduo.
22. **`mockups/painel-dev.html` — ferramenta interna pro desenvolvedor
    aprovar entregadores de teste sem SQL manual + achado de segurança real
    corrigido no processo** (19-20/08/2026). Pedido explícito: arquivo
    separado (não uma aba dentro de `painel-loja.html` — a hamburgueria
    nunca deve ver isso), acesso restrito só ao dev, superfície de ação
    mínima (só aprovar, nada de editar outros campos). Escopo final,
    confirmado com o usuário depois de uma resposta inicial confusa/fora de
    contexto dele: painel de 5 seções (aprovação, tenants, entregadores,
    saúde do motor, pedidos recentes), não só aprovação.
    - **Achado de segurança real, fora do escopo original, corrigido na
      mesma mudança (decisão do usuário)**: a policy `"entregador atualiza
      seu proprio cadastro"` (`FOR UPDATE`, sem `WITH CHECK`) permitia o
      próprio entregador setar `status_verificacao='aprovado'` via update
      direto — bypass total de qualquer processo de aprovação, manual ou
      pela ferramenta nova. Corrigido com trigger `BEFORE UPDATE`
      (`impedir_autoaprovacao_entregador()`, mesma técnica de
      `proteger_bloqueado_ate()` — `WITH CHECK` não enxerga o valor ANTIGO
      da coluna na mesma expressão) barrando mudança de
      `status_verificacao`/`aprovado_por`/`aprovado_em`/`motivo_reprovacao`
      pelo próprio entregador, com exceção só pro dev (`eh_desenvolvedor_admin()`).
    - **Modelo de acesso** (revisado a fundo com o usuário antes de aplicar,
      2 rodadas de perguntas sobre o mecanismo exato): tabela allowlist
      `desenvolvedores_admin(auth_user_id)` — RLS habilitada e DE PROPÓSITO
      sem nenhuma policy própria (só funções `SECURITY DEFINER` e service
      role enxergam) — e função `eh_desenvolvedor_admin()` (mesmo padrão de
      `minhas_tenant_ids()`) checando `auth.uid()` contra ela. **Ponto
      confirmado explicitamente com o usuário**: o trigger de
      auto-aprovação NÃO distingue "é a RPC chamando" de "é uma API direta"
      — ele só verifica quem está autenticado. A proteção real contra um
      PATCH direto do próprio dev é RLS (o dev nunca recebeu policy de
      `UPDATE` em `entregadores`, só `SELECT`) — sem policy de `UPDATE`
      aplicável, RLS nega o update de cara, então o trigger nunca chega a
      ser avaliado por essa via; só a RPC `aprovar_entregador_teste()`
      (`SECURITY DEFINER`, bypassa RLS mas não triggers) realmente escreve.
      **Invariante documentada no próprio comentário SQL**: se algum dia uma
      policy de `UPDATE` for adicionada pro dev em `entregadores`, esse
      trigger sozinho deixa de ser suficiente.
    - RPC `aprovar_entregador_teste(id)` (`SECURITY DEFINER`) em vez de uma
      policy de `UPDATE` genérica pro dev — toca só `status_verificacao`/
      `aprovado_em`, sempre, mesmo que a chamada tentasse mandar outros
      campos (a assinatura só aceita o id). `aprovado_por` fica `NULL` de
      propósito: quem aprova aqui não é um `usuarios_loja` (a FK de
      `aprovado_por` referencia `usuarios_loja(id)`).
    - **`is_teste` (boolean, default false) adicionado em `entregadores` E
      `tenants`** — sinalizador explícito em vez de heurística de nome/
      e-mail (pedido original só cobria `entregadores`; estendido a
      `tenants` pela mesma razão, decisão comunicada e aprovada). Setado via
      metadata opcional `is_teste` no `signUp()`
      (`provisionar_cadastro_pos_signup()` estendida); cadastro real nunca
      expõe esse campo, fica `false` por padrão. UI mostra o badge TESTE/
      REAL a partir do campo (fonte de verdade), com um aviso visual
      separado se nome/e-mail "parecem" teste mas o campo diz o contrário
      (ou vice-versa) — não decide nada, só chama atenção pra possível erro
      de cadastro.
    - **"Saúde do motor" simplificada, decisão comunicada e aprovada**: não
      usa `pg_stat_activity` (exigiria privilégio elevado só pra inspecionar
      conexões de outros processos, e mesmo assim não dá pra identificar com
      confiança qual conexão é o listener do Railway — falsa precisão). Usa
      o sinal que o próprio usuário ofereceu como alternativa: tempo desde a
      última linha em `tentativas_despacho`, com aviso na tela de que é
      indireto (só há atividade quando um pedido fica pronto de verdade).
    - **Conta dev criada via `admin.createUser`, não `signUp()`** (desvio
      comunicado e aprovado): sem metadata o trigger de provisionamento não
      cria nada (confirmado lendo o código antes de decidir), então
      `signUp()` funcionaria, mas é uma conta de serviço, não um fluxo de
      UX — `admin.createUser` evita gastar rate limit de e-mail à toa.
      E-mail `girocerto2026@gmail.com` (mesmo endereço da conta da
      plataforma Supabase, mas são identidades completamente separadas: uma
      é login em supabase.com, outra é uma linha em `auth.users` do projeto
      — sem conflito nenhum). Senha gerada e mostrada uma única vez no chat,
      nunca gravada em arquivo nenhum.
    - **Testado de ponta a ponta contra o banco hospedado real** (script
      avulso, 20 asserts, não versionado — fora do padrão de
      `tests/COBERTURA.md` porque é infraestrutura interna, não fluxo de
      produto): entregador de teste criado com `is_teste=true` →
      `status_verificacao='em_avaliacao'` confirmado; login do dev →
      `eh_desenvolvedor_admin()=true`; policy de SELECT mostra o pendente;
      **PATCH direto do dev tentando burlar a RPC → 0 linhas afetadas,
      RLS bloqueou antes do trigger** (prova a garantia real); RPC aprova →
      só `status_verificacao`/`aprovado_em` mudaram, `aprovado_por` continua
      `null`, `chave_pix`/`cpf` intocados; **o próprio entregador tentando
      se auto-aprovar (ou auto-reprovar) → bloqueado com erro `42501`
      mencionando "aprovação"**, status não foi revertido; entregador ainda
      consegue editar campos normais (`lat`/`lng`) depois disso — confirma
      que o trigger não travou o resto do update, só os 4 campos
      protegidos. Dado de teste limpo ao final (tenant + auth user).
    - **`painel-dev.html` fica SÓ LOCAL, decisão explícita do usuário**: não
      publicado na Vercel — ferramenta com poder de aprovar cadastros, sem
      ganho real em expor uma URL publicamente descobrível só pra uso do
      dev. Roda via `python -m http.server` quando precisar. Login+RLS já
      protegeriam mesmo se publicado, mas reduzir a superfície por padrão
      não custa nada.
    - Não commitado, não deployado (nem os 3 mockups existentes, nem este
      novo) — só a mudança de schema foi aplicada no banco hospedado
      (`db/schema.sql` e a migration re-sincronizados, como sempre).
23. **Módulo feira (`feira-dispatch`) — planejamento extenso, schema
    aplicado, `feira-dispatch/` criado e `app-entregador.html` reescrito
    pra absorver a parte do entregador** (21-22/08/2026). Usuário trouxe
    um módulo pronto (`C:\Users\Usuário\
    Projetos\feira-dispatch\feira-dispatch\`, fora deste repo) pra integrar
    — dispatch multi-parada de feira (carrinho multi-feirante, peso máximo,
    Pix peer-to-peer direto pro feirante, voz automática). Pedido inicial
    citava uma pasta `_feira-incoming/` que não existia — investigação
    encontrou o caminho real antes de qualquer plano.
    - **Achado central, antes de qualquer execução**: o módulo foi
      construído contra um schema HIPOTÉTICO (`estabelecimentos`,
      `usuarios`, `produtos`, `entregadores.latitude/longitude` — o próprio
      README admite isso), não o schema real do GiroCerto. Não era um job
      de "renumerar migrations e copiar arquivos sem conflito" —
      confirmado por leitura completa das 9 migrations + `src/` antes de
      propor qualquer coisa.
    - **Decisões de arquitetura, em rodadas sucessivas de pergunta/resposta
      com o usuário** (registrando só o que foi decidido, não o processo):
      - Feira é um **domínio paralelo** a `tenants`/`pedidos`/`rotas_entrega`
        (não um tipo de tenant) — o Pix peer-to-peer direto pro feirante é
        estruturalmente diferente de tenant único, não só outro jeito de
        modelar a mesma coisa. `entrega_rota`/`rota_parada` (rotas da
        feira) ficam **duplicadas**, não reaproveitando `rotas_entrega` —
        zero risco pro restaurante real em produção pesa mais que evitar
        essa duplicação.
      - `entregadores` continua a ÚNICA tabela 100% compartilhada entre os
        dois domínios (mesma frota, mesma conta). `tenant_id` virou
        nullable (entregador 100% feira, sem vínculo de restaurante). Novo
        `aceita_feira boolean default false` — elegibilidade pra oferta de
        feira, independente de `tenant_id` (a MESMA conta pode ter
        `tenant_id` preenchido E `aceita_feira=true` ao mesmo tempo —
        `tipo_perfil` na rota diferencia o contexto, não a conta).
      - Tela única do entregador: `app-entregador.html` (vanilla JS
        existente) **absorve** as ofertas de feira, sem seletor de modo —
        `FeiraApp.jsx` (React) vira só referência de design pra portar,
        não é embrulhado nem mantido como app separado. Consequência direta
        (não uma pergunta nova): o wrapper Capacitor, quando existir,
        embrulha `app-entregador.html`, não o React.
      - `FeiraApp.jsx` (54KB) na real cobre **4 personas**, não 1:
        `PainelEntregador`/`ExtratoEntregador` (entregador — isso que
        entra em `app-entregador.html`), `PainelFeirante`/
        `DashboardFeirante` (feirante — sem tela existente, produto novo) e
        `CheckoutConsumidor` (consumidor — sem tela existente, produto
        novo, GiroCerto nunca teve autoatendimento de pedido). Só a parte
        do entregador entra nesta rodada; as outras 2 personas ficam
        documentadas como pendência futura, sem data.
    - **Schema aplicado no banco hospedado** (`db/schema.sql`, nova seção
      "MÓDULO FEIRA", ~1380 linhas): 24 tabelas novas (`estabelecimentos`,
      `usuarios`, `produtos` criadas do zero — o módulo assumia que já
      existiam; `feira*`, `pedido*`, `dispatch_config`, `entrega_rota`,
      `rota_parada`, `entrega_metrica`, `veiculo_*`,
      `piso_regulatorio_config`, `oferta_recusada`,
      `entregador_flag_revisao`, `notificacao*`, `avaliacao`), ~25 funções/
      triggers consolidados no ESTADO FINAL (não replay das 9 migrations —
      onde uma migration posterior redefinia uma função, só a versão final
      entrou), e **RLS escrita do zero pras 24 tabelas** (o módulo original
      não trazia nenhuma — zero `enable row level security`, zero
      `create policy` nos 9 arquivos). Funções `SECURITY DEFINER`
      (`meu_estabelecimento_id()`, `meu_usuario_id()`,
      `meu_entregador_id_feira()`) seguindo o mesmo padrão de
      `minhas_tenant_ids()`.
    - **Dois ajustes obrigatórios sobre o que o módulo trouxe**: (1) toda
      referência a `entregadores.latitude`/`.longitude` corrigida pra
      `entregadores.lat`/`.lng` (nome real, **confirmado direto contra o
      banco hospedado** antes de aplicar, não só contra `db/schema.sql`,
      a pedido explícito do usuário: "só bateria o olho no nome real da
      coluna... antes"); (2) `buscar_entregador_mais_proximo()` também
      passou a checar `aceita_feira = true`, senão qualquer entregador
      compartilhado (mesmo os só-restaurante) seria elegível pra oferta de
      feira.
    - **Achado de ordem, pego antes de aplicar**: a view `avaliacao_media`
      (seção de views) referenciava a tabela `avaliacao`, que só viria
      DEPOIS no arquivo original — teria quebrado com "relation avaliacao
      does not exist". Corrigido movendo a criação da tabela pra antes das
      views, antes de rodar contra o banco real.
    - **Regressão real encontrada pela suíte completa, não por inspeção**:
      o trigger `impedir_autoaprovacao_entregador()` (item 22, sessão
      anterior) passou a bloquear `verificar_documentos_vencidos()` (job
      `pg_cron` de reprovação automática por documento vencido, existente
      desde 15/08) — o cron faz `UPDATE entregadores SET
      status_verificacao=...` direto, sem sessão JWT nenhuma
      (`auth.uid()` fica `null` nesse contexto), e o trigger não previa
      esse caminho. `tests/onboarding.test.js` pegou isso na primeira
      rodada da suíte completa (16 → 0 passou, erro fatal 42501). Corrigido
      estendendo a condição de escape do trigger pra também liberar quando
      `auth.uid() is null` (nenhuma requisição real de entregador via
      PostgREST chega com `auth.uid()` nulo — só automação de backend).
      Reaplicado no banco hospedado, suíte voltou a 100%.
    - **Suíte completa rodada 2x** (protocolo padrão: `railway down -y` →
      testes → `railway up -y -c`, confirmado offline/online nos dois
      momentos) — 122/122 na versão final (105 + 17 do `despacho_motor`; 1
      falha intermitente do próprio `despacho_motor` na 2ª rodada foi
      apenas timing, confirmado reproduzindo o arquivo sozinho logo em
      seguida, sem nenhuma mudança — não é regressão).
    - **Checkpoint commitado** (`281ae52`) antes da etapa de maior risco
      (reescrita de `app-entregador.html`), a pedido explícito do usuário —
      schema + migration + `CLAUDE.md`, sem push.
    - **`feira-dispatch/` criado** (sibling de `dispatch-engine/`, próprio
      `package.json`/`src`/`tests`) — 15 arquivos de `src/` avaliados um a
      um, não copiados às cegas: 9 sem dependência de `entregadores`
      (cópia direta, incluindo `insertionEngine.js`/`routeOptimizer.js`/
      `fairRotation.js`/`proximityNotifier.js`/`checkout.js`, que na
      inspeção acabaram sendo lógica pura também, não só os 7 óbvios) e
      6 ajustados (`routeManager.js`, `notifications.js`, `index.js`, e as
      2 funções SQL que faltavam o fix lat/lng). **2 bugs reais do módulo
      original encontrados e corrigidos nesse processo** (não achismo —
      confirmado lendo o código): `buscarBikesOciosas()` filtrava
      `entrega_rota.tipo_veiculo`, coluna que não existe nessa tabela (só
      `entregadores.tipo_veiculo`) — a query sempre teria quebrado/voltado
      vazia, nenhuma bike jamais teria sido considerada ocupada;
      `notifications.js` selecionava uma coluna `whatsapp` que não existe
      em tabela nenhuma (`estabelecimentos`/`usuarios` ganharam `telefone`
      como fix). Os 9 testes standalone do próprio módulo (sem dependência
      de Supabase) rodam contra o código portado: `cd feira-dispatch && npm
      test` — 100% passando.
    - **`app-entregador.html` reescrito pra absorver a parte do entregador
      de `FeiraApp.jsx`** (`PainelEntregador`, `ExtratoEntregador`,
      `TelaAvaliacao`) — sem seletor de modo, exatamente como decidido: o
      botão "🧺 Ver rota da feira" aparece ao lado do fluxo do restaurante
      quando existe uma rota ativa, mesma tela, mesma conta. Novo canal
      Realtime (`ofertas-feira`, INSERT em `entrega_rota`) espelha o
      padrão já usado pro restaurante (`ofertas-despacho`/
      `tentativas_despacho`). Fluxo completo: oferta (modal com paradas/
      peso) → aceitar (`aceitar_rota` RPC) → checklist com "Cheguei"
      (`registrar_chegada_parada`, início da espera remunerada da migration
      007) → confirmar coleta por código (`pedido_nota`) ou marcar entrega
      → ao concluir a última parada, modal de avaliação por estrelas
      (grava em `avaliacao`) → extrato (`extrato_entregador`).
    - **2 bugs de RLS pegos e corrigidos durante a própria reescrita**
      (antes de qualquer teste — revisão do próprio schema que eu tinha
      acabado de escrever, não achado por terceiro): faltava policy de
      INSERT em `oferta_recusada` pro entregador (botão "Recusar" quebraria
      com RLS); faltava policy de INSERT em `avaliacao` pro entregador
      avaliar o feirante (só existia a do consumidor) — essa especificamente
      **perguntada ao usuário antes de corrigir**, aprovada explicitamente.
    - **Simplificação documentada, não bug**: o bônus de deslocamento até a
      feira (`arrivalBonus.js` no módulo original, calculado com a posição
      real do entregador no aceite) não foi portado pro
      `app-entregador.html` nesta rodada — `aceitar_rota()` já aceita
      `null` pros 2 parâmetros opcionais e grava a rota aceita normalmente,
      só sem o bônus. Comentário no próprio código sinaliza isso.
    - **Gap conhecido do módulo original, mantido de propósito** (decisão
      explícita do usuário, não implementar failover novo): "Recusar" uma
      oferta de feira registra em `oferta_recusada` mas NÃO reatribui a
      rota pra outro entregador automaticamente — diferente do failover
      real que já existe pro restaurante (`dispatch-engine/`). O app avisa
      isso explicitamente pro entregador ao recusar, em vez de fingir que
      resolve sozinho.
    - **Correção pontual, mesmo dia**: tratamento formal Sr./Sra. removido
      de toda mensagem/áudio pro cliente final (`notifications.js`,
      `ttsGenerator.js`) — texto final é só buzina + primeiro nome ("Olá,
      [Nome]!" / "[Nome], seu pedido está chegando!..."). `usuarios.genero`
      (adicionado horas antes só pra decidir Sr./Sra.) removido da tabela
      por não servir mais pra nada — aplicado no banco hospedado antes de
      qualquer dado real existir ali.
    - **Suíte completa rodada mais uma vez depois de todos os ajustes**
      (mesmo protocolo, Railway pausado/restaurado) — 122/122 (mesma falha
      intermitente e inofensiva do `despacho_motor` reproduzida e
      descartada como não-regressão, 2ª vez na mesma sessão).
    - **Ainda não commitado** — `feira-dispatch/`, a reescrita de
      `app-entregador.html`, e os ajustes de RLS/Sr.Sra. ficaram só
      aplicados/editados, aguardando aprovação explícita pra commit (ver
      pendências).
    - **Commitado** (`f3b5368`) depois de confirmar por grep completo que
      nenhum código vivo referenciava mais `usuarios.genero` (só
      documentação mencionando a remoção em si, e um falso positivo de
      substring em "generosa").
    - **Failover de feira ao recusar — implementado, mesmo dia** (pedido
      explícito do usuário, depois de perguntar se a rotação justa entre
      bikes já cobria isso — não cobria, são mecanismos diferentes: uma
      decide quem é oferecido primeiro, a outra decide o que fazer depois
      de uma recusa, e essa segunda nunca tinha sido endereçada pelo
      módulo original). Nova RPC `redespachar_apos_recusa_feira()` —
      mesmo princípio do failover real do restaurante (próximo mais
      próximo dentro do MESMO raio, nunca relaxa), mas síncrona, chamada
      pelo próprio client no momento da recusa, sem precisar de nenhum
      serviço Node rodando. Reaproveita `oferta_recusada` como lista de
      exclusão (já tinha exatamente os dados certos) em vez de criar
      tabela nova. `SECURITY DEFINER` com guard interno: só quem já
      registrou a própria recusa pra aquela rota específica pode disparar
      o redespacho (testado: entregador não-envolvido tentando "sequestrar"
      a rota de outro é bloqueado). **Bug real pego antes de qualquer
      teste** (acompanhando o próprio raciocínio, não achado por
      terceiro): o canal Realtime do entregador só escutava `INSERT` em
      `entrega_rota` — uma reatribuição é `UPDATE` numa linha existente, o
      novo candidato nunca veria a oferta sem escutar os dois eventos
      (mesmo motivo pelo qual o canal do restaurante já escuta ambos).
      Testado com 3 entregadores de teste (A perto, B um pouco mais longe
      mas dentro do raio, C fora do raio): recusa de A → RPC atribui a B
      corretamente; recusa de B → RPC retorna `null` (C está fora do raio,
      não é forçado); entregador não-envolvido tentando chamar a RPC pra
      rota alheia é bloqueado. 12/12 asserts, dado de teste limpo ao
      final.
    - **Limitação explicitamente documentada, a pedido do usuário** (pra
      não virar surpresa quando alguém notar uma rota "presa"): o
      failover acima cobre só RECUSA EXPLÍCITA. **TIMEOUT (entregador que
      nunca responde, nem aceita nem recusa) não tem cobertura nenhuma
      ainda** — precisaria de um processo vivo checando
      `now() - aberta_em > prazo` periodicamente, que não existe pra
      feira (mesma pendência já registrada de "nenhum cron do módulo
      feira está rodando", não é uma lacuna nova). Uma rota que fica
      "presa" sem ninguém ter recusado nada é esperado hoje, não um bug.
    - **Bônus de deslocamento (`arrivalBonus.js`) portado** — honestamente,
      tinha sido cortado de escopo por mim sob pressão de tempo, não uma
      decisão discutida (diferente do failover, que foi conscientemente
      adiado com o aval do usuário). Perguntado, reconhecido, corrigido:
      `aceitarOfertaFeira()` agora pega a posição GPS real do entregador
      no momento do aceite (`getCurrentPosition`, mesmo padrão já usado em
      `confirmarParadaFeira()`), calcula a distância via `calcular_distancia_km()`
      (reaproveita a função SQL já existente, não duplica a fórmula de
      haversine em JS) e passa `p_distancia_ate_feira_km`/
      `p_bonus_deslocamento` pro `aceitar_rota()` RPC, que já aceitava
      esses parâmetros desde o schema original.
    - **Suíte completa rodada mais uma vez** (mesmo protocolo) — 122/122,
      limpo desta vez (sem a falha intermitente do `despacho_motor` das
      rodadas anteriores).

## Pendências reais no momento
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
- [ ] **TIMEOUT no despacho de feira não tem cobertura nenhuma**
      (entregador recebe a oferta e nunca responde — nem aceita, nem
      recusa). O failover de recusa explícita (`redespachar_apos_recusa_feira()`)
      só dispara quando alguém efetivamente clica "Recusar" — sem isso,
      uma rota fica "presa" com `status='em_montagem'` indefinidamente.
      Resolver exige um processo vivo checando `now() - aberta_em > prazo`
      periodicamente (mesmo problema da pendência de cron abaixo — não é
      uma lacuna nova, é a mesma). **Registrado explicitamente a pedido do
      usuário**, pra não virar surpresa quando alguém notar uma rota
      presa sem entender por quê: hoje isso é esperado, não bug.
- [ ] **Nenhum cron do módulo feira está rodando** — `fecharRotasExpiradas`,
      `expirar_pedidos_pendentes`, `processarLote` (notificações) existem
      como funções/endpoints em `feira-dispatch/src/`, mas nada os
      dispara periodicamente ainda (precisaria de `node-cron` ou um
      processo tipo `dispatch-engine/` rodando no Railway).
- [ ] **`PainelFeirante`/`DashboardFeirante` e `CheckoutConsumidor`** —
      ainda fora de escopo, sem tela existente pra integrar (ver item 23).
- [ ] **Wrapper Capacitor** (push nativo com som customizado + tracking em
      background) — decidido que embrulha `app-entregador.html`, mas o
      wrapper em si não foi criado.
- [ ] **`PainelFeirante`/`DashboardFeirante` e `CheckoutConsumidor`** (as
      outras 2 de 4 personas de `FeiraApp.jsx`) — fora de escopo por
      decisão explícita do usuário nesta sessão. Não têm tela existente
      pra integrar (GiroCerto nunca teve painel de feirante nem checkout
      de consumidor) — são produtos novos do zero, não integração. Fica
      pra depois, sem data.
- [ ] **Capacitor (push nativo + tracking em background)** — decisão já
      tomada (embrulha `app-entregador.html`, não `FeiraApp.jsx`, já que a
      tela do entregador foi unificada lá), mas o wrapper em si não foi
      criado — depende de `app-entregador.html` primeiro absorver as telas
      de feira (pendência acima).
- [ ] **Loja e entregador caem no mesmo `Site URL` de fallback após
      confirmar e-mail** (achado do item 21) — não é mais o bug crítico
      (localhost inacessível, já corrigido), mas um entregador confirmando
      o e-mail hoje aterrissa em `painel-loja.html` (painel da loja) em vez
      de `app-entregador.html`. Corrigir exige passar
      `options.emailRedirectTo` explícito em cada `signUp()` — em
      `cadastro-loja.html` apontando pra `painel-loja.html` (já é o
      comportamento atual, sem mudança), em `app-entregador.html` apontando
      pra `app-entregador.html?loja=<tenant_id>` (precisa preservar o
      tenant_id através do fluxo de confirmação). Não bloqueia o piloto
      desta semana (usa só 1 entregador de teste aprovado via SQL, sem
      passar pelo link real), mas bloqueia divulgar o link `?loja=` pra
      motoboys reais com uma experiência limpa.
- [ ] **BLOQUEIA fluxo de entregador real pela LOJA (não bloqueia mais o
      dev)**: continua sem existir NENHUMA UI em `painel-loja.html` pra loja
      aprovar um entregador que se cadastrou pelo link `?loja=` — a aba
      "Entregadores" mostra literalmente o texto `"Lista de entregadores
      cadastrados ainda não foi construída."`. `mockups/painel-dev.html`
      (item 22) resolve isso só pro desenvolvedor (uso local, ferramenta
      interna) — a hamburgueria continua sem nenhuma forma de aprovar
      motoboy nenhum pela própria interface dela. Bloqueia divulgar o link
      `?loja=` pra motoboys de verdade com a LOJA no controle do processo
      (hoje só o dev consegue aprovar).
- [ ] **Auditoria de outros gaps latentes de Realtime/publication** (pedido
      explícito do usuário, não bloqueia o piloto desta semana) — o achado do
      item 17 (`pedidos`/`rotas_entrega` fora da publication, painel não
      atualizava sozinho) é o 3º caso do mesmo padrão nesta sessão (ver
      "REGRA GERAL" em "Arquitetura conhecida"). Vale, com calma, revisar se
      existe mais algum `carregar*()` nos 3 mockups que só roda uma vez (sem
      Realtime nem polling) mas deveria refletir mudança feita por fora da
      própria aba — antes de expandir o sistema pra mais funções/telas, não
      depois.
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
- [ ] Freelance multi-loja (mesma pessoa em 2+ tenants) não é suportado pelo schema
      atual (`idx_entregadores_auth_user` é único) — decisão de produto em aberto, não
      é bug.
- [ ] `.env` local tem as credenciais do projeto Supabase hospedado
      (`ntmxkwzhumiqspxijuln`) — nunca comitar, já está no `.gitignore`.
- [ ] 3 nits do `/ultrareview` de 14/08/2026 ficaram de fora desta rodada (só os 6
      achados de severidade "normal" foram corrigidos, por prioridade explícita do
      usuário) — nenhum é bloqueio, mas seguem em aberto: `set_pin_integracoes` não
      exige o PIN atual antes de sobrescrever (impacto prático baixo, dono já tem
      SELECT direto em `integracoes` de qualquer forma); `pin_integracoes_hash` fica
      exposto via SELECT normal de `usuarios_loja` (RLS é por linha, não por coluna —
      contradiz o comentário no schema, mas hoje não há fluxo de funcionário pra
      explorar); comentário no topo de `db/schema.sql` ainda diz "RLS entra na Fase 2",
      contradizendo o schema logo abaixo (só afeta leitura/documentação).
- [ ] `calcular_segundos_parado` (fix do ultrareview round 1, item 7) depende de
      `rotas_entrega.iniciada_em`, que agora É populado de verdade pelo motor de
      despacho real (item 10, `confirmarRetirada()`) — a lacuna que fazia esse fix ficar
      inerte foi fechada, mas o comportamento não foi re-testado especificamente com
      dado real do motor de despacho nesta sessão. Vale um teste dedicado antes de
      considerar 100% validado em produção.
- [ ] **Link público de rastreio pro cliente final** — ainda não implementado. O motor
      de despacho real (item 10) já existe, então a posição ao vivo agora faz sentido
      de verdade — mas a página pública em si (token por pedido sem enumeração, sem
      vazar dados de outros pedidos/tenants) não foi construída, não fazia parte do
      escopo desta sessão.
- [ ] **Integração real de Pix** — decisão de produto pendente (qual provedor:
      `mercado_pago`/`asaas`/`stone`/`outro`), não decisão técnica. Confirmado
      isolado e não vazado por vários arquivos — ver `tests/COBERTURA.md` seção
      "Pendência isolada — Pix" pro que falta decidir exatamente.
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
- **`signUp()` real (não `admin.createUser`) consome o rate limit de e-mail do
  Supabase** (free tier) — depois de poucas confirmações reais numa mesma
  sessão, novas tentativas retornam `429 email rate limit exceeded` (bloqueia
  inclusive tentativas via navegador, não só scripts). Não fica claro o tempo
  exato de reset. Ao testar fluxos de `signUp()` real, economizar tentativas
  (ex: usar `admin.createUser` + manipulação direta de `created_at`/campos via
  SQL pra simular cenários que não precisam do e-mail de verdade, reservando
  `signUp()` real pros casos que realmente exigem provar o fluxo ponta a
  ponta).

## REGRA DE ATUALIZAÇÃO

Ao final de cada sessão de trabalho — quando o usuário disser algo como "por hoje é
só", "vamos parar por aqui", "encerra por hoje" ou equivalente — atualize este arquivo
antes de encerrar, cobrindo:

1. **O que foi feito nesta sessão**: adicionar um novo item numerado (continuando a
   numeração existente) em "O que foi feito", resumindo as mudanças reais (commits,
   arquivos, comportamento alterado) — não copiar mensagens de commit literalmente,
   sintetizar o que importa pra retomar o contexto depois.
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
