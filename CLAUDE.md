# GiroCerto — Status do Projeto

## Visão geral
Plataforma de logística de motoboy pra lojas locais (restaurantes, açaiterias,
padarias etc.), com foco em reduzir o ciclo ocioso do entregador (espera na loja +
volta vazia). MVP ainda é só mockups HTML estáticos (`cadastro-loja.html`,
`painel-loja.html`, `app-entregador.html`) falando DIRETO com Supabase via
`@supabase/supabase-js` — **não existe backend Node próprio ainda** (diferente do
Torre, que tem Express completo). Caminho local: C:\Users\Usuário\Projetos\giro certo

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

## Pendências reais no momento
- [ ] Testar `db/schema.sql` num ambiente com mais RAM (ex: Supabase local em outra
      máquina) se algum dia for necessário comparar comportamento local vs hospedado —
      não é bloqueio, hospedado já cobre tudo.
- [ ] Nenhum teste de integração pendente no momento — todos os itens da rodada
      anterior (constraints, RLS, A1, A2, selo, PIN, carga, B2) e da rodada do item 6
      (RLS das policies novas + carga com 45 pedidos/confirmações concorrentes) foram
      executados contra banco real e estão documentados acima.
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
- [ ] Duas limitações dormentes achadas na 2ª rodada de `/ultrareview` (item 7),
      ambas condicionadas à existência de um motor de despacho real (não construído
      ainda): `calcular_segundos_parado` só filtra a espera na loja corretamente
      quando `rotas_entrega.iniciada_em` for populado por algo — hoje nada escreve
      essa coluna; `clicarContinuar()` em `app-entregador.html` sempre volta
      `entregadores.status` pra `'disponivel'`, perdendo um eventual status de rota
      em progresso anterior à pausa. Retomar quando o fluxo de despacho/roteirização
      for implementado.

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
