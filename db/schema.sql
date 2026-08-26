-- ============================================================
-- GiroCerto — Schema inicial (Supabase / Postgres)
-- MVP: foco em ciclo ocioso (espera na loja + volta vazia)
-- Multi-tenant desde o início via tenant_id, mas sem RLS
-- robusta ainda — cliente único no piloto, RLS entra na Fase 2.
-- ============================================================

create extension if not exists pgcrypto; -- necessário para gen_random_uuid()
create extension if not exists postgis;  -- necessário para decodificar a polyline
                                          -- da rota e calcular distância real
                                          -- (ver seção "SEGURANÇA — DETECÇÃO DE
                                          -- MOTOBOY PARADO E DESVIO DE ROTA" mais
                                          -- abaixo)

-- ------------------------------------------------------------
-- TENANTS: cada cliente (rede de restaurante, empresa de motofrete)
-- ------------------------------------------------------------
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null,  -- nome da loja

  -- ------------------------------------------------------------
  -- CADASTRO (seção 25): dados do proprietário + dados da loja
  -- ------------------------------------------------------------
  -- proprietário
  proprietario_nome text,
  proprietario_cpf text,
  proprietario_data_nascimento date,
  proprietario_endereco text,
  proprietario_numero_endereco text,
  proprietario_cep text,
  proprietario_documento_foto_url text,  -- RG ou CNH do proprietário

  -- loja (negócio)
  cnpj text,
  cnpj_documento_foto_url text,   -- cartão CNPJ ou contrato social
  endereco_loja text,
  numero_loja text,
  cep_loja text,

  -- localização real da loja (sessão de go-to-market, 15/08/2026) — achado
  -- real: tenants não tinha lat/lng nenhum, então o motor de despacho não
  -- tinha como calcular "entregador dentro do raio_chamada_motoboy_km".
  -- Geocodificar endereco_loja exigiria contratar um provedor externo
  -- (Google/Mapbox/Nominatim) — decisão de produto ainda não tomada, mesma
  -- categoria de dependência do Pix. Resolvido SEM depender de terceiro:
  -- captura via geolocalização do próprio navegador (mesmo mecanismo já
  -- usado em entregadores), um botão em painel-loja.html que o dono aperta
  -- uma vez no local físico da loja. Nullable — motor de despacho trata
  -- null como "sem geofiltro, considera todos os disponíveis do tenant".
  lat double precision,
  lng double precision,

  -- segmento (seção 33) — alimenta um ponto de partida razoável de tempo de
  -- preparo antes de acumular histórico próprio (seção 32)
  segmento text
    check (segmento in ('acai_sorveteria', 'padaria', 'hamburgueria', 'pizzaria',
                          'salgaderia', 'lanchonete', 'doceria_bolos', 'sushi_japonesa', 'outro')),
  tempo_preparo_padrao_min integer,  -- pré-preenche o campo por pedido; cozinha pode sobrescrever

  -- parâmetros de tarifa do motoboy — calibrados para São Paulo (capital);
  -- cada tenant pode ajustar os seus se operar em outra cidade
  tarifa_minima numeric(10,2) not null default 10.00,        -- valor mínimo por rota, já cobre o km_minimo_incluso
  km_minimo_incluso numeric(5,2) not null default 2.00,       -- km cobertos pela tarifa mínima, sem custo adicional
  valor_por_km_adicional numeric(10,2) not null default 2.00, -- cobrado só sobre o que exceder o km_minimo_incluso

  -- raios de despacho (seção 33) — dois conceitos diferentes:
  -- 1) distância pra CHAMAR o motoboy até a loja
  -- 2) distância máxima confortável da ENTREGA em si, da loja até o cliente
  raio_chamada_motoboy_km numeric(4,1) not null default 1.5,
  raio_maximo_entrega_km numeric(4,1) not null default 6.0,

  -- item 36 (25/08/2026): teto da busca EXPANDIDA — se ninguém disponível
  -- dentro de raio_chamada_motoboy_km, o motor de despacho procura de novo
  -- até este raio maior antes de desistir. Motoboy chamado de fora do
  -- perímetro normal recebe km adicional pela distância excedente (mesma
  -- tarifa por km de valor_por_km_adicional, ver gerar_repasse_ao_entregar())
  -- — antes disso o comentário acima dizia "além disso não compensa pra
  -- ele", que deixou de ser verdade com essa mudança.
  raio_chamada_maximo_km numeric(4,1) not null default 3.0,

  -- LGPD (seção 37) — carimbo de quando o proprietário aceitou os termos
  -- de tratamento de dados; sem isso não tem como provar consentimento
  consentimento_lgpd_aceito_em timestamptz,

  -- % do valor do pedido reembolsado ao cliente quando ele não é localizado
  -- após o protocolo de contato (ver tentativas_contato) se esgotar
  percentual_reembolso_sem_contato numeric(5,2) not null default 50.00,

  -- tempo de espera do motoboy (loja ou endereço do cliente): tolerado sem custo
  -- até um limite, remunerado à parte a partir daí — ataca a dor de "espera não paga"
  tempo_espera_tolerado_min integer not null default 10,
  valor_por_minuto_espera_excedente numeric(10,2) not null default 0.50,

  -- infraestrutura de apoio oferecida ao entregador — vira critério de reputação
  -- da loja entre os motoboys, não só operacional
  oferece_banheiro boolean not null default true,
  oferece_abrigo_chuva boolean not null default true,

  -- chave Pix da loja: usada pra gerar o QR Code dinâmico cobrado do cliente
  -- na entrega (seção 15) — o pagamento cai direto aqui, sem intermediário
  chave_pix text,

  -- frequência do repasse automatizado ao motoboy (seção 16): por entrega
  -- (paga segundos após cada entrega) ou em lote no fim do turno
  frequencia_repasse text not null default 'por_entrega'
    check (frequencia_repasse in ('por_entrega', 'fim_de_turno')),

  -- fadiga (seção 19): a partir de quantas horas ativas seguidas sem pausa o
  -- sistema alerta ao finalizar, e por quanto tempo bloqueia reativação se
  -- ele finalizar mesmo assim
  horas_alerta_fadiga numeric(4,1) not null default 8.0,
  horas_descanso_obrigatorio numeric(4,1) not null default 8.0,

  -- repique da notificação de despacho (seção 23): repete o mesmo toque calmo
  -- a cada N segundos até aceitar ou até o timeout, quando falha automático
  -- pro próximo entregador disponível (redundância, seção 12)
  segundos_repique_notificacao integer not null default 8,
  segundos_timeout_despacho integer not null default 24,

  -- detecção de desvio de rota (seção 26) — nunca aciona 190 sozinho;
  -- só depois de aguardar confirmação do próprio entregador
  km_desvio_alerta numeric(5,2) not null default 3.0,
  segundos_para_confirmar_seguranca integer not null default 90,

  -- detecção de "motoboy parado" (posição sem mudar durante uma entrega
  -- ativa) — padrão adaptado do Torre (fleet-orchestrator), que resolve o
  -- mesmo problema pra drone. 180s (3 min) por padrão, mais tolerante que
  -- o equivalente do Torre porque motoboy legitimamente para em semáforo/
  -- trânsito/estacionamento — cada tenant pode calibrar o seu
  segundos_parado_alerta integer not null default 180,

  -- ajuste de tempo de preparo (seção 31.3) — multiplicador aplicado sobre
  -- tempo_preparo_estimado_min ao calcular pronto_previsto_em, atualizado
  -- periodicamente a partir do histórico real (pedidos.pronto_em vs
  -- pedidos.tempo_preparo_estimado_min). 1.00 = sem ajuste (padrão até
  -- acumular dados suficientes); >1 = cozinha costuma subestimar
  fator_ajuste_preparo numeric(4,2) not null default 1.00,
  ajuste_preparo_atualizado_em timestamptz,

  -- mesma marca explícita de teste de entregadores.is_teste (ver comentário
  -- lá) — sessão de 19/08/2026, ferramenta painel-dev.html. Cadastro real
  -- (cadastro-loja.html) nunca expõe esse campo, fica false por padrão.
  is_teste boolean not null default false,

  -- painel-admin.html (Visão Geral, sessão de 23/08/2026) — status
  -- administrativo manual, decidido só pelo admin da plataforma, não pela
  -- própria loja (protegido por trigger, ver proteger_habilitado_tenant()
  -- mais abaixo — a policy de UPDATE existente da loja não tem WITH CHECK
  -- nenhum, sem essa proteção a loja se autoreabilitaria/autossuspenderia
  -- direto via PostgREST). Independente de atividade/painel aberto — só
  -- decide se a loja PODE operar, não se está operando de fato agora.
  habilitado boolean not null default true,
  -- heartbeat: painel-loja.html grava aqui a cada ~30s enquanto a aba
  -- estiver aberta (ver mostrarApp() em painel-loja.html). Usada só pra
  -- derivar "painel aberto agora" no painel-admin — não precisa da mesma
  -- proteção de habilitado, é a própria loja quem tem que escrever.
  painel_ativo_em timestamptz,

  criado_em timestamptz not null default now()
);

-- ------------------------------------------------------------
-- ENTREGADORES: motoboys de cada tenant
-- ------------------------------------------------------------
create table if not exists entregadores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  nome text not null,
  telefone text,
  status text not null default 'offline'
    check (status in ('offline', 'disponivel', 'pausado', 'a_caminho_da_loja', 'em_rota', 'na_loja')),
  -- achado real (sessão de go-to-market, 15/08/2026): clicarContinuar() em
  -- app-entregador.html sempre resetava status pra 'disponivel', o que era
  -- teórico até o motor de despacho real existir (agora usa a_caminho_da_loja/
  -- em_rota de verdade) — pausar no meio de uma entrega e retomar fazia o
  -- entregador parecer disponível pro motor enquanto ainda estava com um
  -- pedido em mãos, podendo receber uma segunda oferta indevida. Guarda o
  -- status de antes da pausa pra restaurar certo, não sempre 'disponivel'.
  status_antes_pausa text
    check (status_antes_pausa is null or status_antes_pausa in ('offline', 'disponivel', 'a_caminho_da_loja', 'em_rota', 'na_loja')),
  lat double precision,
  lng double precision,
  localizacao_atualizada_em timestamptz,
  possui_maquininha boolean not null default false, -- necessário pra rotear pedidos pagos no cartão

  -- vínculo: motoboy fixo (custo já pago, independe do volume) x freelance (pago por entrega)
  tipo_vinculo text not null default 'freelance'
    check (tipo_vinculo in ('fixo', 'freelance')),
  valor_fixo numeric(10,2),         -- só se tipo_vinculo = 'fixo': valor da diária ou mensalidade
  periodicidade_fixo text
    check (periodicidade_fixo in ('diaria', 'mensal')),

  -- chave Pix do motoboy: usada pro repasse em lote no fim do turno (seção 16)
  chave_pix text,

  -- bloqueio temporário de descanso obrigatório (seção 19) — impede iniciar
  -- novo turno antes desse horário; null = sem bloqueio ativo
  bloqueado_ate timestamptz,

  -- pausar durante uma entrega em andamento (seção 33): não interrompe a
  -- rota atual, só impede receber a próxima assim que essa terminar
  pausar_apos_rota_atual boolean not null default false,

  -- LGPD (seção 37/38)
  consentimento_lgpd_aceito_em timestamptz,
  dados_anonimizados_em timestamptz,  -- preenchido quando ele pede exclusão (ver seção 38);
                                        -- CPF/RG/endereço/fotos são apagados, mas repasses e
                                        -- entregas continuam existindo pra fechar a contabilidade

  -- app externo usado pra navegação (seção 21) — GiroCerto traça a rota
  -- (OSRM) mas a navegação turn-by-turn com radar/acidente/obra é feita
  -- por deep link pro app que ele já usa e confia
  app_navegacao_preferido text not null default 'waze'
    check (app_navegacao_preferido in ('waze', 'google_maps')),

  -- ------------------------------------------------------------
  -- DOCUMENTAÇÃO E VERIFICAÇÃO (seção 24)
  -- ------------------------------------------------------------
  tipo_veiculo text not null default 'moto'
    check (tipo_veiculo in ('moto', 'bicicleta')),
  data_nascimento date,  -- usado só pra checar faixa etária (15–18 = só bicicleta)

  -- identidade e endereço
  cpf text,          -- moto (vinculado à CNH)
  rg_numero text,     -- bicicleta
  endereco text,
  numero_residencia text,
  cep text,

  -- documentos moto
  cnh_numero text,
  cnh_validade date,
  cnh_foto_url text,
  crlv_validade date,          -- documento da moto (CRLV)
  crlv_foto_url text,
  placa text,
  comprovante_residencia_foto_url text,

  -- controle de aviso de vencimento (seção 33) — evita mandar a mesma
  -- mensagem repetida; reseta quando o documento é atualizado
  cnh_alerta_enviado_em timestamptz,
  crlv_alerta_enviado_em timestamptz,

  -- documentos bicicleta (15–18 anos)
  foto_rg_url text,
  foto_rg_segurando_url text,  -- selfie segurando o RG, confere identidade
  foto_bicicleta_url text,
  responsavel_nome text,               -- exigido se menor de 18 (ver nota na seção 24)
  responsavel_documento_foto_url text,

  -- status da verificação — o "reprovado" automático (documento vencido)
  -- acontece na hora; o "aprovado"/"reprovado" manual tem prazo de até 7 dias
  status_verificacao text not null default 'em_avaliacao'
    check (status_verificacao in ('em_avaliacao', 'aprovado', 'reprovado')),
  -- TEXT único, não array — só guarda 1 motivo por vez. Se no futuro for
  -- necessário registrar múltiplos motivos simultâneos de reprovação,
  -- isso exige migração (ex: tabela separada ou virar array). Não mexer
  -- agora, só documentado.
  motivo_reprovacao text
    check (motivo_reprovacao in ('cnh_vencida', 'crlv_vencido', 'documento_ilegivel', 'informacao_divergente', 'outro')),
  verificacao_enviada_em timestamptz,
  -- prazo de avaliação (seção 24): antes era coluna gerada, mas
  -- "timestamptz + interval" não é imutável pro Postgres (depende do fuso
  -- da sessão) — erro 42P17 ao criar a tabela. Agora é preenchido pela
  -- aplicação no momento do cadastro (ver app-entregador.html):
  -- verificacao_prazo_limite = verificacao_enviada_em + 7 dias
  verificacao_prazo_limite timestamptz,
  aprovado_por uuid,  -- referencia usuarios_loja(id); FK adicionada após a criação dessa tabela, mais abaixo
  aprovado_em timestamptz,

  -- marca explícita de cadastro de TESTE (ferramenta interna painel-dev.html,
  -- sessão de 19/08/2026) — não depende de heurística de nome/e-mail, que é
  -- frágil (falso positivo/negativo). Setado via metadata opcional `is_teste`
  -- no signUp() (ver provisionar_cadastro_pos_signup() mais abaixo); cadastro
  -- real (app-entregador.html, formulário do motoboy) nunca expõe esse campo,
  -- então fica false por padrão sempre que vier de lá.
  is_teste boolean not null default false,

  -- ------------------------------------------------------------
  -- ACESSO AO SISTEMA (seção 26) — a senha em si NUNCA fica nesta
  -- tabela: o Supabase Auth já cuida do hash/força da senha; aqui
  -- só guardamos o vínculo e o identificador de login alternativo
  -- ------------------------------------------------------------
  auth_user_id uuid references auth.users(id),
  email text,             -- login por e-mail (alternativa ao CPF)

  criado_em timestamptz not null default now()
);

create unique index if not exists idx_entregadores_email
  on entregadores (email) where email is not null;

create unique index if not exists idx_entregadores_auth_user
  on entregadores (auth_user_id) where auth_user_id is not null;

create index if not exists idx_entregadores_status_verificacao
  on entregadores (tenant_id, status_verificacao);

create index if not exists idx_entregadores_tenant_status
  on entregadores (tenant_id, status);

-- ------------------------------------------------------------
-- USUARIOS_LOJA: quem faz login no painel do lojista (dono e/ou
-- funcionários do balcão) — faltava esse vínculo até agora; sem
-- ele não dá pra saber "de qual loja é essa pessoa logada" pra
-- aplicar RLS (seção 37) de forma nenhuma
-- ------------------------------------------------------------
create table if not exists usuarios_loja (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id),
  nome text not null,
  papel text not null default 'funcionario'
    check (papel in ('dono', 'funcionario')),

  -- PIN de segurança pra aba de Integrações (seção 40) — nunca guardado em
  -- texto puro, sempre hash via pgcrypto (crypt/gen_salt); definido e
  -- verificado só pelas funções abaixo, nunca por update direto na tabela
  pin_integracoes_hash text,

  criado_em timestamptz not null default now()
);

create unique index if not exists idx_usuarios_loja_auth_user
  on usuarios_loja (auth_user_id);

create index if not exists idx_usuarios_loja_tenant
  on usuarios_loja (tenant_id);

alter table entregadores
  add constraint fk_entregadores_aprovado_por
  foreign key (aprovado_por) references usuarios_loja(id);

-- ------------------------------------------------------------
-- HORARIOS_FUNCIONAMENTO: dias e períodos em que a loja realmente
-- opera (seção 33) — o motor de despacho só chama motoboy dentro
-- desses períodos, resolvendo o "motoboy chegou e a loja tava
-- fechada" (esqueceram de fechar em outra plataforma, etc.)
-- ------------------------------------------------------------
create table if not exists horarios_funcionamento (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 0 and 6), -- 0=domingo ... 6=sábado
  periodo_inicio time not null,
  periodo_fim time not null,
  criado_em timestamptz not null default now()
);

create index if not exists idx_horarios_funcionamento_tenant
  on horarios_funcionamento (tenant_id, dia_semana);

-- ------------------------------------------------------------
-- TURNOS: sessão de trabalho do motoboy — do "iniciar turno" ao
-- "finalizar turno" (seção 17). Agrupa as entregas e dispara o
-- repasse acumulado quando ele encerra, se frequencia_repasse
-- do tenant for 'fim_de_turno'.
-- ------------------------------------------------------------
create table if not exists turnos (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid not null references entregadores(id) on delete cascade,
  status text not null default 'ativo'
    check (status in ('ativo', 'finalizado')),
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  teve_pausa boolean not null default false,  -- true assim que ele pausar ao menos 1 vez nesse turno
  ultimo_checkin_bemestar timestamptz not null default now(), -- seção 20: reinicia a cada 1h de turno ativo
  total_entregas integer,          -- calculado ao finalizar
  total_repassado numeric(10,2),   -- calculado ao finalizar, soma do que foi pago nesse turno
  criado_em timestamptz not null default now()
);

create index if not exists idx_turnos_entregador_status
  on turnos (entregador_id, status);

-- ------------------------------------------------------------
-- ROTAS_ENTREGA: agrupamento de pedidos numa mesma saída do motoboy
-- (criada antes de PEDIDOS porque pedidos referencia rota_id)
-- ------------------------------------------------------------
create table if not exists rotas_entrega (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entregador_id uuid references entregadores(id),

  status text not null default 'planejada'
    check (status in ('planejada', 'a_caminho_da_loja', 'em_entrega', 'concluida', 'cancelada')),

  tempo_total_estimado_min integer,
  despachado_em timestamptz,   -- momento em que o motoboy foi efetivamente chamado
  chegou_loja_em timestamptz,  -- motoboy chegou na loja (item 34, antes de retirar)
  iniciada_em timestamptz,     -- motoboy saiu da loja com os pedidos
  concluida_em timestamptz,
  -- item 36 (25/08/2026): distância até a loja no momento em que essa rota
  -- foi oferecida e aceita (copiada de tentativas_despacho.distancia_km
  -- quando a tentativa vira 'aceito', ver tratarRespostaDespacho() em
  -- dispatch-engine/index.js) — usado por gerar_repasse_ao_entregar() pra
  -- pagar km adicional quando o motoboy veio de fora do raio_chamada_motoboy_km normal.
  distancia_chamada_km numeric(6,2),

  -- código de retirada (seção 24): loja e motoboy veem o mesmo número;
  -- ele fala esse código na loja pra confirmar que é quem deveria pegar
  codigo_retirada text not null default lpad(floor(random() * 10000)::text, 4, '0'),

  -- traçado planejado (polyline do OSRM) — necessário pra detectar desvio
  -- de rota (seção 26); sem isso não dá pra saber "quanto ele se afastou"
  rota_polyline text,

  criado_em timestamptz not null default now()
);

create index if not exists idx_rotas_tenant_status
  on rotas_entrega (tenant_id, status);

-- ------------------------------------------------------------
-- Unicidade de codigo_retirada (seção A2): o DEFAULT sozinho só sorteia
-- entre 10.000 combinações, sem garantir que não colide com outra rota
-- ativa do mesmo tenant. O índice único parcial abaixo é a garantia real
-- (só entre status não-terminal, onde colisão importa de verdade); o
-- trigger evita a colisão na prática ANTES de chegar no índice, tentando
-- de novo até achar um código livre — a aplicação só veria um erro de
-- unicidade no caso raro de corrida entre duas inserções simultâneas
-- (2 rotas criadas no mesmíssimo instante disputando o mesmo código
-- sorteado), que o índice ainda pega mesmo assim.
create unique index if not exists idx_rotas_codigo_retirada_ativo
  on rotas_entrega (tenant_id, codigo_retirada)
  where status in ('planejada', 'a_caminho_da_loja', 'em_entrega');

create or replace function gerar_codigo_retirada_unico()
returns trigger
language plpgsql
as $$
declare
  v_tentativas int := 0;
begin
  while exists (
    select 1 from rotas_entrega
    where tenant_id = new.tenant_id and codigo_retirada = new.codigo_retirada
      and status in ('planejada', 'a_caminho_da_loja', 'em_entrega')
      and id is distinct from new.id
  ) loop
    new.codigo_retirada := lpad(floor(random() * 10000)::text, 4, '0');
    v_tentativas := v_tentativas + 1;
    exit when v_tentativas > 50; -- teto de segurança; índice único acima ainda protege se isso falhar
  end loop;
  return new;
end;
$$;

create trigger trg_codigo_retirada_unico
  before insert on rotas_entrega
  for each row execute function gerar_codigo_retirada_unico();

-- ------------------------------------------------------------
-- TENTATIVAS_DESPACHO: cada vez que um entregador é chamado pra
-- uma rota — registra repique/timeout e viabiliza o failover
-- automático pro próximo disponível (seção 23)
-- ------------------------------------------------------------
create table if not exists tentativas_despacho (
  id uuid primary key default gen_random_uuid(),
  rota_id uuid not null references rotas_entrega(id) on delete cascade,
  -- sem on delete cascade aqui, apagar um tenant travava com FK violation assim
  -- que o entregador tivesse alguma tentativa de despacho registrada — achado
  -- real ao rodar a suíte de testes de despacho contra o banco hospedado.
  entregador_id uuid not null references entregadores(id) on delete cascade,
  notificado_em timestamptz not null default now(),
  resultado text
    check (resultado in ('aceito', 'recusado', 'sem_resposta')),
  respondido_em timestamptz,
  -- item 36 (25/08/2026): distância do entregador até a loja no momento da
  -- oferta (calculada em buscarProximoCandidato(), dispatch-engine/index.js)
  -- — persistida aqui pra, se essa tentativa for aceita, virar
  -- rotas_entrega.distancia_chamada_km e alimentar o km adicional do
  -- repasse. Null quando o tenant ainda não tem lat/lng (sem geofiltro).
  distancia_km numeric(6,2)
);

create index if not exists idx_tentativas_despacho_rota
  on tentativas_despacho (rota_id);

-- ------------------------------------------------------------
-- LOCALIZACOES_ENTREGADOR: histórico de posição (não só a atual),
-- alimenta o detector de desvio de rota e serve de log bruto de
-- telemetria (princípio da seção 12 — decisão de despacho não é
-- a única coisa que vale registrar, o trajeto real também)
-- ------------------------------------------------------------
create table if not exists localizacoes_entregador (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid not null references entregadores(id) on delete cascade,
  rota_id uuid references rotas_entrega(id),  -- null se não estiver em rota
  lat double precision not null,
  lng double precision not null,
  registrado_em timestamptz not null default now(),

  -- calculado por trigger (preencher_dentro_da_rota, ver seção de
  -- SEGURANÇA mais abaixo) no momento do INSERT: true/false = a posição
  -- está dentro/fora do raio de tolerância da polyline planejada; null =
  -- não havia rota/polyline pra comparar ainda. Guardado na própria
  -- linha (em vez de recalculado depois) pra tornar trivial checar "as
  -- últimas 2 leituras seguidas estão fora" sem reprocessar a polyline
  -- toda vez.
  dentro_da_rota boolean
);

create index if not exists idx_localizacoes_entregador_tempo
  on localizacoes_entregador (entregador_id, registrado_em);

create index if not exists idx_localizacoes_rota
  on localizacoes_entregador (rota_id);

-- ------------------------------------------------------------
-- ALERTAS_SEGURANCA: desvio de rota além do limite ou SOS manual
-- (seção 26) — fluxo de confirmação humana antes de qualquer
-- escalonamento, nunca aciona 190 sozinho e em silêncio
-- ------------------------------------------------------------
create table if not exists alertas_seguranca (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid not null references entregadores(id) on delete cascade,
  rota_id uuid references rotas_entrega(id),
  -- 'motoboy_parado' adicionado seguindo o mesmo fluxo de confirmação
  -- humana dos outros dois tipos (nunca aciona 190 sozinho) — ver
  -- avaliar_alertas_seguranca_localizacao() na seção de SEGURANÇA mais
  -- abaixo, padrão adaptado do Torre (fleet-orchestrator)
  tipo text not null check (tipo in ('desvio_rota', 'sos_manual', 'motoboy_parado')),
  distancia_desvio_km numeric(6,2),
  status text not null default 'aguardando_confirmacao'
    check (status in ('aguardando_confirmacao', 'confirmado_ok', 'escalado_loja', 'acionado_190', 'falso_alarme')),
  criado_em timestamptz not null default now(),
  resolvido_em timestamptz
);

create index if not exists idx_alertas_seguranca_entregador
  on alertas_seguranca (entregador_id, status);

-- ------------------------------------------------------------
-- PEDIDOS: cada pedido a ser entregue
-- ------------------------------------------------------------
create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,

  -- de onde o pedido veio (GiroCerto não tem cardápio próprio — recebe de fora)
  origem text not null default 'manual'
    check (origem in ('manual', 'whatsapp', 'ifood', 'cardapio_proprio')),
  cliente_nome text,
  cliente_telefone text,   -- usado pro motoboy contatar e pra enviar o link de rastreio

  -- código de entrega (seção 24): enviado ao cliente por WhatsApp junto com o
  -- aviso "a caminho"; o cliente fala esse código pro motoboy na porta
  codigo_entrega text not null default lpad(floor(random() * 10000)::text, 4, '0'),

  -- endereço de entrega
  endereco text not null,
  lat double precision,
  lng double precision,

  -- ciclo de vida do pedido, incluindo o status de preparo na cozinha
  status text not null default 'recebido'
    check (status in (
      'recebido',      -- pedido entrou no sistema
      'em_preparo',    -- cozinha começou a preparar
      'pronto',        -- cozinha finalizou
      'a_caminho',     -- motoboy pegou e está entregando
      'entregue',      -- concluído
      'cancelado'
    )),

  -- campos centrais para o despacho no tempo certo
  tempo_preparo_estimado_min integer,      -- input manual da cozinha, ex: 12
  pronto_previsto_em timestamptz,          -- criado_em + tempo_preparo_estimado_min (recalculável)
  tempo_deslocamento_loja_min integer,     -- calculado via OSRM (distância motoboy -> loja)

  -- roteirização
  rota_id uuid references rotas_entrega(id),
  ordem_na_rota integer,                   -- posição da parada dentro da rota

  -- financeiro: valor do pedido (o que o cliente paga) e valor de entrega (o que vai pro motoboy)
  valor_pedido numeric(10,2) not null default 0,
  valor_entrega numeric(10,2),

  -- forma de pagamento — v1 só usa 'pix' (pago_antecipado=true = online antes da
  -- saída; pago_antecipado=false = QR Code dinâmico na entrega, seção 15/16).
  -- 'cartao' e 'dinheiro' ficam reservados no schema pra Fase 2 (não oferecidos
  -- na UI do v1) — assim uma eventual reativação não exige migração de banco.
  forma_pagamento text not null default 'pix'
    check (forma_pagamento in ('pix', 'cartao', 'dinheiro')),
  pago_antecipado boolean not null default false,  -- true = Pix já pago antes da saída, nada a cobrar na entrega
  troco_para numeric(10,2),                        -- reservado pra Fase 2 (dinheiro) — não usado no v1
  valor_troco numeric(10,2)
    generated always as (
      case when troco_para is not null then troco_para - valor_pedido else null end
    ) stored,                                       -- calculado automaticamente: quanto devolver de troco

  -- confirmação de pagamento — serve tanto pro Pix antecipado quanto pro Pix
  -- na entrega via QR Code dinâmico (ver seção 14); pix_txid é o identificador
  -- da cobrança no provedor (Mercado Pago/Stone/etc.), útil pra conciliação
  pago boolean not null default false,
  pago_em timestamptz,
  pix_txid text,

  criado_em timestamptz not null default now(),
  pronto_em timestamptz,
  chegou_entrega_em timestamptz,  -- motoboy chegou no destino (item 34, antes de digitar o código)
  entregue_em timestamptz,

  -- protocolo de "não encontrei o cliente": true enquanto as tentativas de
  -- contato (ver tentativas_contato) ainda não resolveram a entrega
  contato_pendente boolean not null default false,

  -- resolução quando o protocolo de contato se esgota sem sucesso.
  -- TEXT único, não array — mesma observação de entregadores.motivo_reprovacao
  -- acima: só guarda 1 motivo por vez, migração futura se precisar de mais.
  motivo_cancelamento text
    check (motivo_cancelamento in ('cliente_nao_localizado')),
  valor_reembolsado numeric(10,2),   -- calculado a partir de tenants.percentual_reembolso_sem_contato
  item_retorna_loja boolean not null default true, -- false = motoboy liberado, não precisa voltar com o pedido

  -- avaliação da ENTREGA (não do pedido/comida) — coletada pelo link de rastreio (seção 7),
  -- serve pra separar reclamação de comida (não é conosco) de reclamação de entrega (é conosco)
  avaliacao_entrega smallint check (avaliacao_entrega between 1 and 5),
  avaliacao_comentario text,

  -- tipo de local (afeta tempo estimado de parada) e tempo de espera medido —
  -- usado pra calcular o bônus de espera excedente (ver tenants)
  tipo_local text not null default 'casa'
    check (tipo_local in ('casa', 'apartamento', 'comercial')),
  tempo_espera_min integer  -- medido pelo app: entre chegada no local e conclusão da parada
);

create index if not exists idx_pedidos_tenant_status
  on pedidos (tenant_id, status);

create index if not exists idx_pedidos_rota
  on pedidos (rota_id);

create index if not exists idx_pedidos_tenant_forma_pagamento
  on pedidos (tenant_id, forma_pagamento);

-- Mesma lógica de unicidade de codigo_retirada acima (seção A2), aplicada
-- a codigo_entrega.
create unique index if not exists idx_pedidos_codigo_entrega_ativo
  on pedidos (tenant_id, codigo_entrega)
  where status not in ('entregue', 'cancelado');

create or replace function gerar_codigo_entrega_unico()
returns trigger
language plpgsql
as $$
declare
  v_tentativas int := 0;
begin
  while exists (
    select 1 from pedidos
    where tenant_id = new.tenant_id and codigo_entrega = new.codigo_entrega
      and status not in ('entregue', 'cancelado')
      and id is distinct from new.id
  ) loop
    new.codigo_entrega := lpad(floor(random() * 10000)::text, 4, '0');
    v_tentativas := v_tentativas + 1;
    exit when v_tentativas > 50;
  end loop;
  return new;
end;
$$;

create trigger trg_codigo_entrega_unico
  before insert on pedidos
  for each row execute function gerar_codigo_entrega_unico();

-- ------------------------------------------------------------
-- TENTATIVAS_CONTATO: histórico de ligações/mensagens quando o
-- motoboy não encontra o cliente no endereço
-- ------------------------------------------------------------
create table if not exists tentativas_contato (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos(id) on delete cascade,
  tipo text not null check (tipo in ('ligacao', 'mensagem')),
  resultado text check (resultado in ('atendeu', 'nao_atendeu', 'sem_resposta', 'respondeu')),
  criado_em timestamptz not null default now()
);

create index if not exists idx_tentativas_pedido
  on tentativas_contato (pedido_id);

-- ------------------------------------------------------------
-- COMPROVANTES_ENTREGA: prova de entrega (foto + geolocalização)
-- ------------------------------------------------------------
create table if not exists comprovantes_entrega (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos(id) on delete cascade,
  foto_url text,
  lat double precision,
  lng double precision,
  codigo_confirmado boolean not null default false, -- true = cliente informou o código certo (seção 24)
  criado_em timestamptz not null default now()
);

-- ------------------------------------------------------------
-- REPASSES: valor devido a cada entregador por pedido entregue,
-- pago via API de Pix do provedor da loja (seção 16) — status muda
-- pra 'pago' automaticamente quando a transferência é confirmada,
-- sem ação manual da loja por entregador
-- ------------------------------------------------------------
create table if not exists repasses (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid not null references entregadores(id) on delete cascade,
  pedido_id uuid not null references pedidos(id) on delete cascade,
  turno_id uuid references turnos(id),  -- turno em que a entrega ocorreu (seção 17)
  valor numeric(10,2) not null,
  status text not null default 'pendente'
    check (status in ('pendente', 'pago')),
  pix_txid text,      -- identificador da transferência Pix enviada (confirmação da API)
  pago_em timestamptz,
  criado_em timestamptz not null default now()
);

create index if not exists idx_repasses_entregador_status
  on repasses (entregador_id, status);

-- ------------------------------------------------------------
-- MOTOR DE REPASSE (item 35, 25/08/2026, ampliado no item 36) — tarifa
-- mínima + espera excedente + km adicional de CHAMADA (distância do
-- motoboy até a loja, quando veio de fora do raio normal — ver
-- raio_chamada_maximo_km em tenants). NÃO inclui km adicional da
-- ENTREGA em si (loja -> cliente): pedidos de restaurante guardam o
-- endereço de entrega só como texto livre (sem latitude/longitude própria,
-- diferente de pedido_grupo da feira), não tem como medir essa distância
-- hoje sem adicionar geocodificação do endereço do cliente — segue de fora.
--
-- tarifa_minima é "por rota" (ver comentário na coluna, em tenants), não
-- por pedido — dividida igualmente entre os pedidos da mesma rota pra não
-- pagar em dobro/triplo numa rota com mais de 1 parada. Espera na loja
-- (chegou_loja_em -> iniciada_em, nível de ROTA, compartilhada por todas as
-- paradas) e km de chamada (idem, nível de rota) seguem a mesma divisão;
-- espera no cliente (chegou_entrega_em -> entregue_em, item 34) é só do
-- próprio pedido, sem divisão. BEFORE UPDATE (não AFTER) porque também
-- grava pedidos.tempo_espera_min na mesma linha, além de inserir em
-- repasses.
--
-- SECURITY DEFINER: quem dispara é sempre o UPDATE direto de
-- confirmarEntrega() (client, sem RPC), rodando como o próprio entregador
-- comum — repasses não tem NENHUMA policy de INSERT client-side de
-- propósito (geração é 100% backend). Sem checagem de posse própria aqui
-- porque o UPDATE que dispara o trigger já passou pela RLS de pedidos
-- (policy "entregador atualiza status dos pedidos das suas rotas") — só
-- quem já é dono da rota chega a esse ponto.
create or replace function gerar_repasse_ao_entregar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rota record;
  v_tenant record;
  v_qtd_pedidos integer;
  v_espera_loja_min numeric;
  v_espera_cliente_min numeric;
  v_espera_total_min numeric;
  v_excedente_min numeric;
  v_km_chamada_excedente numeric;
  v_valor numeric;
  v_turno_id uuid;
begin
  if new.status <> 'entregue' or old.status is not distinct from 'entregue' then
    return new;
  end if;

  select * into v_rota from rotas_entrega where id = new.rota_id;
  if v_rota.entregador_id is null then
    return new;
  end if;

  select * into v_tenant from tenants where id = new.tenant_id;

  select count(*) into v_qtd_pedidos from pedidos where rota_id = new.rota_id;
  v_qtd_pedidos := greatest(v_qtd_pedidos, 1);

  v_espera_loja_min := 0;
  if v_rota.chegou_loja_em is not null and v_rota.iniciada_em is not null then
    v_espera_loja_min := extract(epoch from (v_rota.iniciada_em - v_rota.chegou_loja_em)) / 60.0 / v_qtd_pedidos;
  end if;

  v_espera_cliente_min := 0;
  if new.chegou_entrega_em is not null and new.entregue_em is not null then
    v_espera_cliente_min := extract(epoch from (new.entregue_em - new.chegou_entrega_em)) / 60.0;
  end if;

  v_espera_total_min := v_espera_loja_min + v_espera_cliente_min;
  new.tempo_espera_min := round(v_espera_total_min);

  v_excedente_min := greatest(0, v_espera_total_min - coalesce(v_tenant.tempo_espera_tolerado_min, 0));

  -- item 36 (25/08/2026): km adicional quando o motoboy foi chamado de fora
  -- do raio_chamada_motoboy_km normal (busca expandida em
  -- buscarProximoCandidato(), dispatch-engine/index.js) — distância de
  -- CHAMADA (motoboy até a loja), não a distância da entrega em si (essa
  -- não é medida hoje, endereço do cliente não é geocodificado, ver
  -- comentário no início desta função). Nível de rota, dividido igualmente
  -- entre os pedidos, mesma lógica de tarifa_minima/espera na loja acima.
  v_km_chamada_excedente := greatest(0,
    coalesce(v_rota.distancia_chamada_km, 0) - coalesce(v_tenant.raio_chamada_motoboy_km, 0)
  ) / v_qtd_pedidos;

  v_valor := coalesce(v_tenant.tarifa_minima, 0) / v_qtd_pedidos
    + v_excedente_min * coalesce(v_tenant.valor_por_minuto_espera_excedente, 0)
    + v_km_chamada_excedente * coalesce(v_tenant.valor_por_km_adicional, 0);
  v_valor := round(v_valor, 2);
  new.valor_entrega := v_valor;

  select id into v_turno_id from turnos
  where entregador_id = v_rota.entregador_id and status = 'ativo'
  order by iniciado_em desc limit 1;

  insert into repasses (entregador_id, pedido_id, turno_id, valor, status)
  values (v_rota.entregador_id, new.id, v_turno_id, v_valor, 'pendente');

  return new;
end;
$$;

create trigger trg_gerar_repasse_ao_entregar
before update on pedidos
for each row execute function gerar_repasse_ao_entregar();

-- ------------------------------------------------------------
-- AVALIACOES_LOJA: o motoboy avalia a loja ao finalizar o turno
-- (seção 31.2) — base do Selo Entrega Justa. Diferente de
-- oferece_banheiro/oferece_abrigo_chuva (autodeclarado), isso é
-- feedback real de quem trabalhou lá, não dá pra forjar sozinho.
-- ------------------------------------------------------------
create table if not exists avaliacoes_loja (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entregador_id uuid not null references entregadores(id) on delete cascade,
  turno_id uuid references turnos(id),
  nota smallint not null check (nota between 1 and 5),
  comentario text,
  criado_em timestamptz not null default now()
);

create index if not exists idx_avaliacoes_loja_tenant
  on avaliacoes_loja (tenant_id, criado_em);

-- ------------------------------------------------------------
-- ENTREGADORES_VERIFICACAO_VENCIDA (achado A1): verificacao_prazo_limite
-- é gravado no cadastro (ver enviarCadastro() em app-entregador.html),
-- mas nada consumia esse prazo até agora. Esta view sinaliza cadastros
-- 'em_avaliacao' cujo prazo já passou, sem decisão (aprovado/reprovado)
-- tomada. TODO real ainda pendente: hoje isso exige alguém consultar
-- essa view manualmente (ex: painel-loja.html numa aba futura de
-- Entregadores) — não existe job automático nem notificação. Quando
-- houver backend/scheduler de verdade, essa view é o ponto de partida
-- pra um cron que roda periodicamente e avisa o time de aprovação.
-- ------------------------------------------------------------
create or replace view entregadores_verificacao_vencida as
select
  e.id as entregador_id,
  e.tenant_id,
  e.nome,
  e.tipo_veiculo,
  e.verificacao_enviada_em,
  e.verificacao_prazo_limite,
  now() - e.verificacao_prazo_limite as tempo_vencido
from entregadores e
where e.status_verificacao = 'em_avaliacao'
  and e.verificacao_prazo_limite is not null
  and e.verificacao_prazo_limite < now();

-- ------------------------------------------------------------
-- REPROVAÇÃO AUTOMÁTICA POR DOCUMENTO VENCIDO + AVISO PRÉVIO (sessão de
-- resolução de pendências, 15/08/2026). Só se aplica a tipo_veiculo='moto'
-- (cnh_validade/crlv_validade não existem pra bicicleta — RG não tem
-- validade no mesmo sentido operacional). Também reprova quem já estava
-- 'aprovado' e deixou o documento vencer depois, não só quem está
-- 'em_avaliacao' — não faz sentido continuar liberado com CNH vencida só
-- porque a aprovação inicial foi antes do vencimento.
--
-- Agendado via pg_cron (extensão confirmada disponível no Supabase
-- hospedado, plano gratuito incluso) rodando de hora em hora — não é
-- tempo-crítico como o motor de despacho, então polling horário é mais que
-- suficiente. `v_dias_aviso_previo = 15` é uma escolha razoável, não veio
-- de nenhum requisito explícito — ajustar se o negócio pedir outro prazo.
--
-- O aviso prévio (*_alerta_enviado_em) só MARCA que o aviso foi disparado —
-- a entrega de verdade (WhatsApp/push) depende de integracoes.whatsapp_*,
-- que não está implementado ainda (nenhuma chamada de API real existe hoje).
-- Enquanto isso, o único canal real é o banner in-app em app-entregador.html
-- (carregarEntregador()), mostrado quando o próprio entregador abre o app —
-- não é simulação, é o canal que genuinamente existe hoje.
-- ------------------------------------------------------------
create or replace function verificar_documentos_vencidos()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias_aviso_previo constant integer := 15;
begin
  update entregadores
  set status_verificacao = 'reprovado', motivo_reprovacao = 'cnh_vencida'
  where tipo_veiculo = 'moto'
    and cnh_validade is not null
    and cnh_validade < current_date
    and status_verificacao <> 'reprovado';

  update entregadores
  set status_verificacao = 'reprovado', motivo_reprovacao = 'crlv_vencido'
  where tipo_veiculo = 'moto'
    and crlv_validade is not null
    and crlv_validade < current_date
    and status_verificacao <> 'reprovado';

  update entregadores
  set cnh_alerta_enviado_em = now()
  where tipo_veiculo = 'moto'
    and cnh_validade is not null
    and cnh_validade >= current_date
    and cnh_validade <= current_date + v_dias_aviso_previo
    and cnh_alerta_enviado_em is null
    and status_verificacao <> 'reprovado';

  update entregadores
  set crlv_alerta_enviado_em = now()
  where tipo_veiculo = 'moto'
    and crlv_validade is not null
    and crlv_validade >= current_date
    and crlv_validade <= current_date + v_dias_aviso_previo
    and crlv_alerta_enviado_em is null
    and status_verificacao <> 'reprovado';
end;
$$;

-- reseta o "já avisei" quando a validade muda pra uma data futura (renovação
-- de documento) — sem isso, alerta_enviado_em ficaria travado em true pra
-- sempre e o entregador nunca seria avisado do PRÓXIMO vencimento.
create or replace function resetar_alerta_documento_ao_renovar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.cnh_validade is distinct from old.cnh_validade then
    new.cnh_alerta_enviado_em := null;
  end if;
  if new.crlv_validade is distinct from old.crlv_validade then
    new.crlv_alerta_enviado_em := null;
  end if;
  return new;
end;
$$;

create trigger trg_resetar_alerta_documento
  before update on entregadores
  for each row execute function resetar_alerta_documento_ao_renovar();

create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'verificar-documentos-vencidos') then
    perform cron.schedule('verificar-documentos-vencidos', '0 * * * *', 'select verificar_documentos_vencidos()');
  end if;
end $$;

-- ------------------------------------------------------------
-- SELO_ENTREGA_JUSTA: view calculada em tempo real, não um campo
-- que alguém marca manualmente — exige infraestrutura declarada
-- (banheiro/abrigo) E avaliação real dos motoboys nos últimos 30
-- dias, com volume mínimo pra não dar pra manipular com 2 notas.
--
-- SEM RLS AQUI DE PROPÓSITO — decisão de produto confirmada, não um gap
-- esquecido. Esta view não declara `security_invoker = true`, então roda com
-- o privilégio de quem a criou e não escopa por tenant: qualquer sessão
-- autenticada (dono, funcionário, ou futuramente até anônima) consegue
-- consultar o selo de QUALQUER tenant, não só o próprio. Isso é intencional:
-- o Selo Entrega Justa é pensado como marca de confiança PÚBLICA — o
-- cliente final precisa conseguir comparar lojas antes mesmo de logar em
-- lugar nenhum. Escopar por tenant mataria a função do selo (ninguém
-- compararia loja nenhuma se só enxergasse a própria). É seguro manter
-- assim porque a view não expõe nada sensível: só nome da loja e agregados
-- (sem PII, sem dado financeiro, sem quem avaliou o quê — isso continua
-- protegido na tabela base `avaliacoes_loja`, que não tem policy de SELECT
-- pra ninguém além do service role). Se um ultrareview ou revisão futura
-- marcar isso como "achado" de novo, é falso positivo — já foi avaliado e
-- confirmado como comportamento correto (sessão de 14/08/2026, PR #1).
-- ------------------------------------------------------------
create or replace view selo_entrega_justa as
select
  t.id as tenant_id,
  t.nome,
  t.oferece_banheiro,
  t.oferece_abrigo_chuva,
  coalesce(avg(al.nota), 0)::numeric(3,2) as media_avaliacao_motoboys,
  count(al.id) as total_avaliacoes_30d,
  (
    t.oferece_banheiro
    and t.oferece_abrigo_chuva
    and coalesce(avg(al.nota), 0) >= 4.0
    and count(al.id) >= 10
  ) as selo_ativo
from tenants t
left join avaliacoes_loja al
  on al.tenant_id = t.id
  and al.criado_em > now() - interval '30 days'
group by t.id, t.nome, t.oferece_banheiro, t.oferece_abrigo_chuva;

-- ------------------------------------------------------------
-- painel-admin.html (Visão Geral, sessão de 23/08/2026) — 2 views de apoio.
-- Diferente de selo_entrega_justa acima (que roda como dono da view DE
-- PROPÓSITO, pública, sem escopar por tenant): aqui é o oposto, quero que
-- a view RESPEITE a RLS de quem chama (`security_invoker = true`), pra
-- ficar automaticamente restrita a admin através das policies "dev admin
-- ve todos ..." já existentes em entregadores/tenants/pedidos/
-- localizacoes_entregador — sem duplicar a checagem eh_desenvolvedor_admin()
-- aqui dentro. Cálculo de contadores acontece em JS no client (mesmo
-- estilo de painel-dev.html), estas views só entregam a linha crua por
-- entregador/tenant.
--
-- Thresholds (3min entregador / 90s loja) generosos o bastante pra
-- tolerar o throttling de aba em segundo plano já documentado neste
-- projeto (ver CLAUDE.md), sem deixar passar muito tempo de fato
-- desconectado: localizacoes_entregador grava a cada ~12s com turno
-- ativo, painel_ativo_em é gravado a cada ~30s por painel-loja.html.
-- ------------------------------------------------------------
create or replace view entregadores_presenca
with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.nome,
  e.status,
  e.status_verificacao,
  e.is_teste,
  le.ultima_posicao_em,
  coalesce(le.ultima_posicao_em > now() - interval '3 minutes', false) as online
from entregadores e
left join lateral (
  select max(l.registrado_em) as ultima_posicao_em
  from localizacoes_entregador l
  where l.entregador_id = e.id
) le on true;

create or replace view tenants_operacao
with (security_invoker = true) as
select
  t.id,
  t.nome,
  t.is_teste,
  t.habilitado,
  t.painel_ativo_em,
  coalesce(t.painel_ativo_em > now() - interval '90 seconds', false) as painel_aberto,
  p.ultimo_pedido_em,
  p.pedidos_24h
from tenants t
left join lateral (
  select
    max(criado_em) as ultimo_pedido_em,
    count(*) filter (where criado_em > now() - interval '24 hours') as pedidos_24h
  from pedidos
  where tenant_id = t.id
) p on true;

-- ------------------------------------------------------------
-- DESENVOLVEDORES_ADMIN: allowlist pra painel-dev.html (ferramenta interna,
-- sessão de 19/08/2026) — não a hamburgueria, não usuarios_loja, uma conta
-- de acesso separada só pra aprovar cadastros de teste sem SQL manual.
-- RLS habilitada e DE PROPÓSITO sem nenhuma policy: ninguém consegue ler
-- esta tabela via PostgREST (nem o próprio dev logado) — só a função
-- eh_desenvolvedor_admin() (SECURITY DEFINER, mais abaixo) e o service role
-- enxergam. Não expõe nada além do próprio auth_user_id de quem está na
-- lista, mas mantém o mesmo princípio de superfície mínima do resto do
-- schema: se não precisa ser lido por ninguém via API, não expõe SELECT.
-- ------------------------------------------------------------
create table if not exists desenvolvedores_admin (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);

-- ==============================================================
-- ROW LEVEL SECURITY (seções 37/38)
-- IMPORTANTE: o backend (Node.js, seção 4) usa a service role key
-- do Supabase pra rodar o motor de despacho, o repasse automatizado
-- e os jobs periódicos — a service role IGNORA RLS por definição.
-- Essas políticas protegem o acesso direto do cliente (app do
-- motoboy, painel do lojista falando com o Supabase), não o backend.
-- ==============================================================

-- ------------------------------------------------------------
-- ACHADO CRÍTICO (validação contra banco real, 14/08/2026): toda
-- policy que precisa saber "de qual(is) tenant(s) esse usuário faz
-- parte" fazia `select tenant_id from usuarios_loja where
-- auth_user_id = auth.uid()` diretamente. Como usuarios_loja tem RLS
-- habilitada e sua PRÓPRIA policy de select usa esse mesmo subselect,
-- resolver essa consulta reavalia a policy de usuarios_loja, que por
-- sua vez reavalia de novo — recursão infinita (Postgres 42P17), que
-- quebrava tenants/pedidos/entregadores/usuarios_loja/etc por
-- completo. Corrigido com funções SECURITY DEFINER (padrão
-- recomendado do Postgres/Supabase pra esse caso exato): rodam como o
-- dono da função, que tem BYPASSRLS, então a consulta interna não
-- reaciona a policy. `search_path` fixado explicitamente em TODAS as
-- funções SECURITY DEFINER deste arquivo (as duas abaixo e as 5 mais
-- adiante) — sem isso, uma função SECURITY DEFINER é um vetor
-- clássico de escalonamento de privilégio via schema injection (um
-- objeto malicioso em outro schema no search_path do chamador poderia
-- ser resolvido no lugar do pretendido).
-- ------------------------------------------------------------
create or replace function minhas_tenant_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select tenant_id from usuarios_loja where auth_user_id = auth.uid();
$$;

create or replace function minhas_tenant_ids_dono()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select tenant_id from usuarios_loja where auth_user_id = auth.uid() and papel = 'dono';
$$;

-- ------------------------------------------------------------
-- painel-dev.html (ferramenta interna, sessão de 19/08/2026): mesmo padrão
-- das duas funções acima — SECURITY DEFINER pra consultar
-- desenvolvedores_admin (que não tem NENHUMA policy própria, ver comentário
-- na criação da tabela) sem reacionar RLS. Usada tanto pelas policies de
-- SELECT quanto pela RPC de aprovação abaixo.
-- ------------------------------------------------------------
create or replace function eh_desenvolvedor_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists(select 1 from desenvolvedores_admin where auth_user_id = auth.uid());
$$;

-- ------------------------------------------------------------
-- ACHADO ultrareview (2ª rodada, sessão de go-to-market): mesma recursão
-- infinita de RLS já documentada em usuarios_loja (42P17), agora entre
-- rotas_entrega e tentativas_despacho — a policy nova de rotas_entrega
-- ("entregador ve rota de tentativa pendente") faz subselect cru em
-- tentativas_despacho, cuja própria policy de select da loja faz subselect
-- cru de volta em rotas_entrega. Resolver um reaciona o outro, infinito.
-- Mesmo padrão de correção: função SECURITY DEFINER quebra o ciclo (roda
-- com BYPASSRLS do dono da função, a consulta interna não reaciona a
-- policy de tentativas_despacho).
-- ------------------------------------------------------------
create or replace function rotas_com_tentativa_para_mim()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select rota_id from tentativas_despacho where entregador_id in
    (select id from entregadores where auth_user_id = auth.uid());
$$;

-- ------------------------------------------------------------
-- ACHADO (validação contra banco real, 14/08/2026): a policy de insert em
-- usuarios_loja só exigia auth_user_id = auth.uid() — qualquer usuário
-- autenticado conseguia se auto-vincular como funcionário (ou até como um
-- segundo "dono") a QUALQUER tenant já existente, sem convite nenhum.
-- Confirmado que hoje não existe fluxo real de auto-cadastro de funcionário
-- em lugar nenhum do produto (só cadastro-loja.html insere um vínculo, uma
-- única vez, papel='dono', logo após criar o próprio tenant) — então a
-- permissão ampla era pura superfície de ataque, sem uso legítimo.
-- Esta função (SECURITY DEFINER pra não sofrer o mesmo problema de
-- visibilidade via RLS que um EXISTS direto teria: o usuário ainda sem
-- nenhum vínculo não enxergaria vínculos alheios de qualquer forma) permite
-- restringir o insert a "sou o primeiro vínculo desse tenant".
-- ------------------------------------------------------------
create or replace function tenant_ja_tem_usuario(p_tenant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists(select 1 from usuarios_loja where tenant_id = p_tenant_id);
$$;

-- ------------------------------------------------------------
-- ACHADO (mesma validação, 14/08/2026): app-entregador.html lê
-- horas_alerta_fadiga/horas_descanso_obrigatorio do próprio tenant via
-- `select('*, tenants(...))` — mas a policy de select em tenants só cobre
-- usuarios_loja (dono/funcionário), não entregadores. O join sempre
-- devolvia `tenants: null` pro motoboy (o app já tinha fallback pro padrão
-- 8h/8h, não quebrava, só ignorava a config real da loja em silêncio).
-- Função estreita em vez de policy nova em tenants: uma policy exporia a
-- LINHA inteira (inclusive proprietario_cpf, chave_pix, cnpj) pra qualquer
-- entregador que decidisse consultar a tabela direto, não só os 2 campos
-- que o app pede.
-- ------------------------------------------------------------
create or replace function config_fadiga_do_meu_tenant()
returns table(horas_alerta_fadiga numeric, horas_descanso_obrigatorio numeric)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select t.horas_alerta_fadiga, t.horas_descanso_obrigatorio
  from tenants t
  join entregadores e on e.tenant_id = t.id
  where e.auth_user_id = auth.uid();
$$;

-- item 37 (25/08/2026): mesmo padrão de config_fadiga_do_meu_tenant() acima
-- (função estreita, SECURITY DEFINER, só os campos que o app precisa) —
-- usuário notou que não tinha nenhum jeito de navegar até a loja no app.
-- GiroCerto não traça mapa próprio (decisão de produto documentada na
-- coluna entregadores.app_navegacao_preferido: navegação turn-by-turn fica
-- por deep link pro Waze/Google Maps, que aceita endereço em texto puro,
-- sem precisar geocodificar nada aqui).
create or replace function endereco_loja_do_meu_tenant()
returns table(endereco_loja text)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select t.endereco_loja
  from tenants t
  join entregadores e on e.tenant_id = t.id
  where e.auth_user_id = auth.uid();
$$;

-- ------------------------------------------------------------
-- Pausar/retomar turno preservando o status anterior (fix do achado do item
-- 10 — ver comentário em entregadores.status_antes_pausa). Funções em vez de
-- dois updates separados no client pra serem ATÔMICAS: ler e gravar
-- status_antes_pausa=status numa única instrução evita corrida com o motor
-- de despacho escrevendo entregadores.status no mesmo instante (ex: aceite
-- de uma oferta concorrendo com o clique de pausar). Não precisa de
-- SECURITY DEFINER — o entregador já tem UPDATE na própria linha via RLS
-- ("entregador atualiza seu proprio cadastro"), só roda como invoker mesmo.
-- ------------------------------------------------------------
create or replace function pausar_entregador()
returns void
language sql
as $$
  update entregadores
  set status_antes_pausa = status, status = 'pausado'
  where auth_user_id = auth.uid() and status <> 'pausado';
$$;

create or replace function retomar_entregador()
returns void
language sql
as $$
  update entregadores
  set status = coalesce(status_antes_pausa, 'disponivel'), status_antes_pausa = null
  where auth_user_id = auth.uid() and status = 'pausado';
$$;

-- ------------------------------------------------------------
-- Confirmar retirada na loja (fix ultrareview 2ª rodada): antes era 2 updates
-- separados no client (rotas_entrega + entregadores), mesma classe de corrida
-- que pausar_entregador()/retomar_entregador() foram criadas pra evitar —
-- podia colidir com o dispatch-engine escrevendo entregadores.status no
-- mesmo instante (ex: uma segunda oferta sendo processada). Uma função só,
-- WHERE escopado pelo dono da rota via join com entregadores.
-- ------------------------------------------------------------
-- item 34 (25/08/2026): enfileira 1 notificação pro cliente do restaurante
-- (telefone puxado do próprio pedido, nunca do chamador — evita spoofing).
-- SECURITY DEFINER porque quem chama (confirmar_retirada_rota, abaixo) roda
-- como o entregador comum, e notificacao_restaurante não tem policy de
-- INSERT pra ninguém — mas se autoriza por conta própria (mesmo padrão de
-- aprovar_entregador_teste()): exposta como RPC pública, então não pode
-- confiar que quem chama já validou a posse antes.
create or replace function enfileirar_notificacao_restaurante(
  p_pedido_id uuid, p_evento text, p_payload jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from pedidos p
    join rotas_entrega r on r.id = p.rota_id
    join entregadores e on e.id = r.entregador_id
    where p.id = p_pedido_id and e.auth_user_id = auth.uid()
  ) then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  insert into notificacao_restaurante (pedido_id, telefone, evento, payload)
  select p_pedido_id, cliente_telefone, p_evento, p_payload
  from pedidos
  where id = p_pedido_id and cliente_telefone is not null and cliente_telefone <> '';
end;
$$;

-- item 34 (25/08/2026): "cheguei na loja" — passo novo ANTES de confirmar
-- retirada, pedido explícito do usuário testando o fluxo de ponta a ponta.
-- Idempotente (só seta a primeira vez) e não muda rotas_entrega.status —
-- é só um timestamp informativo pra UI saber qual botão mostrar.
create or replace function confirmar_chegada_loja(p_rota_id uuid)
returns void
language plpgsql
as $$
begin
  update rotas_entrega
  set chegou_loja_em = now()
  where id = p_rota_id
    and status = 'a_caminho_da_loja'
    and chegou_loja_em is null
    and entregador_id in (select id from entregadores where auth_user_id = auth.uid());
end;
$$;

create or replace function confirmar_retirada_rota(p_rota_id uuid)
returns void
language plpgsql
as $$
declare
  v_pedido record;
begin
  update rotas_entrega
  set status = 'em_entrega', iniciada_em = now()
  where id = p_rota_id
    and status = 'a_caminho_da_loja'
    and entregador_id in (select id from entregadores where auth_user_id = auth.uid());

  update entregadores
  set status = 'em_rota'
  where auth_user_id = auth.uid()
    and id in (select entregador_id from rotas_entrega where id = p_rota_id);

  -- achado real (25/08/2026, teste de ponta a ponta via painel-loja.html):
  -- pedidos.status tem 'a_caminho' definido no schema desde sempre ("motoboy
  -- pegou e está entregando") e painel-loja.html já sabe exibir esse rótulo
  -- — mas nada nunca escrevia esse valor. A loja via "Pronto" a entrega
  -- inteira, sem diferenciar "esperando retirada" de "já saiu com o
  -- motoboy". Mesma checagem de posse do UPDATE de rotas_entrega acima
  -- (rota_id tem que pertencer a um entregador_id do próprio auth.uid()) —
  -- sem isso, um entregador poderia chamar essa RPC com o p_rota_id de
  -- OUTRO entregador e ainda assim mexer no pedidos.status alheio, mesmo
  -- os dois UPDATEs acima corretamente não fazendo nada nesse caso.
  --
  -- select ... for update em vez de um UPDATE só, porque também precisa
  -- disparar 1 notificação POR PEDIDO da rota (rota multi-parada existe,
  -- ver "4 pedidos numa rota com ordem_na_rota 1..4" nos testes) — o
  -- WHERE já garante posse (mesma sub-select de sempre).
  for v_pedido in
    update pedidos
    set status = 'a_caminho'
    where rota_id = p_rota_id
      and status = 'pronto'
      and rota_id in (
        select id from rotas_entrega
        where entregador_id in (select id from entregadores where auth_user_id = auth.uid())
      )
    returning id, codigo_entrega
  loop
    perform enfileirar_notificacao_restaurante(
      v_pedido.id, 'saiu_para_entrega',
      jsonb_build_object('codigo_entrega', v_pedido.codigo_entrega)
    );
  end loop;
end;
$$;

-- item 34 (25/08/2026): "cheguei no local de entrega" — passo novo ANTES de
-- digitar o código, mesmo princípio de confirmar_chegada_loja() acima, só
-- que por PEDIDO (não por rota) — rota multi-parada, cada parada chega em
-- momento diferente.
create or replace function confirmar_chegada_entrega(p_pedido_id uuid)
returns void
language plpgsql
as $$
begin
  update pedidos
  set chegou_entrega_em = now()
  where id = p_pedido_id
    and status = 'a_caminho'
    and chegou_entrega_em is null
    and rota_id in (
      select id from rotas_entrega
      where entregador_id in (select id from entregadores where auth_user_id = auth.uid())
    );
end;
$$;

-- ------------------------------------------------------------
-- painel-dev.html (ferramenta interna, sessão de 19/08/2026): aprova um
-- cadastro pendente sem precisar de SQL manual. SECURITY DEFINER porque o
-- desenvolvedor não é o próprio entregador (auth_user_id não bate) nem um
-- usuarios_loja do tenant — nenhuma policy de UPDATE existente cobriria
-- isso. Deliberadamente uma RPC estreita, não uma policy de UPDATE genérica
-- em entregadores: uma policy exporia a linha inteira a updates arbitrários
-- via PostgREST (CPF, chave Pix, CNH etc.); esta função só é capaz de tocar
-- os 2 campos abaixo, sempre, e nada além disso — mesmo que alguém tente
-- mandar outros campos junto na chamada da RPC (a assinatura só aceita o
-- id). aprovado_por fica NULL de propósito: quem aprova aqui não é um
-- usuarios_loja (aprovado_por referencia usuarios_loja(id), não faria
-- sentido forçar um valor artificial só pra preencher o campo).
-- ------------------------------------------------------------
create or replace function aprovar_entregador_teste(p_entregador_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not eh_desenvolvedor_admin() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  update entregadores
  set status_verificacao = 'aprovado',
      aprovado_em = now()
  where id = p_entregador_id
    and status_verificacao = 'em_avaliacao';
end;
$$;

-- ------------------------------------------------------------
-- Irmã de aprovar_entregador_teste() acima (sessão de 23/08/2026): mesmo
-- padrão exato (SECURITY DEFINER, checa eh_desenvolvedor_admin(), RPC
-- estreita em vez de policy de UPDATE genérica) — faltava o equivalente pra
-- reprovar. Usada tanto por painel-dev.html (só aprova, não muda) quanto
-- por painel-admin.html (aprova E reprova). aprovado_por fica NULL pelo
-- mesmo motivo de aprovar_entregador_teste(): quem decide aqui é um admin
-- da plataforma, não um usuarios_loja.
-- ------------------------------------------------------------
create or replace function reprovar_entregador_teste(p_entregador_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not eh_desenvolvedor_admin() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  -- p_motivo não é validado aqui contra a lista de valores permitidos — a
  -- constraint check já existente na coluna motivo_reprovacao faz isso,
  -- mesma fonte de verdade que o resto do schema já usa.
  update entregadores
  set status_verificacao = 'reprovado',
      motivo_reprovacao = p_motivo
  where id = p_entregador_id
    and status_verificacao = 'em_avaliacao';
end;
$$;

-- ------------------------------------------------------------
-- painel-admin.html (Visão Geral, sessão de 23/08/2026): único jeito de
-- ligar/desligar tenants.habilitado — sem essa RPC a coluna fica
-- inatingível por qualquer UI (a trigger proteger_habilitado_tenant()
-- bloqueia update direto de quem não é admin, e nem o admin tem policy de
-- UPDATE em tenants pra usar via PostgREST direto). Mesmo formato de
-- aprovar_entregador_teste(): SECURITY DEFINER, checa
-- eh_desenvolvedor_admin(), só toca essa 1 coluna.
-- ------------------------------------------------------------
create or replace function definir_tenant_habilitado(p_tenant_id uuid, p_habilitado boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not eh_desenvolvedor_admin() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  update tenants
  set habilitado = p_habilitado
  where id = p_tenant_id;
end;
$$;

-- ------------------------------------------------------------
-- Achado ultrareview (2ª rodada): a policy "entregador atualiza seu proprio
-- cadastro" (FOR UPDATE, sem WITH CHECK) deixava o próprio entregador limpar
-- bloqueado_ate via update direto — bypass total do bloqueio de descanso
-- obrigatório que a policy de INSERT em turnos foi construída pra impor.
-- Trigger em vez de WITH CHECK porque WITH CHECK não enxerga o valor ANTIGO
-- da coluna na mesma expressão — precisa comparar old vs new pra saber se
-- ainda está bloqueado. Reverte silenciosamente só o campo bloqueado_ate se
-- alguém tentar mexer nele enquanto o bloqueio ainda vale; não bloqueia o
-- resto do UPDATE (outros campos legítimos, tipo lat/lng, continuam
-- passando normalmente).
-- ------------------------------------------------------------
create or replace function proteger_bloqueado_ate()
returns trigger
language plpgsql
as $$
begin
  if old.bloqueado_ate is not null and old.bloqueado_ate > now()
     and new.bloqueado_ate is distinct from old.bloqueado_ate then
    new.bloqueado_ate := old.bloqueado_ate;
  end if;
  return new;
end;
$$;

create trigger trg_proteger_bloqueado_ate
  before update on entregadores
  for each row execute function proteger_bloqueado_ate();

-- ------------------------------------------------------------
-- Achado ultrareview (2ª rodada): a policy de UPDATE em turnos não tinha
-- checagem de bloqueado_ate nenhuma — um entregador bloqueado podia reviver
-- um turno antigo 'finalizado' de volta pra 'ativo' via update direto,
-- contornando completamente a policy de INSERT que checa o bloqueio (só
-- vale pra turno NOVO). Aqui sim vale barrar com exceção (não silenciar):
-- essa transição nunca deveria acontecer via UPDATE de verdade, é sempre
-- INSERT no fluxo real do app.
-- ------------------------------------------------------------
create or replace function proteger_reativacao_turno_bloqueado()
returns trigger
language plpgsql
as $$
declare
  v_bloqueado_ate timestamptz;
begin
  if new.status = 'ativo' and old.status is distinct from 'ativo' then
    select bloqueado_ate into v_bloqueado_ate from entregadores where id = new.entregador_id;
    if v_bloqueado_ate is not null and v_bloqueado_ate > now() then
      raise exception 'Entregador está no período de descanso obrigatório até %', v_bloqueado_ate;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_proteger_reativacao_turno_bloqueado
  before update on turnos
  for each row execute function proteger_reativacao_turno_bloqueado();

-- ------------------------------------------------------------
-- Achado (revisão de painel-dev.html, 19/08/2026): a policy "entregador
-- atualiza seu proprio cadastro" (FOR UPDATE, sem WITH CHECK) permitia o
-- próprio entregador setar status_verificacao='aprovado' via update direto
-- — bypass total de qualquer processo de aprovação, manual ou pela
-- ferramenta nova. Mesma técnica de proteger_bloqueado_ate() (trigger, não
-- WITH CHECK, porque WITH CHECK não enxerga o valor ANTIGO da coluna na
-- mesma expressão): aqui vale barrar com exceção (não silenciar), mesmo
-- raciocínio de proteger_reativacao_turno_bloqueado() — essa transição
-- nunca deveria acontecer por essa via.
--
-- O escape hatch eh_desenvolvedor_admin() NÃO distingue "é a RPC
-- aprovar_entregador_teste() chamando" de "é uma chamada de API direta" —
-- ele só verifica QUEM está autenticado (auth.uid(), derivado do JWT
-- verificado pelo PostgREST; não é uma session variable setável pelo
-- cliente, não tem o que forjar). O motivo de isso ser seguro mesmo assim:
-- o dev NUNCA recebeu policy de UPDATE em entregadores (só SELECT, mais
-- abaixo) — sem nenhuma policy de UPDATE aplicável, RLS nega update direto
-- da sessão dele de cara (0 linhas afetadas), então esse trigger nunca
-- chega a ser avaliado por essa via. O único caminho que realmente escreve
-- é a RPC, que roda SECURITY DEFINER (bypassa RLS pra sua própria query
-- interna, mas não bypassa este trigger) com uma lista fixa de 2 colunas —
-- o escape hatch aqui só existe pra essa escrita legítima da RPC não cair
-- na mesma exceção pensada pro entregador comum.
-- INVARIANTE: se algum dia uma policy de UPDATE for adicionada pro dev em
-- entregadores (hoje não existe nenhuma), este trigger sozinho deixa de ser
-- suficiente pra impedir um update direto tocando os 4 campos — revisitar
-- nesse caso.
-- ------------------------------------------------------------
create or replace function impedir_autoaprovacao_entregador()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- auth.uid() is null = sem sessão JWT nenhuma (pg_cron chamando direto,
  -- ex: verificar_documentos_vencidos(), ou qualquer outra automação
  -- SECURITY DEFINER que rode fora do contexto do PostgREST). Achado real,
  -- pego pela suíte completa (tests/onboarding.test.js) depois de aplicar
  -- este trigger pra painel-dev.html: o job de reprovação automática por
  -- documento vencido passou a ser bloqueado por engano, porque ele também
  -- faz UPDATE direto em status_verificacao/motivo_reprovacao. Nenhuma
  -- requisição real de entregador (via PostgREST/anon+authenticated) chega
  -- aqui com auth.uid() null — só automação de backend.
  if eh_desenvolvedor_admin() or auth.uid() is null then
    return new;
  end if;

  if new.status_verificacao is distinct from old.status_verificacao
     or new.aprovado_por is distinct from old.aprovado_por
     or new.aprovado_em is distinct from old.aprovado_em
     or new.motivo_reprovacao is distinct from old.motivo_reprovacao then
    raise exception 'entregador não pode alterar campos de aprovação do próprio cadastro' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_impedir_autoaprovacao_entregador
  before update on entregadores
  for each row execute function impedir_autoaprovacao_entregador();

-- ------------------------------------------------------------
-- painel-admin.html (Visão Geral, sessão de 23/08/2026): mesma técnica de
-- impedir_autoaprovacao_entregador() acima — a policy "loja atualiza seu
-- proprio tenant" é um UPDATE USING sem WITH CHECK nenhum, então sem essa
-- trigger a própria loja poderia se autoreabilitar/autossuspender via
-- PostgREST assim que a coluna habilitado existisse. Bloqueia com exceção
-- (não silencia, mesmo raciocínio de impedir_autoaprovacao_entregador():
-- essa mudança nunca deveria acontecer por essa via). Mesmo escape hatch
-- de sempre: eh_desenvolvedor_admin() (a RPC definir_tenant_habilitado()
-- roda com esse auth.uid(), SECURITY DEFINER não muda isso) ou auth.uid()
-- is null (automação de backend, hoje nenhuma toca essa coluna, mas mantém
-- o padrão pra não repetir o achado do job de reprovação automática).
-- ------------------------------------------------------------
create or replace function proteger_habilitado_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if eh_desenvolvedor_admin() or auth.uid() is null then
    return new;
  end if;

  if new.habilitado is distinct from old.habilitado then
    raise exception 'só o admin da plataforma pode habilitar/desabilitar uma loja' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_proteger_habilitado_tenant
  before update on tenants
  for each row execute function proteger_habilitado_tenant();

alter table pedidos enable row level security;
alter table rotas_entrega enable row level security;
alter table entregadores enable row level security;
alter table repasses enable row level security;
alter table tenants enable row level security;
alter table usuarios_loja enable row level security;
alter table comprovantes_entrega enable row level security;
alter table tentativas_contato enable row level security;
alter table turnos enable row level security;
alter table avaliacoes_loja enable row level security;
alter table alertas_seguranca enable row level security;
alter table localizacoes_entregador enable row level security;
alter table horarios_funcionamento enable row level security;
-- tentativas_despacho tinha ficado de fora dessa lista por descuido
-- (achado da revisão A3) — mesmo nível de sensibilidade de
-- tentativas_contato: revela pra quais entregadores uma rota foi
-- oferecida e quem recusou/não respondeu.
alter table tentativas_despacho enable row level security;
-- desenvolvedores_admin: RLS habilitada e de propósito sem nenhuma policy
-- (ver comentário na criação da tabela, seção de tabelas acima).
alter table desenvolvedores_admin enable row level security;

-- pedidos: loja vê e cria os do seu tenant
create policy "loja ve seus pedidos" on pedidos for select using (
  tenant_id in (select minhas_tenant_ids()));
create policy "loja cria pedidos no seu tenant" on pedidos for insert with check (
  tenant_id in (select minhas_tenant_ids()));
create policy "loja atualiza seus pedidos" on pedidos for update using (
  tenant_id in (select minhas_tenant_ids()));
-- entregador: sem policy nenhuma aqui, o app-entregador.html quebrava (rota sem
-- paradas visíveis, confirmarEntrega() com null deref) — achado ultrareview, bug_005.
-- WITH CHECK restringe a única transição que o app faz (pedido -> entregue) E
-- rechecha a posse de rota_id na linha resultante — achado da 2ª rodada de
-- ultrareview (validando os commits desta sessão): WITH CHECK substitui o
-- USING para a linha nova, então sem repetir a condição de posse aqui um
-- UPDATE malicioso via PostgREST direto (fora da UI) podia trocar o rota_id
-- do próprio pedido pra qualquer rota alheia junto com status='entregue'.
create policy "entregador ve pedidos das suas rotas" on pedidos for select using (
  rota_id in (select id from rotas_entrega where entregador_id in
    (select id from entregadores where auth_user_id = auth.uid())));
-- achado ultrareview (2ª rodada), mesma causa raiz da policy equivalente em
-- rotas_entrega: mostrarOferta() em app-entregador.html embute pedidos(*) na
-- mesma query que lê a rota — sem isso, a rota aparecia mas com pedidos=[]
-- (a policy acima só libera depois que entregador_id já está preenchido).
-- Reaproveita a mesma função SECURITY DEFINER já criada pra rotas_entrega —
-- não introduz recursão nova porque a função não consulta pedidos.
create policy "entregador ve pedido de tentativa pendente" on pedidos for select using (
  rota_id in (select rotas_com_tentativa_para_mim()));
-- achado real (25/08/2026, teste de ponta a ponta): a policy original só
-- previa o UPDATE de confirmarEntrega() (status='entregue') — quando
-- confirmar_retirada_rota() passou a também setar pedidos.status='a_caminho'
-- (item 33), essa policy bloqueou com "new row violates row-level security
-- policy", porque a RPC roda como SECURITY INVOKER (o próprio entregador,
-- sujeito a RLS normal). Ampliada pra cobrir as duas transições legítimas
-- que o entregador faz no ciclo de vida do pedido, mesma regra de posse de
-- sempre (rota_id tem que ser de uma rota do próprio auth.uid()).
create policy "entregador atualiza status dos pedidos das suas rotas" on pedidos for update using (
  rota_id in (select id from rotas_entrega where entregador_id in
    (select id from entregadores where auth_user_id = auth.uid()))
) with check (
  status in ('a_caminho', 'entregue')
  and rota_id in (select id from rotas_entrega where entregador_id in
    (select id from entregadores where auth_user_id = auth.uid()))
);

-- rotas_entrega: loja e o entregador designado
create policy "loja ve suas rotas" on rotas_entrega for select using (
  tenant_id in (select minhas_tenant_ids()));
create policy "entregador ve suas proprias rotas" on rotas_entrega for select using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));
-- achado ultrareview (2ª rodada, sessão de go-to-market): sem isso, o modal de
-- "nova oferta" em app-entregador.html não conseguia ler a rota antes de aceitar
-- — a policy acima só libera depois que entregador_id já está preenchido, mas
-- dispatch-engine cria a rota com entregador_id NULL até o aceite. Sem essa
-- policy extra, mostrarOferta() sempre via `rota = null` e o modal nunca
-- mostrava nada de verdade (os testes anteriores não pegaram porque escreviam
-- o aceite direto, sem passar pela leitura que a UI real faz).
create policy "entregador ve rota de tentativa pendente" on rotas_entrega for select using (
  id in (select rotas_com_tentativa_para_mim()));
create policy "entregador atualiza suas proprias rotas" on rotas_entrega for update using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));

-- entregadores: cada um vê e edita o próprio cadastro; a loja só vê (aprovação passa pelo backend)
create policy "entregador ve e edita seu cadastro" on entregadores for select using (
  auth_user_id = auth.uid());
create policy "entregador cria seu proprio cadastro" on entregadores for insert with check (
  auth_user_id = auth.uid());
create policy "entregador atualiza seu proprio cadastro" on entregadores for update using (
  auth_user_id = auth.uid());
create policy "loja ve entregadores do seu tenant" on entregadores for select using (
  tenant_id in (select minhas_tenant_ids()));

-- repasses: só o próprio entregador vê os seus
create policy "entregador ve seus proprios repasses" on repasses for select using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));

-- tenants: qualquer usuário autenticado pode criar um tenant novo no cadastro
-- (ainda não existe usuarios_loja vinculado nesse momento — o vínculo vem
-- logo em seguida); ver/editar depois disso já exige pertencer ao tenant
create policy "usuario autenticado cria um tenant" on tenants for insert with check (
  auth.uid() is not null);
create policy "loja ve e edita seu proprio tenant" on tenants for select using (
  id in (select minhas_tenant_ids()));
create policy "loja atualiza seu proprio tenant" on tenants for update using (
  id in (select minhas_tenant_ids()));

-- usuarios_loja: só enxerga colegas do mesmo tenant, e só cria o próprio vínculo
create policy "usuario ve colegas do mesmo tenant" on usuarios_loja for select using (
  tenant_id in (select minhas_tenant_ids()));
create policy "usuario cria seu proprio vinculo" on usuarios_loja for insert with check (
  auth_user_id = auth.uid()
  and papel = 'dono'
  and not tenant_ja_tem_usuario(tenant_id));

-- comprovantes_entrega: loja do pedido + o entregador que entregou
create policy "loja ve comprovantes dos seus pedidos" on comprovantes_entrega for select using (
  pedido_id in (select id from pedidos where tenant_id in
    (select minhas_tenant_ids())));
create policy "entregador cria comprovante da propria entrega" on comprovantes_entrega for insert with check (
  pedido_id in (select p.id from pedidos p join rotas_entrega r on r.id = p.rota_id
    where r.entregador_id in (select id from entregadores where auth_user_id = auth.uid())));

-- tentativas_contato: só a loja do pedido em questão
create policy "loja ve tentativas de contato dos seus pedidos" on tentativas_contato for select using (
  pedido_id in (select id from pedidos where tenant_id in
    (select minhas_tenant_ids())));

-- tentativas_despacho: loja da rota + o entregador que foi chamado (achado A3)
create policy "loja ve tentativas de despacho das suas rotas" on tentativas_despacho for select using (
  rota_id in (select id from rotas_entrega where tenant_id in
    (select minhas_tenant_ids())));
create policy "entregador ve e responde suas proprias tentativas" on tentativas_despacho for all using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));

-- turnos: o próprio entregador e a loja onde ele atua
-- achado real (sessão de resolução de pendências, 14/08/2026): o bloqueio de
-- descanso obrigatório (entregadores.bloqueado_ate) só era checado no client
-- (iniciarTurno() em app-entregador.html) — um INSERT direto em turnos via
-- PostgREST, fora da UI, ignorava o bloqueio completamente. Split da antiga
-- policy "for all" em comandos separados: SELECT/UPDATE/DELETE continuam só
-- com checagem de posse; INSERT ganha uma policy própria, mais restrita, que
-- também nega se bloqueado_ate ainda está no futuro. Não dá pra manter isso
-- como WITH CHECK numa única policy FOR ALL — isso aplicaria a checagem de
-- bloqueio também em UPDATE (pausar/finalizar um turno já em andamento não
-- deveria travar por bloqueado_ate futuro, só abrir um turno NOVO deveria).
create policy "entregador ve seus proprios turnos" on turnos for select using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));
create policy "entregador atualiza seus proprios turnos" on turnos for update using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));
create policy "entregador deleta seus proprios turnos" on turnos for delete using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));
create policy "entregador inicia turno se nao estiver bloqueado" on turnos for insert with check (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid())
  and not exists (
    select 1 from entregadores e
    where e.id = entregador_id and e.bloqueado_ate is not null and e.bloqueado_ate > now()
  )
);
create policy "loja ve turnos dos seus entregadores" on turnos for select using (
  entregador_id in (select id from entregadores where tenant_id in
    (select minhas_tenant_ids())));

-- avaliacoes_loja: entregador cria a sua, loja só lê o agregado (não quem disse o quê)
create policy "entregador cria avaliacao da loja" on avaliacoes_loja for insert with check (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));

-- alertas_seguranca: bem restrito — só o próprio entregador e a loja envolvida
create policy "entregador ve e atualiza seus alertas" on alertas_seguranca for all using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));
create policy "loja ve alertas dos seus entregadores" on alertas_seguranca for select using (
  entregador_id in (select id from entregadores where tenant_id in
    (select minhas_tenant_ids())));
-- sem isso, "Confirmar OK"/"Escalar" no painel-loja.html batiam contra RLS,
-- filtravam pra 0 linhas em silêncio (sem erro do PostgREST) e o alerta nunca
-- saía de aguardando_confirmacao — achado da revisão ultrareview, bug_013
create policy "loja resolve alertas dos seus entregadores" on alertas_seguranca for update using (
  entregador_id in (select id from entregadores where tenant_id in
    (select minhas_tenant_ids())));

-- localizacoes_entregador: dado sensível — só o próprio e a loja, nunca público
create policy "entregador gerencia sua propria localizacao" on localizacoes_entregador for all using (
  entregador_id in (select id from entregadores where auth_user_id = auth.uid()));
create policy "loja ve localizacao dos seus entregadores" on localizacoes_entregador for select using (
  entregador_id in (select id from entregadores where tenant_id in
    (select minhas_tenant_ids())));

-- horarios_funcionamento: público pra leitura (o app precisa saber se está aberto
-- antes mesmo de qualquer login), só a loja edita o próprio
create policy "qualquer um le horario de funcionamento" on horarios_funcionamento for select using (true);
create policy "loja edita seu proprio horario" on horarios_funcionamento for all using (
  tenant_id in (select minhas_tenant_ids()));

-- ------------------------------------------------------------
-- painel-dev.html (ferramenta interna, sessão de 19/08/2026): SOMENTE
-- LEITURA pras 4 tabelas que a tela precisa mostrar. Nenhuma dessas
-- policies dá UPDATE/INSERT/DELETE nenhum — a única escrita possível pelo
-- desenvolvedor é a RPC estreita aprovar_entregador_teste() (ver acima),
-- não uma policy de tabela. Escopo mínimo: só o que a tela realmente lista.
-- ------------------------------------------------------------
create policy "dev admin ve todos entregadores" on entregadores for select using (
  eh_desenvolvedor_admin());
create policy "dev admin ve todos tenants" on tenants for select using (
  eh_desenvolvedor_admin());
create policy "dev admin ve todos pedidos" on pedidos for select using (
  eh_desenvolvedor_admin());
create policy "dev admin ve todas tentativas de despacho" on tentativas_despacho for select using (
  eh_desenvolvedor_admin());
-- painel-admin.html (Visão Geral, sessão de 23/08/2026): falta essa pra
-- entregadores_presenca (mais abaixo) calcular online/offline — as outras
-- 4 tabelas acima já cobriam painel-dev.html, essa é nova.
create policy "dev admin ve todas localizacoes" on localizacoes_entregador for select using (
  eh_desenvolvedor_admin());

-- ==============================================================
-- PROVISIONAMENTO AUTOMÁTICO PÓS-SIGNUP (achado real, roteiro de teste
-- manual, 17/08/2026): o projeto tem confirmação de e-mail obrigatória
-- (mailer_autoconfirm = false no Supabase Auth). signUp() sem confirmar
-- e-mail NÃO retorna sessão (session = null) — auth.uid() fica null pro
-- cliente que acabou de se cadastrar. Toda policy de INSERT em
-- tenants/usuarios_loja/entregadores exige auth.uid() correspondente,
-- então cadastro-loja.html e app-entregador.html quebravam com 42501
-- (RLS) tentando inserir logo após o signUp() — reproduzido ao vivo com
-- signUp() real (não admin.createUser), confirmado antes de corrigir
-- (ver CLAUDE.md). Isso nunca apareceu nos 122 testes automatizados
-- porque todos usam admin.createUser({email_confirm:true}), que pula
-- esse caminho inteiro.
--
-- Corrigido SEM desativar a confirmação de e-mail obrigatória (decisão
-- do usuário — manter a barreira de e-mail real): trigger AFTER INSERT
-- em auth.users, com função SECURITY DEFINER (mesmo padrão de
-- minhas_tenant_ids() — bypassa RLS, não precisa de auth.uid() nenhum),
-- cria o registro base (tenants+usuarios_loja+horarios_funcionamento
-- pra loja, entregadores pra entregador) IMEDIATAMENTE no signup, lendo
-- os campos do formulário que o frontend agora manda via `options.data`
-- do signUp() (fica em auth.users.raw_user_meta_data).
--
-- Documentos (fotos) ficam de fora de propósito: upload pro Storage
-- TAMBÉM exige auth.uid() (mesma trava, policies de storage.objects
-- mais abaixo) — não tem como resolver isso agora sem sessão. Fica pra
-- depois do primeiro login confirmado (telas novas de "completar
-- cadastro" em painel-loja.html e app-entregador.html, que fazem
-- UPDATE usando as policies de UPDATE que já existiam).
create or replace function provisionar_cadastro_pos_signup()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  meta jsonb := new.raw_user_meta_data;
  novo_tenant_id uuid;
begin
  -- sem tag explícita de tipo — infere pela presença de tenant_id na
  -- metadata: só o cadastro de ENTREGADOR manda isso (vem do link
  -- ?loja=<uuid> que a loja compartilha, o tenant já existe). O cadastro
  -- de LOJA nunca manda tenant_id (é este insert que cria o tenant),
  -- então cai no elsif por eliminação; 'nome' é só uma guarda extra pra
  -- não criar um tenant vazio se um dia existir metadata de outro tipo
  -- de conta sem nenhum dos dois campos.
  if meta ? 'tenant_id' then
    insert into entregadores (
      tenant_id, auth_user_id, email, nome, tipo_veiculo, data_nascimento,
      endereco, numero_residencia, cep, chave_pix,
      cpf, cnh_numero, cnh_validade, placa, crlv_validade,
      rg_numero, responsavel_nome, is_teste,
      verificacao_enviada_em, verificacao_prazo_limite, consentimento_lgpd_aceito_em
    ) values (
      (meta->>'tenant_id')::uuid,
      new.id,
      new.email,
      meta->>'nome',
      coalesce(nullif(meta->>'tipo_veiculo', ''), 'moto'),
      nullif(meta->>'data_nascimento', '')::date,
      meta->>'endereco',
      meta->>'numero_residencia',
      meta->>'cep',
      meta->>'chave_pix',
      meta->>'cpf',
      meta->>'cnh_numero',
      nullif(meta->>'cnh_validade', '')::date,
      meta->>'placa',
      nullif(meta->>'crlv_validade', '')::date,
      meta->>'rg_numero',
      meta->>'responsavel_nome',
      coalesce((meta->>'is_teste')::boolean, false),
      now(),
      now() + interval '7 days',
      now()
    )
    on conflict (auth_user_id) where auth_user_id is not null do nothing;

    -- PII (cpf, endereço, data de nascimento, chave Pix) não fica parada em
    -- auth.users fora do alcance das policies de RLS que protegem
    -- entregadores (LGPD é requisito de primeira classe neste projeto — ver
    -- consentimento_lgpd_aceito_em acima). Só zera depois do insert acima
    -- já ter lido tudo que precisava de `meta`.
    update auth.users set raw_user_meta_data = '{}'::jsonb where id = new.id;

  elsif meta ? 'nome' then
    novo_tenant_id := gen_random_uuid();
    -- o ON CONFLICT (id) abaixo NÃO é proteção real contra duplicação:
    -- novo_tenant_id é gerado agora mesmo, nesta execução, então nunca vai
    -- colidir com uma linha já existente — é só defesa-em-profundidade
    -- sintática. A proteção real contra reprocessamento é o próprio
    -- trigger: AFTER INSERT ON auth.users dispara exatamente uma vez por
    -- linha inserida (não existe um caminho pra essa função rodar 2x pro
    -- mesmo new.id).
    insert into tenants (
      id, nome, proprietario_nome, proprietario_cpf, proprietario_data_nascimento,
      proprietario_endereco, proprietario_numero_endereco, proprietario_cep,
      cnpj, endereco_loja, numero_loja, cep_loja, segmento,
      tempo_preparo_padrao_min, chave_pix, is_teste, consentimento_lgpd_aceito_em
    ) values (
      novo_tenant_id,
      meta->>'nome',
      meta->>'proprietario_nome',
      meta->>'proprietario_cpf',
      nullif(meta->>'proprietario_data_nascimento', '')::date,
      meta->>'proprietario_endereco',
      meta->>'proprietario_numero_endereco',
      meta->>'proprietario_cep',
      meta->>'cnpj',
      meta->>'endereco_loja',
      meta->>'numero_loja',
      meta->>'cep_loja',
      nullif(meta->>'segmento', ''),
      nullif(meta->>'tempo_preparo_padrao_min', '')::integer,
      meta->>'chave_pix',
      coalesce((meta->>'is_teste')::boolean, false),
      now()
    )
    on conflict (id) do nothing;

    insert into usuarios_loja (tenant_id, auth_user_id, nome, papel)
    values (novo_tenant_id, new.id, meta->>'proprietario_nome', 'dono')
    on conflict (auth_user_id) do nothing;

    if meta ? 'horarios' then
      insert into horarios_funcionamento (tenant_id, dia_semana, periodo_inicio, periodo_fim)
      select novo_tenant_id, (h->>'dia_semana')::smallint, (h->>'periodo_inicio')::time, (h->>'periodo_fim')::time
      from jsonb_array_elements(meta->'horarios') as h;
    end if;

    -- mesmo motivo do ramo de entregador acima: PII (cpf, endereço, data de
    -- nascimento, chave Pix) não fica parada em auth.users. Só zera depois
    -- de todos os inserts deste ramo (incluindo o laço de horarios) já
    -- terem lido tudo que precisavam de `meta`.
    update auth.users set raw_user_meta_data = '{}'::jsonb where id = new.id;
  end if;

  return new;
end;
$$;

create trigger trg_provisionar_cadastro_pos_signup
  after insert on auth.users
  for each row
  execute function provisionar_cadastro_pos_signup();

-- Achado real (roteiro de teste manual com signUp() de verdade, 17/08/2026):
-- o clear de raw_user_meta_data acima (dentro do INSERT trigger) É
-- sobrescrito, alguns milissegundos depois, por uma 2ª escrita do próprio
-- GoTrue em auth.users — parte do fluxo normal de signup com provider
-- 'email', que cria a linha em auth.identities e resincroniza
-- raw_user_meta_data a partir do payload original que ele recebeu na
-- requisição (não sabe, nem precisa saber, que um trigger nosso já limpou
-- isso). Confirmado comparando timestamps reais: auth.users.updated_at
-- ficou ~500ms depois de auth.users.created_at, e bate com
-- auth.identities.created_at — não é hipótese, é o que aconteceu.
--
-- ORDEM DE EXECUÇÃO — não há corrida possível entre o INSERT trigger
-- acima e essa 2ª escrita do GoTrue, por garantia do próprio Postgres
-- (não só observação empírica dos timestamps): triggers AFTER ROW
-- executam de forma SÍNCRONA, dentro da mesma instrução INSERT, e essa
-- instrução só retorna controle pro cliente (GoTrue) depois do trigger
-- (incluindo toda leitura de `meta`) já ter terminado. A escrita
-- seguinte do GoTrue é uma chamada HTTP/SQL SEPARADA e POSTERIOR — só
-- pode acontecer depois que o INSERT já retornou pra ele. Não existe
-- cenário onde a 2ª escrita "alcança" o trigger no meio da leitura.
--
-- Corrigido com um 2º trigger, AFTER UPDATE, que reage a essa reescrita.
-- Duas camadas de proteção, cada uma resolvendo um problema diferente:
--
-- 1) LOOP INFINITO: o WHEN exige OLD IS DISTINCT FROM NEW (não reage a
--    updates que não mudam nada) E OLD = '{}' (só reage quando o valor
--    ANTERIOR era vazio). A própria limpeza que este trigger faz deixa
--    NEW = '{}' — na reavaliação seguinte (o UPDATE que ELE MESMO
--    disparou), OLD passa a ser o payload não-vazio de antes, não '{}',
--    então a condição falha e o corpo não roda de novo. Converge em no
--    máximo 2 disparos por reescrita do GoTrue, nunca loop.
--
-- 2) CONDIÇÃO FROUXA (achado de revisão): "se não está vazio, limpa" é
--    perigoso demais sozinho — limparia sem querer qualquer metadata
--    futura legítima de um usuário JÁ provisionado (ex: se um dia
--    guardarmos preferência de notificação em raw_user_meta_data depois
--    do signup). Resolvido com uma janela de tempo: só considera "eco
--    do GoTrue" uma reescrita que aconteça a poucos minutos da CRIAÇÃO
--    da conta (o gap real medido foi 100-500ms; 2 minutos já é margem
--    generosa) — combinado com OLD = '{}' (é uma "revivificação" do que
--    acabamos de limpar, não uma edição por cima de metadata já
--    preenchida). Uma atualização legítima de metadata dias/meses
--    depois do signup, mesmo que também parta de '{}', cai fora da
--    janela de tempo e não é tocada. Limitação documentada: uma
--    hipotética atualização legítima ocorrendo nos primeiros 2 minutos
--    de vida da conta também seria limpa — nenhum fluxo atual do
--    produto faz isso; se algum dia fizer, essa janela precisa ser
--    revisitada.
--
-- A checagem de "já existe entregadores/usuarios_loja pra esse
-- auth_user_id" continua dentro do corpo da função (defesa adicional:
-- garante que só tocamos linhas que ESTE mecanismo provisionou) — o
-- WHEN não pode ter subquery/EXISTS (erro real do Postgres: "cannot use
-- subquery in trigger WHEN condition"), só expressões escalares.
create or replace function limpar_metadata_apos_provisionamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from entregadores where auth_user_id = new.id)
    or exists (select 1 from usuarios_loja where auth_user_id = new.id) then
    update auth.users set raw_user_meta_data = '{}'::jsonb where id = new.id;
  end if;
  return new;
end;
$$;

create trigger trg_limpar_metadata_apos_provisionamento
  after update on auth.users
  for each row
  when (
    old.raw_user_meta_data is distinct from new.raw_user_meta_data
    and old.raw_user_meta_data = '{}'::jsonb
    and new.raw_user_meta_data <> '{}'::jsonb
    and now() - new.created_at < interval '2 minutes'
  )
  execute function limpar_metadata_apos_provisionamento();

-- ==============================================================
-- REALTIME (seção B2 da análise de mercado) — sem isso, os canais
-- postgres_changes abertos por painel-loja.html (iniciarAtualizacoesAoVivo())
-- nunca disparam evento nenhum: uma tabela só entra no fluxo de Realtime do
-- Supabase se estiver na publication supabase_realtime. Achado real (validação
-- contra banco de verdade, 14/08/2026): a publication estava vazia — o recurso
-- de atualização ao vivo nunca funcionaria em produção, independente de RLS.
-- ==============================================================
alter publication supabase_realtime add table localizacoes_entregador;
alter publication supabase_realtime add table alertas_seguranca;
-- tentativas_despacho (sessão de go-to-market, 15/08/2026): sem isso, o
-- modal de "nova oferta de entrega" em app-entregador.html nunca dispararia
-- — mesmo achado de padrão que os dois de cima, mesma causa raiz.
alter publication supabase_realtime add table tentativas_despacho;
-- pedidos e rotas_entrega (achado real, teste operacional de ponta a ponta,
-- 18/08/2026): carregarPedidos()/carregarRotas() em painel-loja.html nunca
-- reagiam a mudança nenhuma feita por fora da própria aba (ex: motoboy
-- confirmando entrega) — só carregavam uma vez no login. Confirmado ao vivo:
-- pedido virou 'entregue' e rota virou 'concluida' no banco de verdade, mas
-- a UI continuou mostrando o status antigo até um F5 manual. Mesmo padrão
-- de causa raiz dos itens acima — tabela fora da publication.
alter publication supabase_realtime add table pedidos;
alter publication supabase_realtime add table rotas_entrega;
-- entrega_rota (módulo feira, sessão de 22/08/2026): 4ª ocorrência do MESMO
-- padrão de causa raiz documentado acima — o canal de oferta de feira em
-- app-entregador.html (INSERT/UPDATE em entrega_rota) não disparava nada,
-- confirmado ao vivo (UPDATE aconteceu no banco, nada chegou no client).
-- Ver "REGRA GERAL" em CLAUDE.md: checar a publication é o PRIMEIRO passo
-- ao criar qualquer canal novo, antes de debugar filtro/handler/RLS.
alter publication supabase_realtime add table entrega_rota;
-- proposta_consolidacao (achado real, sessão de 22/08/2026): mesma
-- checklist já aplicada de cara desta vez — sem isso, o card de "nova
-- parada proposta" nunca chegaria no app do entregador.
alter publication supabase_realtime add table proposta_consolidacao;
-- entregadores (sessão de 23/08/2026, aprovação de entregador pela loja):
-- checklist aplicada de cara de novo — sem isso, nem painel-loja.html
-- saberia de um cadastro pendente novo em tempo real, nem app-entregador.html
-- saberia que foi aprovado/reprovado sem precisar de F5.
alter publication supabase_realtime add table entregadores;

-- ==============================================================
-- STORAGE (seção 39) — buckets privados pros documentos e fotos
-- de entrega que as telas de cadastro e entrega precisam. Rode
-- isso depois de tudo acima; os buckets precisam existir antes
-- de qualquer upload funcionar.
-- ==============================================================

insert into storage.buckets (id, name, public)
values
  ('documentos-privados', 'documentos-privados', false),
  ('comprovantes', 'comprovantes', false)
on conflict (id) do nothing;

-- só o próprio usuário autenticado sobe arquivo na pasta que ele criou
create policy "usuario sobe seus proprios documentos" on storage.objects
  for insert with check (
    bucket_id = 'documentos-privados' and auth.uid() is not null
  );

create policy "usuario ve seus proprios documentos" on storage.objects
  for select using (
    bucket_id = 'documentos-privados' and auth.uid() is not null
  );

create policy "entregador sobe foto de entrega" on storage.objects
  for insert with check (
    bucket_id = 'comprovantes' and auth.uid() is not null
  );

create policy "loja ve fotos de entrega dos seus pedidos" on storage.objects
  for select using (
    bucket_id = 'comprovantes' and auth.uid() is not null
  );

-- ==============================================================
-- INTEGRACOES (seção 40) — credenciais de API por loja (Brendi,
-- WhatsApp, provedor de Pix). Separada de `tenants` de propósito:
-- é dado mais sensível, acessado com menos frequência, e só o
-- dono (não funcionário) pode ver ou editar.
-- ==============================================================
create table if not exists integracoes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,

  brendi_api_key text,

  whatsapp_phone_number_id text,
  whatsapp_access_token text,
  whatsapp_webhook_verify_token text,

  pix_provider text check (pix_provider in ('mercado_pago', 'asaas', 'stone', 'outro')),
  pix_provider_api_key text,

  atualizado_em timestamptz not null default now()
);

create unique index if not exists idx_integracoes_tenant
  on integracoes (tenant_id);

alter table integracoes enable row level security;

-- só o dono (não funcionário) vê ou edita — funcionário não tem acesso nenhum,
-- nem pedindo PIN, porque a checagem de papel já bloqueia antes disso
create policy "dono ve e edita integracoes do seu tenant" on integracoes for all using (
  tenant_id in (select minhas_tenant_ids_dono())
);

-- ------------------------------------------------------------
-- PIN de segurança da aba de Integrações — definido e verificado
-- só por essas duas funções; a coluna pin_integracoes_hash nunca
-- é lida nem escrita diretamente pelo cliente (sem policy de
-- select/update nela na prática, só via RPC abaixo)
-- ------------------------------------------------------------
create or replace function set_pin_integracoes(novo_pin text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp -- extensions: onde o pgcrypto
  -- (gen_salt/crypt) fica instalado no Supabase hospedado, não em public
as $$
  update usuarios_loja
  set pin_integracoes_hash = crypt(novo_pin, gen_salt('bf'))
  where auth_user_id = auth.uid() and papel = 'dono';
$$;

create or replace function verificar_pin_integracoes(tentativa text)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    (select pin_integracoes_hash = crypt(tentativa, pin_integracoes_hash)
     from usuarios_loja
     where auth_user_id = auth.uid() and papel = 'dono' and pin_integracoes_hash is not null),
    false
  );
$$;

create or replace function tem_pin_integracoes()
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select pin_integracoes_hash is not null
     from usuarios_loja where auth_user_id = auth.uid() and papel = 'dono'),
    false
  );
$$;

-- ==============================================================
-- SEGURANÇA — DETECÇÃO DE MOTOBOY PARADO E DESVIO DE ROTA (Parte B da
-- análise de mercado, itens B3/B4). `localizacoes_entregador` já
-- guardava histórico de posição, mas nada consumia esse dado pra gerar
-- alerta de verdade — as funções abaixo fecham esse gap.
--
-- Padrão adaptado do Torre (fleet-orchestrator, projeto irmão): lá o
-- mesmo problema (muitos agentes móveis reportando posição, alerta em
-- tempo real sobre o que sai do esperado) já está validado em produção
-- via computeStalledSeconds()/computeMissionAlerts() em JS num backend
-- Node. O GiroCerto não tem esse backend — fala direto com o Supabase —
-- então o algoritmo foi portado pra dentro do Postgres como trigger,
-- seguindo a mesma convenção que este schema já usa pras funções de PIN
-- de Integrações: lógica de segurança sensível vive em função SQL, não
-- em JS de cliente, porque não pode depender de alguém com a aba do
-- painel aberta pra funcionar.
-- ==============================================================

-- ------------------------------------------------------------
-- Decodifica uma polyline no formato OSRM/Google Encoded Polyline
-- Algorithm Format (a mesma codificação usada por rotas_entrega.
-- rota_polyline) numa geography LINESTRING utilizável pelo PostGIS.
-- Algoritmo padrão (varint de 5 bits + zigzag), sem dependência externa.
-- ------------------------------------------------------------
create or replace function decodificar_polyline(p_encoded text)
returns geography
language plpgsql
as $$
declare
  v_index int := 1;
  v_len int := length(coalesce(p_encoded, ''));
  v_lat int := 0;
  v_lng int := 0;
  v_points geometry[] := array[]::geometry[];
  v_byte int;
  v_shift int;
  v_result int;
  v_dlat int;
  v_dlng int;
begin
  if p_encoded is null or p_encoded = '' then
    return null;
  end if;

  while v_index <= v_len loop
    v_shift := 0; v_result := 0;
    loop
      v_byte := ascii(substr(p_encoded, v_index, 1)) - 63;
      v_index := v_index + 1;
      v_result := v_result | ((v_byte & 31) << v_shift);
      v_shift := v_shift + 5;
      exit when v_byte < 32;
    end loop;
    v_dlat := case when (v_result & 1) != 0 then -((v_result >> 1) + 1) else (v_result >> 1) end;
    v_lat := v_lat + v_dlat;

    v_shift := 0; v_result := 0;
    loop
      v_byte := ascii(substr(p_encoded, v_index, 1)) - 63;
      v_index := v_index + 1;
      v_result := v_result | ((v_byte & 31) << v_shift);
      v_shift := v_shift + 5;
      exit when v_byte < 32;
    end loop;
    v_dlng := case when (v_result & 1) != 0 then -((v_result >> 1) + 1) else (v_result >> 1) end;
    v_lng := v_lng + v_dlng;

    v_points := v_points || ST_MakePoint(v_lng / 1e5::float, v_lat / 1e5::float);
  end loop;

  if array_length(v_points, 1) is null or array_length(v_points, 1) < 2 then
    return null; -- polyline vazia/malformada ou com 1 ponto só — não dá pra formar uma linha
  end if;

  return ST_SetSRID(ST_MakeLine(v_points), 4326)::geography;
end;
$$;

-- ------------------------------------------------------------
-- Checa se um ponto está dentro da tolerância (em km) da polyline
-- planejada de uma rota. Devolve NULL (não FALSE) quando não há
-- polyline pra comparar — importante pro chamador não confundir "sem
-- dado" com "confirmadamente fora da rota".
-- ------------------------------------------------------------
create or replace function esta_dentro_da_rota(p_lat double precision, p_lng double precision, p_rota_id uuid, p_km_tolerancia numeric)
returns boolean
language plpgsql
as $$
declare
  v_linha geography;
begin
  select decodificar_polyline(rota_polyline) into v_linha
  from rotas_entrega where id = p_rota_id;

  if v_linha is null then
    return null;
  end if;

  return ST_DWithin(v_linha, ST_MakePoint(p_lng, p_lat)::geography, p_km_tolerancia * 1000);
end;
$$;

-- ------------------------------------------------------------
-- Trigger BEFORE INSERT: preenche localizacoes_entregador.dentro_da_rota
-- na hora, usando o km_desvio_alerta do tenant do entregador. security
-- definer porque essa checagem cruza entregadores/tenants/rotas_entrega
-- independente de qual policy de RLS o chamador tem — é lógica de
-- sistema, não uma consulta arbitrária do cliente.
-- ------------------------------------------------------------
create or replace function preencher_dentro_da_rota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_km_tolerancia numeric;
begin
  if new.rota_id is null then
    new.dentro_da_rota := null;
    return new;
  end if;

  select t.km_desvio_alerta into v_km_tolerancia
  from entregadores e
  join tenants t on t.id = e.tenant_id
  where e.id = new.entregador_id;

  new.dentro_da_rota := esta_dentro_da_rota(new.lat, new.lng, new.rota_id, coalesce(v_km_tolerancia, 3.0));
  return new;
end;
$$;

create trigger trg_preencher_dentro_da_rota
  before insert on localizacoes_entregador
  for each row execute function preencher_dentro_da_rota();

-- ------------------------------------------------------------
-- Há quanto tempo (segundos) a posição do entregador está parada numa
-- rota específica — anda de trás pra frente pelo histórico enquanto a
-- posição ficar dentro de 15m da mais recente (tolerância de ruído de
-- GPS parado), e devolve a idade da leitura mais antiga desse "platô".
-- Mesmo algoritmo do computeStalledSeconds() do Torre, usando
-- ST_Distance/geography em vez de epsilon de grau — mais preciso, já
-- que o PostGIS está disponível aqui.
-- ------------------------------------------------------------
create or replace function calcular_segundos_parado(p_entregador_id uuid, p_rota_id uuid)
returns numeric
language plpgsql
as $$
declare
  v_ultima record;
  v_plato_desde timestamptz;
  v_tolerancia_metros constant numeric := 15;
  v_iniciada_em timestamptz;
  rec record;
begin
  -- achado ultrareview (bug_004): sem esse corte, o walk pra trás incluía a
  -- espera na loja (motoboy já grava posição em a_caminho_da_loja, mesmo
  -- rota_id) — o próprio ciclo ocioso que o produto ataca virava alerta de
  -- "motoboy parado" assim que a rota virava em_entrega. iniciada_em =
  -- motoboy saiu da loja com os pedidos, é o início real do platô que importa.
  select iniciada_em into v_iniciada_em from rotas_entrega where id = p_rota_id;

  select lat, lng, registrado_em into v_ultima
  from localizacoes_entregador
  where entregador_id = p_entregador_id and rota_id = p_rota_id
    and registrado_em >= coalesce(v_iniciada_em, '-infinity'::timestamptz)
  order by registrado_em desc
  limit 1;

  if v_ultima is null then
    return 0;
  end if;

  v_plato_desde := v_ultima.registrado_em;

  for rec in
    select lat, lng, registrado_em
    from localizacoes_entregador
    where entregador_id = p_entregador_id and rota_id = p_rota_id
      and registrado_em < v_ultima.registrado_em
      and registrado_em >= coalesce(v_iniciada_em, '-infinity'::timestamptz)
    order by registrado_em desc
    limit 200 -- teto de segurança, não precisa varrer histórico infinito
  loop
    exit when ST_Distance(
      ST_MakePoint(rec.lng, rec.lat)::geography,
      ST_MakePoint(v_ultima.lng, v_ultima.lat)::geography
    ) > v_tolerancia_metros;
    v_plato_desde := rec.registrado_em;
  end loop;

  return extract(epoch from (now() - v_plato_desde));
end;
$$;

-- ------------------------------------------------------------
-- Trigger AFTER INSERT: avalia os dois alertas (B3 motoboy parado, B4
-- desvio de rota) a cada nova leitura de posição. Os dois só valem
-- durante entrega ativa de verdade (rotas_entrega.status = 'em_entrega'
-- faz o papel do status 'in_progress' do Torre) — rota planejada, a
-- caminho da loja, concluída ou cancelada nunca dispara nenhum dos
-- dois, mesmo que o entregador esteja fisicamente parado (pausa/espera
-- na loja é esperada, não é alerta). B4 exige 2 leituras SEGUIDAS fora
-- (esta + a anterior) antes de criar o alerta, pra não disparar por
-- ruído pontual de GPS na borda — mesma regra validada no Torre.
-- Nunca duplica alerta: só insere se não houver um do mesmo tipo ainda
-- 'aguardando_confirmacao' pra essa rota.
-- ------------------------------------------------------------
create or replace function avaliar_alertas_seguranca_localizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rota_status text;
  v_segundos_parado numeric;
  v_segundos_limite integer;
  v_penultima_dentro boolean;
  v_ja_tem_parado boolean;
  v_ja_tem_desvio boolean;
begin
  if new.rota_id is null then
    return new;
  end if;

  select status into v_rota_status from rotas_entrega where id = new.rota_id;

  if v_rota_status is distinct from 'em_entrega' then
    return new;
  end if;

  -- B3: motoboy parado
  select t.segundos_parado_alerta into v_segundos_limite
  from entregadores e join tenants t on t.id = e.tenant_id
  where e.id = new.entregador_id;

  v_segundos_parado := calcular_segundos_parado(new.entregador_id, new.rota_id);

  select exists(
    select 1 from alertas_seguranca
    where rota_id = new.rota_id and tipo = 'motoboy_parado' and status = 'aguardando_confirmacao'
  ) into v_ja_tem_parado;

  if v_segundos_parado >= coalesce(v_segundos_limite, 180) and not v_ja_tem_parado then
    insert into alertas_seguranca (entregador_id, rota_id, tipo)
    values (new.entregador_id, new.rota_id, 'motoboy_parado');
  end if;

  -- B4: desvio de rota, só depois de 2 leituras seguidas fora
  if new.dentro_da_rota is false then
    select dentro_da_rota into v_penultima_dentro
    from localizacoes_entregador
    where entregador_id = new.entregador_id and rota_id = new.rota_id
      and id != new.id
    order by registrado_em desc
    limit 1;

    if v_penultima_dentro is false then
      select exists(
        select 1 from alertas_seguranca
        where rota_id = new.rota_id and tipo = 'desvio_rota' and status = 'aguardando_confirmacao'
      ) into v_ja_tem_desvio;

      if not v_ja_tem_desvio then
        insert into alertas_seguranca (entregador_id, rota_id, tipo)
        values (new.entregador_id, new.rota_id, 'desvio_rota');
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_avaliar_alertas_seguranca_localizacao
  after insert on localizacoes_entregador
  for each row execute function avaliar_alertas_seguranca_localizacao();

-- ==============================================================
-- MOTOR DE DESPACHO — triggers de notificação (sessão de go-to-market,
-- 15/08/2026). O motor em si roda fora do Postgres (serviço Node/Express,
-- ver dispatch-engine/, hospedado no Railway) — essas duas triggers são só
-- o "campainha": avisam o backend via LISTEN/NOTIFY (testado e confirmado
-- confiável contra a conexão direta do Supabase hospedado, não o pooler
-- transacional — ver CLAUDE.md) que algo mudou e precisa de ação.
--
-- ACHADO REAL (24/08/2026): a suíte de testes roda contra esse mesmo banco
-- hospedado (não existe banco de teste separado) — sem esse filtro, o
-- motor de PRODUÇÃO real (Railway) recebia o NOTIFY de pedido de TESTE
-- junto com o dispatch-engine que o próprio teste sobe como child process,
-- e os dois competiam pelo mesmo pedido (2 ofertas simultâneas, failover
-- incerto, checagem de duplicata capturando estado já mexido pela outra
-- sessão). Por isso agora SÃO SECURITY DEFINER: precisam ler tenants (e,
-- pra resposta de despacho, rotas_entrega) pra decidir se é tenant de
-- teste, com garantia de leitura independente da RLS de quem fez o UPDATE
-- (ex: o próprio entregador respondendo a tentativa, cuja RLS não
-- necessariamente cobre a leitura de tenants de terceiros). Pedido/tentativa
-- de tenant de teste nunca gera pg_notify — o motor de produção nunca vê
-- pedido de teste. Os TESTES, que dependiam do NOTIFY real pra acordar o
-- dispatch-engine que eles mesmos spawnam, passaram a chamar a função de
-- despacho diretamente (ver dispatch-engine/index.js, processarPedidoPronto
-- exportado, e tests/despacho_motor.test.js).
-- ==============================================================

create or replace function notificar_pedido_pronto()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from tenants where id = new.tenant_id and is_teste = true
  ) then
    perform pg_notify('pedido_pronto', new.id::text);
  end if;
  return new;
end;
$$;

create trigger trg_notificar_pedido_pronto
  after update on pedidos
  for each row
  when (new.status = 'pronto' and old.status is distinct from 'pronto')
  execute function notificar_pedido_pronto();

create or replace function notificar_resposta_despacho()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.resultado is not null and new.resultado is distinct from old.resultado then
    if not exists (
      select 1 from rotas_entrega r
      join tenants t on t.id = r.tenant_id
      where r.id = new.rota_id and t.is_teste = true
    ) then
      perform pg_notify('tentativa_despacho_respondida', new.id::text);
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_notificar_resposta_despacho
  after update on tentativas_despacho
  for each row execute function notificar_resposta_despacho();

-- ------------------------------------------------------------
-- Ao confirmar a entrega (pedidos.status -> 'entregue'), fecha o ciclo:
-- rota concluída e entregador liberado pra próxima oferta. v1 só tem 1
-- pedido por rota (sem agrupamento ainda, decisão consciente já registrada
-- no schema), então "pedido entregue" e "rota concluída" são sempre o
-- mesmo evento — se agrupamento de rota for implementado no futuro, essa
-- trigger precisa checar se AINDA existem pedidos não-entregues na mesma
-- rota antes de concluir. SECURITY DEFINER porque quem confirma a entrega
-- é o entregador (RLS própria só cobre a própria linha de pedidos/rota),
-- mas fechar o ciclo também precisa atualizar `entregadores`, que a policy
-- de UPDATE do entregador já cobre pra si mesmo — mantido SECURITY DEFINER
-- mesmo assim por RESILIÊNCIA: não pode depender só do client completar
-- a chamada em duas tabelas separadas com sucesso.
-- ------------------------------------------------------------
create or replace function concluir_rota_ao_entregar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entregador_id uuid;
begin
  if new.status = 'entregue' and old.status is distinct from 'entregue' and new.rota_id is not null then
    update rotas_entrega
    set status = 'concluida', concluida_em = now()
    where id = new.rota_id and status <> 'concluida'
    returning entregador_id into v_entregador_id;

    -- achado ultrareview (2ª rodada): não sobrescrever um 'pausado' explícito
    -- — a mesma classe de bug que status_antes_pausa foi criado pra evitar em
    -- clicarContinuar(), só que aqui do lado do trigger de conclusão de rota.
    -- Uma confirmação de entrega atrasada/reenviada não deveria destravar
    -- alguém que pausou nesse meio-tempo.
    if v_entregador_id is not null then
      update entregadores set status = 'disponivel' where id = v_entregador_id and status <> 'pausado';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_concluir_rota_ao_entregar
  after update on pedidos
  for each row execute function concluir_rota_ao_entregar();

-- ==============================================================
-- MÓDULO FEIRA (feira-dispatch) — sessão de 21/08/2026
-- Domínio paralelo ao restaurante (tenants/pedidos/rotas_entrega), por
-- decisão explícita do usuário: o relacionamento de pagamento (Pix
-- peer-to-peer direto pro feirante, a plataforma nunca toca o dinheiro do
-- produto) é estruturalmente diferente de tenant único, não é só um jeito
-- diferente de modelar a mesma coisa. `entregadores` continua 100%
-- COMPARTILHADO (mesma frota atende os dois domínios na mesma conta,
-- tipo_perfil na rota diferencia, não a conta) — é a única tabela que os
-- dois domínios têm em comum.
--
-- Este bloco representa o ESTADO FINAL depois de consolidar as 9
-- migrations do módulo (`_feira-incoming`/feira-dispatch), não uma cópia
-- literal de cada uma — funções que uma migration posterior redefinia
-- (create or replace) aparecem aqui só na versão final. Duas adaptações
-- foram necessárias em cima do que o módulo trouxe:
--   1. `estabelecimentos`, `usuarios`, `produtos` — o módulo assumia que já
--      existiam (comentário do próprio arquivo: "Assume que já existem").
--      Não existem no GiroCerto — criadas do zero aqui, com o mínimo de
--      colunas exigido pelo uso real em todas as 9 migrations + o código
--      em src/.
--   2. Toda referência a `entregadores.latitude`/`.longitude` corrigida
--      pra `entregadores.lat`/`.lng` (nome real da coluna, confirmado
--      contra o banco hospedado antes de aplicar) — o módulo assumia
--      `latitude`/`longitude`, que não existe.
--   3. `entregadores.tenant_id` vira nullable (entregador 100% feira, sem
--      vínculo de restaurante) + novo `entregadores.aceita_feira` (
--      elegibilidade pra oferta de feira, independente de tenant_id — a
--      MESMA conta pode ter tenant_id preenchido E aceita_feira=true).
--
-- RLS não veio no módulo nenhuma (zero `enable row level security`, zero
-- `create policy` nos 9 arquivos originais) — escrita do zero aqui,
-- seguindo o mesmo padrão do resto do schema (funções SECURITY DEFINER
-- pra qualquer lookup de identidade, nunca subselect cru repetido).
-- ==============================================================

-- ---------------------------------------------------------------------
-- 0. AJUSTES EM `entregadores` (tabela compartilhada)
-- ---------------------------------------------------------------------
alter table entregadores alter column tenant_id drop not null;

alter table entregadores add column if not exists aceita_feira boolean not null default false;
comment on column entregadores.aceita_feira is
  'Elegibilidade pra receber oferta de despacho da feira. Independente de '
  'tenant_id: a mesma conta pode atender restaurante (tenant_id preenchido) '
  'e feira (aceita_feira=true) no mesmo turno — tipo_perfil na rota '
  '(entrega_rota.tipo_perfil) diferencia o contexto, não a conta.';

-- Push nativo pro entregador (planejamento FCM, 22/08/2026) — mesmas
-- colunas que `usuarios` (consumidor) já tem, mas com SOM PRÓPRIO: o
-- entregador só ouve buzina_bi_bi.mp3 fixo (ver enviarPushBuzinaEntregador
-- em notifications.js), nunca o pipeline de mistura buzina+voz que é
-- exclusivo do canal do consumidor.
alter table entregadores add column if not exists push_token text;
alter table entregadores add column if not exists push_plataforma text check (push_plataforma in ('android', 'ios'));

-- ---------------------------------------------------------------------
-- 1. TABELAS QUE O MÓDULO ASSUMIA JÁ EXISTIREM — criadas do zero
-- ---------------------------------------------------------------------
create table if not exists estabelecimentos (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  nome text not null,
  tipo_negocio text not null default 'feirante'
    check (tipo_negocio in ('restaurante', 'feirante', 'outro')),
  telefone text,  -- número usado pro worker de notificação (WhatsApp)
  chave_pix text,
  latitude double precision,   -- endereço cadastral, fallback se a banca
  longitude double precision,  -- não tiver latitude_banca/longitude_banca
  criado_em timestamptz not null default now()
);

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  nome text not null,
  telefone text,
  push_token text,
  push_plataforma text check (push_plataforma in ('android', 'ios')),
  criado_em timestamptz not null default now()
);

create table if not exists produtos (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  nome text not null,
  preco numeric(10,2) not null default 0,
  peso_kg numeric(6,3) not null default 0,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. FEIRA (entidade normalizada — vários feirantes compartilham a mesma)
-- ---------------------------------------------------------------------
create table if not exists feira (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  bairro text,
  cidade text,
  valor_minimo_pedido numeric(10,2) not null default 25.00,
  created_at timestamptz default now()
);

create table if not exists feira_ocorrencia (
  id uuid primary key default gen_random_uuid(),
  feira_id uuid references feira(id) not null,
  dia_semana int not null check (dia_semana between 0 and 6), -- 0=domingo
  endereco text not null,
  latitude double precision not null,
  longitude double precision not null,
  horario_inicio time not null,
  horario_fim time not null,
  corte_pedido_min_antes int not null default 120,
  created_at timestamptz default now(),
  unique (feira_id, dia_semana)
);

create table if not exists feira_ocorrencia_excecao (
  id uuid primary key default gen_random_uuid(),
  feira_ocorrencia_id uuid references feira_ocorrencia(id) not null,
  data date not null,
  disponivel boolean not null default false,
  motivo text,
  created_at timestamptz default now(),
  unique (feira_ocorrencia_id, data)
);

-- ---------------------------------------------------------------------
-- 3. VÍNCULO FEIRANTE <-> FEIRA (participação) + exceção individual +
--    posição real da banca (migration 004 — sem hub de coleta único, a
--    taxa de entrega depende de onde a banca fica DENTRO da feira, não só
--    do endereço cadastral do feirante)
-- ---------------------------------------------------------------------
create table if not exists feirante_participacao (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  feira_ocorrencia_id uuid references feira_ocorrencia(id) not null,
  ativo boolean not null default true,
  latitude_banca double precision,
  longitude_banca double precision,
  created_at timestamptz default now(),
  unique (estabelecimento_id, feira_ocorrencia_id)
);

comment on column feirante_participacao.latitude_banca is
  'Posição real da banca dentro da feira. Se nulo, o motor de taxa usa '
  'estabelecimentos.latitude/longitude como aproximação (endereço cadastral, '
  'menos preciso). Preencher via "marcar minha banca no mapa" no app do feirante.';

create table if not exists feirante_excecoes (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  feira_ocorrencia_id uuid references feira_ocorrencia(id) not null,
  data date not null,
  disponivel boolean not null default false,
  motivo text,
  created_at timestamptz default now(),
  unique (estabelecimento_id, feira_ocorrencia_id, data)
);

-- ---------------------------------------------------------------------
-- 4. PEDIDO EM DUAS CAMADAS: grupo (1 consumidor, 1 feira, N feirantes)
--    e pedido individual (1 feirante dentro do grupo) — inclui as colunas
--    de auditoria/timeout/métricas que migrations 003/005 adicionaram
-- ---------------------------------------------------------------------
create table if not exists pedido_grupo (
  id uuid primary key default gen_random_uuid(),
  consumidor_id uuid references usuarios(id) not null,
  feira_ocorrencia_id uuid references feira_ocorrencia(id) not null,
  entregador_id uuid references entregadores(id),
  taxa_entrega numeric(10,2) not null default 0,
  qtd_paradas int not null default 1,
  status text not null default 'aguardando_pagamentos'
    check (status in ('aguardando_pagamentos','pronto_para_coleta','em_rota','entregue','cancelado')),
  endereco_entrega text not null,
  latitude_entrega double precision not null,
  longitude_entrega double precision not null,
  expira_em timestamptz default (now() + interval '20 minutes'),
  trecho_a_pe_km numeric(8,3),
  trecho_ate_entrega_km numeric(8,3),
  qtd_bancas int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists pedido (
  id uuid primary key default gen_random_uuid(),
  pedido_grupo_id uuid references pedido_grupo(id) not null,
  estabelecimento_id uuid references estabelecimentos(id) not null,
  valor_produtos numeric(10,2) not null default 0,
  chave_pix_feirante text not null,
  status_pagamento text not null default 'pendente'
    check (status_pagamento in ('pendente','confirmado')),
  status_pagamento_final text
    check (status_pagamento_final in ('confirmado','expirado')) default null,
  status_coleta text not null default 'aguardando'
    check (status_coleta in ('aguardando','liberado_pagamento','finalizado','coletado')),
  confirmado_por uuid references usuarios(id),
  confirmado_em timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists pedido_item (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references pedido(id) not null,
  produto_id uuid references produtos(id) not null,
  quantidade numeric(10,3) not null,
  preco_unitario numeric(10,2) not null,
  peso_unitario numeric(6,3) not null default 0,
  subtotal numeric(10,2) generated always as (quantidade * preco_unitario) stored,
  peso_subtotal numeric(10,3) generated always as (quantidade * peso_unitario) stored
);

-- ---------------------------------------------------------------------
-- 5. NOTA DE IDENTIFICAÇÃO (gerada quando feirante finaliza separação)
-- ---------------------------------------------------------------------
create table if not exists pedido_nota (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references pedido(id) not null unique,
  codigo_curto char(4) not null,
  nome_cliente text not null,
  qtd_itens int not null,
  peso_total numeric(10,3) not null,
  gerada_em timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 6. ROTA DO ENTREGADOR (multi-pickup, multi-dropoff — feira ou
--    restaurante; própria da feira, NÃO compartilhada com rotas_entrega
--    do restaurante — decisão explícita: zero risco pro que já está em
--    produção pesa mais que evitar essa duplicação)
-- ---------------------------------------------------------------------
create table if not exists dispatch_config (
  tipo_perfil text primary key,
  max_paradas int not null,
  max_detour_pct numeric not null,
  max_espera_montagem_seg int not null,
  peso_max_kg numeric not null default 15,
  margem_seguranca_kg numeric not null default 2
);

insert into dispatch_config (tipo_perfil, max_paradas, max_detour_pct, max_espera_montagem_seg, peso_max_kg, margem_seguranca_kg)
values
  ('feira', 5, 0.40, 240, 15, 2),
  ('restaurante', 3, 0.15, 60, 15, 1),
  ('misto', 4, 0.25, 120, 15, 2)
on conflict (tipo_perfil) do update set
  max_paradas = excluded.max_paradas,
  max_detour_pct = excluded.max_detour_pct,
  max_espera_montagem_seg = excluded.max_espera_montagem_seg,
  peso_max_kg = excluded.peso_max_kg,
  margem_seguranca_kg = excluded.margem_seguranca_kg;

create table if not exists entrega_rota (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid references entregadores(id) not null,
  tipo_perfil text not null default 'feira' references dispatch_config(tipo_perfil),
  status text not null default 'em_montagem'
    check (status in ('em_montagem','em_rota','finalizada','cancelada')),
  peso_total numeric(10,3) not null default 0,
  distancia_total_km numeric(10,3),
  aceita_em timestamptz,
  distancia_ate_feira_km numeric(8,3),
  bonus_deslocamento numeric(10,2),
  tempo_espera_total_seg int default 0,
  valor_tempo_espera numeric(10,2) default 0,
  aberta_em timestamptz default now(),
  fechada_em timestamptz
);

create table if not exists entrega_rota_grupo (
  id uuid primary key default gen_random_uuid(),
  entrega_rota_id uuid references entrega_rota(id) not null,
  pedido_grupo_id uuid references pedido_grupo(id) not null,
  unique (pedido_grupo_id)
);

-- paradas físicas sequenciadas (coleta em feirante ou entrega ao consumidor)
create table if not exists rota_parada (
  id uuid primary key default gen_random_uuid(),
  entrega_rota_id uuid references entrega_rota(id) not null,
  tipo text not null check (tipo in ('coleta','entrega')),
  pedido_id uuid references pedido(id),
  pedido_grupo_id uuid references pedido_grupo(id),
  latitude double precision not null,
  longitude double precision not null,
  latitude_confirmada double precision,
  longitude_confirmada double precision,
  divergencia_m numeric,
  ordem int not null,
  status text not null default 'pendente' check (status in ('pendente','concluida')),
  chegou_em timestamptz,
  concluida_em timestamptz,
  notificado_a_caminho boolean default false,
  notificado_proximidade boolean default false,
  check (
    (tipo = 'coleta' and pedido_id is not null) or
    (tipo = 'entrega' and pedido_grupo_id is not null)
  )
);

-- ---------------------------------------------------------------------
-- 6.1 AVALIAÇÕES — criada aqui (antes das views da seção 11, que incluem
--     avaliacao_media referenciando esta tabela)
-- ---------------------------------------------------------------------
create table if not exists avaliacao (
  id uuid primary key default gen_random_uuid(),
  pedido_grupo_id uuid references pedido_grupo(id) not null,
  avaliador_tipo text not null check (avaliador_tipo in ('consumidor','feirante','entregador')),
  avaliador_id uuid not null,
  avaliado_tipo text not null check (avaliado_tipo in ('feirante','entregador')),
  avaliado_id uuid not null,
  nota int not null check (nota between 1 and 5),
  comentario text,
  created_at timestamptz default now(),
  unique (pedido_grupo_id, avaliador_id, avaliado_id)
);

-- ---------------------------------------------------------------------
-- 7. MÉTRICAS REAIS DE CORRIDA (migration 005) — 1 linha por rota
--    finalizada, pra revisar o piso mínimo com dado real, não estimativa
-- ---------------------------------------------------------------------
create table if not exists entrega_metrica (
  id uuid primary key default gen_random_uuid(),
  entrega_rota_id uuid references entrega_rota(id) not null unique,
  entregador_id uuid references entregadores(id) not null,
  tipo_perfil text not null,
  qtd_grupos int not null,
  qtd_bancas_total int not null,
  peso_total_kg numeric(8,3) not null,
  trecho_a_pe_km_total numeric(8,3) not null,
  trecho_ate_entrega_km_total numeric(8,3) not null,
  taxa_cobrada_total numeric(10,2) not null,
  aceita_em timestamptz not null,
  primeira_coleta_em timestamptz,
  ultima_entrega_em timestamptz,
  tempo_total_seg int,
  remuneracao_por_hora numeric(10,2),
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 8. REGRAS POR VEÍCULO (migration 006) — não altera entregadores.tipo_veiculo
--    (já existe, mesma definição: not null default 'moto', check moto/bicicleta)
-- ---------------------------------------------------------------------
create table if not exists veiculo_config (
  tipo_veiculo text primary key,
  raio_coleta_km numeric not null,
  peso_max_kg numeric not null
);

insert into veiculo_config (tipo_veiculo, raio_coleta_km, peso_max_kg) values
  ('moto', 1.5, 15),
  ('bicicleta', 0.8, 5)
on conflict (tipo_veiculo) do update set
  raio_coleta_km = excluded.raio_coleta_km,
  peso_max_kg = excluded.peso_max_kg;

create table if not exists veiculo_raio_entrega (
  tipo_veiculo text not null,
  tipo_perfil text not null,
  raio_entrega_km numeric not null,
  primary key (tipo_veiculo, tipo_perfil)
);

insert into veiculo_raio_entrega (tipo_veiculo, tipo_perfil, raio_entrega_km) values
  ('moto', 'feira', 8),
  ('moto', 'restaurante', 6),
  ('moto', 'misto', 6),
  ('bicicleta', 'feira', 2),
  ('bicicleta', 'restaurante', 2),
  ('bicicleta', 'misto', 2)
on conflict (tipo_veiculo, tipo_perfil) do update set raio_entrega_km = excluded.raio_entrega_km;

-- ---------------------------------------------------------------------
-- 9. PISO REGULATÓRIO DE REFERÊNCIA (migration 007 — PL 2479/25)
-- ---------------------------------------------------------------------
create table if not exists piso_regulatorio_config (
  id int primary key default 1,
  valor_base numeric not null default 10.00,
  km_base numeric not null default 4.0,
  valor_km_adicional numeric not null default 2.50,
  valor_minuto_espera numeric not null default 0.60,
  fonte text default 'PL 2479/25 - pacote do governo federal (referência, não lei vigente)',
  atualizado_em timestamptz default now(),
  check (id = 1)
);
insert into piso_regulatorio_config (id) values (1) on conflict (id) do nothing;

create table if not exists oferta_recusada (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid references entregadores(id) not null,
  entrega_rota_id uuid references entrega_rota(id),
  taxa_ofertada numeric(10,2),
  distancia_km numeric(8,3),
  tempo_estimado_min numeric(8,1),
  recusada_em timestamptz default now()
);
comment on table oferta_recusada is
  'Apenas para análise agregada de precificação. NUNCA usar para pontuar, '
  'despriorizar ou suspender um entregador individualmente — conforme PL 2479/25.';

create table if not exists entregador_flag_revisao (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid references entregadores(id) not null,
  motivo text not null,
  detalhe jsonb default '{}',
  status text not null default 'aguardando_revisao'
    check (status in ('aguardando_revisao', 'revisado_sem_acao', 'revisado_com_advertencia', 'revisado_com_suspensao')),
  revisado_por uuid references usuarios(id),
  revisado_em timestamptz,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 10. NOTIFICAÇÃO (migrations 003/008/009 — fila consumida por worker
--     externo; canal push_voz depende do app nativo Capacitor, ver plano)
-- ---------------------------------------------------------------------
create table if not exists notificacao (
  id uuid primary key default gen_random_uuid(),
  destinatario_tipo text not null check (destinatario_tipo in ('consumidor','feirante','entregador')),
  destinatario_id uuid not null,
  canal text not null default 'whatsapp' check (canal in ('whatsapp','push','push_voz')),
  evento text not null,
  payload jsonb not null default '{}',
  status text not null default 'pendente' check (status in ('pendente','enviado','falhou')),
  created_at timestamptz default now(),
  enviado_em timestamptz
);

-- ---------------------------------------------------------------------
-- NOTIFICAÇÃO DO RESTAURANTE (item 34, 25/08/2026) — fila SEPARADA da
-- `notificacao` acima de propósito: aquela é do módulo feira, endereçada
-- por destinatario_tipo/destinatario_id (um "consumidor" com registro
-- próprio e UUID). O cliente do restaurante não tem registro nenhum — só
-- `pedidos.cliente_nome`/`cliente_telefone` em texto livre — não dá pra
-- forçar no mesmo formato sem inventar um destinatario_id falso. Mesmo
-- worker externo pode consumir as duas filas, só que essa aqui já vem
-- com o telefone pronto, sem precisar resolver destinatario_id->telefone.
-- ---------------------------------------------------------------------
create table if not exists notificacao_restaurante (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos(id) on delete cascade,
  telefone text not null,
  evento text not null,
  payload jsonb not null default '{}',
  status text not null default 'pendente' check (status in ('pendente','enviado','falhou')),
  criado_em timestamptz not null default now(),
  enviado_em timestamptz
);
create index if not exists idx_notificacao_restaurante_pedido
  on notificacao_restaurante (pedido_id);
create index if not exists idx_notificacao_restaurante_pendente
  on notificacao_restaurante (criado_em) where status = 'pendente';

create table if not exists notificacao_proximidade_config (
  id int primary key default 1,
  distancia_aviso_km numeric not null default 0.4,
  intervalo_minimo_atualizacao_seg int not null default 15,
  check (id = 1)
);
insert into notificacao_proximidade_config (id) values (1) on conflict (id) do nothing;

create table if not exists notificacao_audio (
  evento text primary key,
  url_audio text not null,
  duracao_seg numeric not null,
  texto_referencia text not null,
  atualizado_em timestamptz default now()
);

insert into notificacao_audio (evento, url_audio, duracao_seg, texto_referencia) values
  ('saiu_entrega', 'https://cdn.girocerto.com/audio/saiu_entrega.mp3', 2.0,
   'Bi-bi (buzina) + "Seu pedido está a caminho!" (voz genérica, sem nome)'),
  ('proximidade_chegada', 'https://cdn.girocerto.com/audio/proximidade.mp3', 2.5,
   'Bi-bi (buzina) + "Seu pedido está chegando! Vá até a portaria ou o portão, por favor." (voz genérica, sem nome)')
on conflict (evento) do update set
  url_audio = excluded.url_audio,
  texto_referencia = excluded.texto_referencia;

-- ---------------------------------------------------------------------
-- 11. VIEWS DE APOIO
-- ---------------------------------------------------------------------
create or replace view pedido_com_peso as
select p.id as pedido_id, p.pedido_grupo_id,
       coalesce(sum(pi.peso_subtotal), 0) as peso_total,
       coalesce(sum(pi.subtotal), 0) as valor_total,
       count(pi.id) as qtd_itens
from pedido p
left join pedido_item pi on pi.pedido_id = p.id
group by p.id;

create or replace view pedido_grupo_com_peso as
select pg.id as pedido_grupo_id,
       coalesce(sum(pcp.peso_total), 0) as peso_total
from pedido_grupo pg
join pedido_com_peso pcp on pcp.pedido_grupo_id = pg.id
group by pg.id;

create or replace view rota_disponivel as
select
  er.id as entrega_rota_id,
  er.entregador_id,
  er.status,
  er.peso_total,
  count(distinct erg.pedido_grupo_id) as qtd_grupos,
  count(rp.id) filter (where rp.status = 'pendente') as paradas_pendentes
from entrega_rota er
left join entrega_rota_grupo erg on erg.entrega_rota_id = er.id
left join rota_parada rp on rp.entrega_rota_id = er.id
group by er.id;

create or replace view avaliacao_media as
select avaliado_tipo, avaliado_id,
       round(avg(nota)::numeric, 2) as nota_media,
       count(*) as qtd_avaliacoes
from avaliacao
group by avaliado_tipo, avaliado_id;

create or replace view dashboard_vendas_feirante as
select
  p.estabelecimento_id,
  date_trunc('week', p.created_at) as semana,
  count(distinct p.id) as qtd_pedidos,
  sum(pcp.valor_total) as receita_total,
  round(avg(pcp.valor_total), 2) as ticket_medio
from pedido p
join pedido_com_peso pcp on pcp.pedido_id = p.id
where p.status_pagamento = 'confirmado'
group by p.estabelecimento_id, date_trunc('week', p.created_at);

create or replace view produtos_mais_vendidos as
select
  p.estabelecimento_id,
  pi.produto_id,
  prod.nome as produto_nome,
  sum(pi.quantidade) as qtd_total_vendida,
  sum(pi.subtotal) as receita_total
from pedido_item pi
join pedido p on p.id = pi.pedido_id
join produtos prod on prod.id = pi.produto_id
where p.status_pagamento = 'confirmado'
group by p.estabelecimento_id, pi.produto_id, prod.nome
order by qtd_total_vendida desc;

create or replace view analise_piso_minimo as
select
  case
    when trecho_a_pe_km_total < 0.05 then '1. quase zero (bancas coladas)'
    when trecho_a_pe_km_total < 0.15 then '2. curto (até 150m)'
    when trecho_a_pe_km_total < 0.30 then '3. médio (150-300m)'
    else '4. longo (300m+)'
  end as faixa_trecho_a_pe,
  count(*) as qtd_corridas,
  round(avg(tempo_total_seg) / 60.0, 1) as tempo_medio_min,
  round(avg(taxa_cobrada_total), 2) as taxa_media,
  round(avg(remuneracao_por_hora), 2) as remuneracao_hora_media,
  round(min(remuneracao_por_hora), 2) as remuneracao_hora_pior_caso
from entrega_metrica
where tipo_perfil = 'feira' and remuneracao_por_hora is not null
group by faixa_trecho_a_pe
order by faixa_trecho_a_pe;

create or replace view extrato_entregador as
select
  em.entregador_id,
  em.entrega_rota_id,
  em.tipo_perfil,
  em.taxa_cobrada_total as ganho_total,
  em.tempo_total_seg,
  em.remuneracao_por_hora,
  er.bonus_deslocamento,
  er.valor_tempo_espera,
  er.aceita_em,
  em.ultima_entrega_em as concluida_em
from entrega_metrica em
join entrega_rota er on er.id = em.entrega_rota_id
order by em.ultima_entrega_em desc;

-- ---------------------------------------------------------------------
-- 13. FUNÇÕES DE APOIO (Haversine — versões km/graus e metros)
-- ---------------------------------------------------------------------
create or replace function calcular_distancia_km(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns numeric as $$
  select 6371 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$ language sql immutable;

create or replace function calcular_divergencia_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns numeric as $$
  select 6371000 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$ language sql immutable;

-- FIX aplicado: usa entregadores.lat/entregadores.lng (não latitude/longitude,
-- que o módulo assumia e não existe). Versão final (migration 006 substituiu
-- a de 002 — só uma sobrevive, com tipo_veiculo no retorno).
create or replace function buscar_entregador_mais_proximo(
  p_latitude double precision,
  p_longitude double precision
)
returns table (id uuid, latitude double precision, longitude double precision, tipo_veiculo text)
language sql
as $$
  select e.id, e.lat, e.lng, e.tipo_veiculo
  from entregadores e
  join veiculo_config vc on vc.tipo_veiculo = e.tipo_veiculo
  where e.status = 'disponivel'
    and e.aceita_feira = true
    and calcular_distancia_km(e.lat, e.lng, p_latitude, p_longitude) <= vc.raio_coleta_km
  order by point(e.lng, e.lat) <-> point(p_longitude, p_latitude)
  limit 1;
$$;

create index if not exists idx_entregadores_veiculo on entregadores(tipo_veiculo, status);
create index if not exists idx_entregadores_aceita_feira on entregadores(aceita_feira) where aceita_feira = true;

-- FIX aplicado: lat/lng. Grava na MESMA coluna que o app-entregador.html já
-- usa hoje (entregadores.lat/lng), não numa coluna paralela — o rastreio de
-- posição do entregador continua único, compartilhado entre os dois domínios.
create or replace function atualizar_localizacao_entregador(
  p_entregador_id uuid,
  p_latitude double precision,
  p_longitude double precision
) returns void as $$
begin
  update entregadores
    set lat = p_latitude,
        lng = p_longitude,
        localizacao_atualizada_em = now()
    where id = p_entregador_id;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- 14. LOCK DE CONCORRÊNCIA NA INSERÇÃO DE ROTA
-- ---------------------------------------------------------------------
create or replace function inserir_grupo_em_rota_atomico(
  p_entrega_rota_id uuid,
  p_pedido_grupo_id uuid
) returns jsonb as $$
declare
  v_peso_novo numeric;
  v_peso_atual numeric;
  v_limite numeric;
  v_perfil text;
begin
  perform pg_advisory_xact_lock(hashtext(p_entrega_rota_id::text));

  select tipo_perfil into v_perfil from entrega_rota where id = p_entrega_rota_id;
  select (peso_max_kg - margem_seguranca_kg) into v_limite
    from dispatch_config where tipo_perfil = v_perfil;

  select coalesce(peso_total, 0) into v_peso_novo
    from pedido_grupo_com_peso where pedido_grupo_id = p_pedido_grupo_id;

  select coalesce(sum(pcp.peso_total), 0) into v_peso_atual
    from entrega_rota_grupo erg
    join pedido_grupo_com_peso pcp on pcp.pedido_grupo_id = erg.pedido_grupo_id
    where erg.entrega_rota_id = p_entrega_rota_id;

  if (v_peso_atual + coalesce(v_peso_novo, 0)) > v_limite then
    return jsonb_build_object(
      'sucesso', false, 'motivo', 'peso_excedido',
      'peso_atual', v_peso_atual, 'peso_tentativa', v_peso_novo, 'limite', v_limite
    );
  end if;

  insert into entrega_rota_grupo (entrega_rota_id, pedido_grupo_id)
  values (p_entrega_rota_id, p_pedido_grupo_id)
  on conflict (pedido_grupo_id) do nothing;

  return jsonb_build_object('sucesso', true);
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- 14.1 PROPOSTA DE CONSOLIDAÇÃO EM ROTA JÁ ACEITA (achado real, 22/08/2026)
-- Antes, consolidar um pedido novo numa rota que o entregador já tinha
-- ACEITO (status='em_rota') era feito direto (inserir_grupo_em_rota_atomico
-- + reescrita de rota_parada), sem o entregador poder recusar — ele só
-- descobria a parada nova já commitada. Corrigido: consolidação numa rota
-- 'em_montagem' (ainda não aceita) continua direta, sem mudança — o
-- entregador vê o lote inteiro numa única oferta antes de aceitar, como
-- sempre foi. Só consolidação numa rota JÁ 'em_rota' passa por aqui.
-- Peso/paradas da rota só refletem o pedido depois do aceite (decisão
-- explícita do usuário) — uma proposta pendente não reserva capacidade.
-- ---------------------------------------------------------------------
create table if not exists proposta_consolidacao (
  id uuid primary key default gen_random_uuid(),
  entrega_rota_id uuid references entrega_rota(id) not null,
  pedido_grupo_id uuid references pedido_grupo(id) not null,
  entregador_id uuid references entregadores(id) not null,
  paradas_novas jsonb not null,     -- só as paradas DESSE pedido (coleta(s)+entrega) — usado se for redespachado como rota nova numa recusa
  paradas_resultado jsonb not null, -- sequência completa proposta (pendentes atuais da rota + as novas) — usado no aceite
  peso_grupo numeric(10,3) not null,
  status text not null default 'pendente' check (status in ('pendente','aceita','recusada')),
  criada_em timestamptz default now(),
  respondida_em timestamptz
);

create index if not exists idx_proposta_consolidacao_entregador on proposta_consolidacao(entregador_id, status);

create or replace function aceitar_proposta_consolidacao(p_proposta_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_proposta record;
  v_resultado jsonb;
begin
  select * into v_proposta from proposta_consolidacao where id = p_proposta_id for update;

  if v_proposta is null then
    raise exception 'proposta não encontrada' using errcode = '02000';
  end if;
  if v_proposta.entregador_id <> (select meu_entregador_id_feira()) then
    raise exception 'proposta não pertence a este entregador' using errcode = '42501';
  end if;
  if v_proposta.status <> 'pendente' then
    raise exception 'proposta já respondida' using errcode = '22023';
  end if;

  -- recheca peso na hora do aceite (não só na hora da proposta) — outra
  -- consolidação pode ter ocupado espaço nesse meio-tempo; mesmo lock
  -- advisory já usado em qualquer inserção nessa rota.
  v_resultado := inserir_grupo_em_rota_atomico(v_proposta.entrega_rota_id, v_proposta.pedido_grupo_id);

  if not (v_resultado->>'sucesso')::boolean then
    update proposta_consolidacao set status = 'recusada', respondida_em = now() where id = p_proposta_id;
    return v_resultado;
  end if;

  delete from rota_parada
    where entrega_rota_id = v_proposta.entrega_rota_id and status = 'pendente';

  insert into rota_parada (entrega_rota_id, tipo, pedido_id, pedido_grupo_id, latitude, longitude, ordem, status)
  select
    v_proposta.entrega_rota_id,
    (p->>'tipo')::text,
    nullif(p->>'pedidoId','')::uuid,
    nullif(p->>'pedidoGrupoId','')::uuid,
    (p->>'latitude')::double precision,
    (p->>'longitude')::double precision,
    (ordinalidade - 1)::int,
    'pendente'
  from jsonb_array_elements(v_proposta.paradas_resultado) with ordinality as t(p, ordinalidade);

  update proposta_consolidacao set status = 'aceita', respondida_em = now() where id = p_proposta_id;
  return jsonb_build_object('sucesso', true);
end;
$$;

create or replace function recusar_proposta_consolidacao(p_proposta_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_proposta record;
  v_primeira_coleta jsonb;
  v_lat double precision;
  v_lng double precision;
  v_novo_entregador_id uuid;
  v_nova_rota_id uuid;
begin
  select * into v_proposta from proposta_consolidacao where id = p_proposta_id for update;

  if v_proposta is null then
    raise exception 'proposta não encontrada' using errcode = '02000';
  end if;
  if v_proposta.entregador_id <> (select meu_entregador_id_feira()) then
    raise exception 'proposta não pertence a este entregador' using errcode = '42501';
  end if;
  if v_proposta.status <> 'pendente' then
    raise exception 'proposta já respondida' using errcode = '22023';
  end if;

  update proposta_consolidacao set status = 'recusada', respondida_em = now() where id = p_proposta_id;

  -- redespacho: mesmo princípio de redespachar_apos_recusa_feira() (recusa
  -- de rota nova), só que aqui o pedido recusado como CONSOLIDAÇÃO vira
  -- uma rota NOVA (em_montagem) pro próximo entregador disponível dentro
  -- do raio — passa a ser uma oferta normal pra ele, com aceite/recusa
  -- de novo. Se ninguém estiver no raio, o pedido fica sem rota (mesmo
  -- fallback: retorna null, sem forçar).
  select p into v_primeira_coleta
  from jsonb_array_elements(v_proposta.paradas_novas) as p
  where p->>'tipo' = 'coleta'
  limit 1;

  if v_primeira_coleta is null then
    return null;
  end if;

  v_lat := (v_primeira_coleta->>'latitude')::double precision;
  v_lng := (v_primeira_coleta->>'longitude')::double precision;

  select e.id into v_novo_entregador_id
  from entregadores e
  join veiculo_config vc on vc.tipo_veiculo = e.tipo_veiculo
  where e.status = 'disponivel'
    and e.aceita_feira = true
    and e.id <> v_proposta.entregador_id
    and calcular_distancia_km(e.lat, e.lng, v_lat, v_lng) <= vc.raio_coleta_km
  order by point(e.lng, e.lat) <-> point(v_lng, v_lat)
  limit 1;

  if v_novo_entregador_id is null then
    return null;
  end if;

  insert into entrega_rota (entregador_id, tipo_perfil, status)
  values (v_novo_entregador_id, 'feira', 'em_montagem')
  returning id into v_nova_rota_id;

  insert into entrega_rota_grupo (entrega_rota_id, pedido_grupo_id)
  values (v_nova_rota_id, v_proposta.pedido_grupo_id);

  insert into rota_parada (entrega_rota_id, tipo, pedido_id, pedido_grupo_id, latitude, longitude, ordem, status)
  select
    v_nova_rota_id,
    (p->>'tipo')::text,
    nullif(p->>'pedidoId','')::uuid,
    nullif(p->>'pedidoGrupoId','')::uuid,
    (p->>'latitude')::double precision,
    (p->>'longitude')::double precision,
    (ordinalidade - 1)::int,
    'pendente'
  from jsonb_array_elements(v_proposta.paradas_novas) with ordinality as t(p, ordinalidade);

  return v_novo_entregador_id;
end;
$$;

create or replace function aceitar_rota(
  p_entrega_rota_id uuid,
  p_distancia_ate_feira_km numeric default null,
  p_bonus_deslocamento numeric default null
)
returns void as $$
declare
  v_entregador_id uuid;
begin
  update entrega_rota
    set aceita_em = now(),
        status = 'em_rota',
        distancia_ate_feira_km = p_distancia_ate_feira_km,
        bonus_deslocamento = p_bonus_deslocamento
    where id = p_entrega_rota_id and status = 'em_montagem'
    returning entregador_id into v_entregador_id;

  -- FIX (achado real, 22/08/2026): sem isso, entregadores.status nunca
  -- saía de 'disponivel' durante uma rota de feira em andamento — o
  -- despacho de um pedido novo (buscar_entregador_mais_proximo, que
  -- filtra status='disponivel') podia escolher o MESMO entregador já
  -- ocupado e abrir uma 2ª rota solta, em vez de consolidar na rota
  -- existente. Guard "<> 'pausado'" no mesmo padrão de
  -- concluir_rota_ao_entregar (restaurante): não sobrescreve uma pausa
  -- explícita que tenha acontecido nesse meio-tempo.
  if v_entregador_id is not null then
    update entregadores set status = 'em_rota' where id = v_entregador_id and status <> 'pausado';
  end if;
end;
$$ language plpgsql;

create or replace function registrar_chegada_parada(p_parada_id uuid)
returns void as $$
begin
  update rota_parada set chegou_em = now() where id = p_parada_id and chegou_em is null;
end;
$$ language plpgsql;

create or replace function calcular_piso_regulatorio(p_distancia_total_km numeric)
returns numeric as $$
declare
  cfg record;
  excedente numeric;
begin
  select * into cfg from piso_regulatorio_config where id = 1;
  excedente := greatest(p_distancia_total_km - cfg.km_base, 0);
  return cfg.valor_base + (excedente * cfg.valor_km_adicional);
end;
$$ language plpgsql stable;

create or replace function escolher_canal_notificacao(p_consumidor_id uuid, p_evento text)
returns text as $$
declare
  v_tem_push boolean;
  v_tem_audio boolean;
begin
  select push_token is not null into v_tem_push from usuarios where id = p_consumidor_id;
  select exists(select 1 from notificacao_audio where evento = p_evento) into v_tem_audio;

  if v_tem_push and v_tem_audio then
    return 'push_voz';
  end if;
  return 'whatsapp';
end;
$$ language plpgsql;

-- FIX aplicado: lat/lng. Versão final (migration 009 substituiu a de 008 —
-- adiciona escolha de canal push_voz/whatsapp).
create or replace function verificar_proximidade_entregas(p_entregador_id uuid)
returns table(pedido_grupo_id uuid, distancia_km numeric) as $$
declare
  v_entregador record;
  v_cfg record;
  v_parada record;
  v_dist numeric;
  v_consumidor_id uuid;
  v_canal text;
begin
  select lat as latitude, lng as longitude into v_entregador from entregadores where id = p_entregador_id;
  select * into v_cfg from notificacao_proximidade_config where id = 1;

  for v_parada in
    select rp.id, rp.latitude, rp.longitude, rp.pedido_grupo_id
    from rota_parada rp
    join entrega_rota er on er.id = rp.entrega_rota_id
    where er.entregador_id = p_entregador_id
      and er.status = 'em_rota'
      and rp.tipo = 'entrega'
      and rp.status = 'pendente'
      and rp.notificado_proximidade = false
      and rp.notificado_a_caminho = true
  loop
    v_dist := calcular_distancia_km(v_entregador.latitude, v_entregador.longitude, v_parada.latitude, v_parada.longitude);

    if v_dist <= v_cfg.distancia_aviso_km then
      update rota_parada set notificado_proximidade = true where id = v_parada.id;

      select consumidor_id into v_consumidor_id from pedido_grupo where id = v_parada.pedido_grupo_id;
      v_canal := escolher_canal_notificacao(v_consumidor_id, 'proximidade_chegada');

      insert into notificacao (destinatario_tipo, destinatario_id, evento, canal, payload)
      values ('consumidor', v_consumidor_id, 'proximidade_chegada', v_canal,
        jsonb_build_object('pedido_grupo_id', v_parada.pedido_grupo_id, 'distancia_km', v_dist));

      pedido_grupo_id := v_parada.pedido_grupo_id;
      distancia_km := v_dist;
      return next;
    end if;
  end loop;
end;
$$ language plpgsql;

create or replace function expirar_pedidos_pendentes()
returns table(pedido_grupo_id uuid, pedidos_expirados int, pedidos_confirmados int) as $$
declare
  grupo record;
  qtd_expirados int;
  qtd_confirmados int;
begin
  for grupo in
    select pg.id from pedido_grupo pg
    where pg.status = 'aguardando_pagamentos'
      and pg.expira_em < now()
  loop
    update pedido
      set status_pagamento_final = 'expirado'
      where pedido.pedido_grupo_id = grupo.id
        and status_pagamento = 'pendente';

    select count(*) into qtd_expirados
      from pedido where pedido.pedido_grupo_id = grupo.id and status_pagamento_final = 'expirado';
    select count(*) into qtd_confirmados
      from pedido where pedido.pedido_grupo_id = grupo.id and status_pagamento = 'confirmado';

    if qtd_confirmados = 0 then
      update pedido_grupo set status = 'cancelado', updated_at = now() where id = grupo.id;
    else
      update pedido_grupo set status = 'pronto_para_coleta', updated_at = now() where id = grupo.id;
    end if;

    pedido_grupo_id := grupo.id;
    pedidos_expirados := qtd_expirados;
    pedidos_confirmados := qtd_confirmados;
    return next;
  end loop;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- 15. TRIGGERS
-- ---------------------------------------------------------------------
create or replace function checar_peso_rota()
returns trigger as $$
declare
  peso_novo numeric;
  peso_atual numeric;
  limite numeric;
  perfil text;
begin
  select tipo_perfil into perfil from entrega_rota where id = new.entrega_rota_id;
  select peso_max_kg into limite from dispatch_config where tipo_perfil = perfil;

  select peso_total into peso_novo
  from pedido_grupo_com_peso where pedido_grupo_id = new.pedido_grupo_id;

  select coalesce(sum(pcp.peso_total), 0) into peso_atual
  from entrega_rota_grupo erg
  join pedido_grupo_com_peso pcp on pcp.pedido_grupo_id = erg.pedido_grupo_id
  where erg.entrega_rota_id = new.entrega_rota_id;

  if (peso_atual + coalesce(peso_novo,0)) > limite then
    raise exception 'Peso excede %kg permitido nesta rota (atual: %kg, tentando somar: %kg)',
      limite, peso_atual, peso_novo;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_checar_peso_rota on entrega_rota_grupo;
create trigger trg_checar_peso_rota
before insert on entrega_rota_grupo
for each row execute function checar_peso_rota();

create or replace function atualizar_peso_total_rota()
returns trigger as $$
declare
  rota_id uuid;
  novo_total numeric;
begin
  rota_id := coalesce(new.entrega_rota_id, old.entrega_rota_id);

  select coalesce(sum(pcp.peso_total), 0) into novo_total
  from entrega_rota_grupo erg
  join pedido_grupo_com_peso pcp on pcp.pedido_grupo_id = erg.pedido_grupo_id
  where erg.entrega_rota_id = rota_id;

  update entrega_rota set peso_total = novo_total where id = rota_id;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_atualizar_peso_total_rota on entrega_rota_grupo;
create trigger trg_atualizar_peso_total_rota
after insert or delete on entrega_rota_grupo
for each row execute function atualizar_peso_total_rota();

-- item 41 (25/08/2026): achado ao vivo, testando o painel-feirante.html
-- pela primeira vez — "Marcar como pronto" quebrava com "new row violates
-- row-level security policy for table 'pedido_nota'". Essa função roda
-- DENTRO da transação de UPDATE que o feirante dispara (trigger BEFORE em
-- pedido), então sem SECURITY DEFINER ela herda a RLS do próprio
-- feirante — e pedido_nota não tem NENHUMA policy de INSERT pra ninguém
-- (só "feirante ve nota dos seus pedidos", SELECT). Mesmo padrão de fix já
-- aplicado várias vezes nesta sessão pra RPCs (aprovar_entregador_teste(),
-- enfileirar_notificacao_restaurante()), agora numa trigger function.
create or replace function gerar_nota_pedido()
returns trigger as $$
declare
  cliente_nome text;
  qtd int;
  peso numeric;
  codigo text;
  tentativas int := 0;
begin
  if new.status_coleta = 'finalizado' and old.status_coleta is distinct from 'finalizado' then
    select u.nome into cliente_nome
    from pedido_grupo pg join usuarios u on u.id = pg.consumidor_id
    where pg.id = new.pedido_grupo_id;

    select count(*), coalesce(sum(peso_subtotal),0) into qtd, peso
    from pedido_item where pedido_id = new.id;

    loop
      codigo := upper(substr(md5(random()::text || new.id::text || tentativas::text), 1, 4));
      tentativas := tentativas + 1;

      exit when not exists (
        select 1 from pedido_nota pn
        join pedido p2 on p2.id = pn.pedido_id
        where pn.codigo_curto = codigo
          and p2.estabelecimento_id = new.estabelecimento_id
          and p2.status_coleta != 'coletado'
      ) or tentativas > 10;
    end loop;

    insert into pedido_nota (pedido_id, codigo_curto, nome_cliente, qtd_itens, peso_total)
    values (new.id, codigo, cliente_nome, qtd, peso)
    on conflict (pedido_id) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_gerar_nota on pedido;
create trigger trg_gerar_nota
before update on pedido
for each row execute function gerar_nota_pedido();

create or replace function checar_liberacao_grupo()
returns trigger as $$
declare
  pendentes int;
begin
  if new.status_pagamento = 'confirmado' and old.status_pagamento is distinct from 'confirmado' then
    select count(*) into pendentes
    from pedido
    where pedido_grupo_id = new.pedido_grupo_id
      and status_pagamento != 'confirmado';

    if pendentes = 0 then
      update pedido_grupo set status = 'pronto_para_coleta', updated_at = now()
      where id = new.pedido_grupo_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_checar_liberacao_grupo on pedido;
create trigger trg_checar_liberacao_grupo
after update on pedido
for each row execute function checar_liberacao_grupo();

create or replace function registrar_confirmacao_pagamento()
returns trigger as $$
begin
  if new.status_pagamento = 'confirmado' and old.status_pagamento is distinct from 'confirmado' then
    new.confirmado_em := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_registrar_confirmacao on pedido;
create trigger trg_registrar_confirmacao
before update on pedido
for each row execute function registrar_confirmacao_pagamento();

create or replace function notificar_novo_pedido()
returns trigger as $$
begin
  insert into notificacao (destinatario_tipo, destinatario_id, evento, payload)
  values ('feirante', new.estabelecimento_id, 'pedido_novo',
    jsonb_build_object('pedido_id', new.id, 'pedido_grupo_id', new.pedido_grupo_id));
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_notificar_novo_pedido on pedido;
create trigger trg_notificar_novo_pedido
after insert on pedido
for each row execute function notificar_novo_pedido();

create or replace function notificar_grupo_pronto()
returns trigger as $$
begin
  if new.status = 'pronto_para_coleta' and old.status is distinct from 'pronto_para_coleta' then
    insert into notificacao (destinatario_tipo, destinatario_id, evento, payload)
    values ('consumidor', new.consumidor_id, 'pronto_coleta',
      jsonb_build_object('pedido_grupo_id', new.id));
  elsif new.status = 'cancelado' and old.status is distinct from 'cancelado' then
    insert into notificacao (destinatario_tipo, destinatario_id, evento, payload)
    values ('consumidor', new.consumidor_id, 'grupo_cancelado',
      jsonb_build_object('pedido_grupo_id', new.id));
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_notificar_grupo_pronto on pedido_grupo;
create trigger trg_notificar_grupo_pronto
after update on pedido_grupo
for each row execute function notificar_grupo_pronto();

create or replace function checar_valor_minimo()
returns trigger as $$
declare
  total numeric;
  minimo numeric;
begin
  select coalesce(sum(pcp.valor_total), 0) into total
  from pedido_com_peso pcp where pcp.pedido_grupo_id = new.pedido_grupo_id;

  select f.valor_minimo_pedido into minimo
  from pedido_grupo pg
  join feira_ocorrencia fo on fo.id = pg.feira_ocorrencia_id
  join feira f on f.id = fo.feira_id
  where pg.id = new.pedido_grupo_id;

  if total < minimo then
    raise exception 'Pedido abaixo do valor mínimo desta feira (mínimo: R$%, atual: R$%)', minimo, total;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function finalizar_rota_se_completa()
returns trigger as $$
declare
  pendentes int;
  v_entregador_id uuid;
begin
  if new.status = 'concluida' and old.status is distinct from 'concluida' then
    select count(*) into pendentes
      from rota_parada
      where entrega_rota_id = new.entrega_rota_id and status = 'pendente';

    if pendentes = 0 then
      update entrega_rota
        set status = 'finalizada', fechada_em = now()
        where id = new.entrega_rota_id
        returning entregador_id into v_entregador_id;

      -- FIX (achado real, 22/08/2026): espelha concluir_rota_ao_entregar do
      -- restaurante — libera o entregador (status='disponivel') quando a
      -- rota de feira fecha de verdade (última parada concluída), sem
      -- sobrescrever uma pausa explícita feita nesse meio-tempo.
      if v_entregador_id is not null then
        update entregadores set status = 'disponivel' where id = v_entregador_id and status <> 'pausado';
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_finalizar_rota_se_completa on rota_parada;
create trigger trg_finalizar_rota_se_completa
after update on rota_parada
for each row execute function finalizar_rota_se_completa();

-- versão final (migration 007 substituiu a de 005 — inclui valor_tempo_espera no ganho total)
create or replace function registrar_metrica_rota()
returns trigger as $$
declare
  v_qtd_grupos int;
  v_qtd_bancas int;
  v_trecho_a_pe numeric;
  v_trecho_entrega numeric;
  v_taxa_total numeric;
  v_primeira_coleta timestamptz;
  v_ultima_entrega timestamptz;
  v_tempo_seg int;
  v_remuneracao numeric;
  v_ganho_total numeric;
begin
  if new.status = 'finalizada' and old.status is distinct from 'finalizada' then

    select count(*), coalesce(sum(pg.qtd_bancas),0), coalesce(sum(pg.trecho_a_pe_km),0),
           coalesce(sum(pg.trecho_ate_entrega_km),0), coalesce(sum(pg.taxa_entrega),0)
      into v_qtd_grupos, v_qtd_bancas, v_trecho_a_pe, v_trecho_entrega, v_taxa_total
    from entrega_rota_grupo erg
    join pedido_grupo pg on pg.id = erg.pedido_grupo_id
    where erg.entrega_rota_id = new.id;

    select min(concluida_em) into v_primeira_coleta
      from rota_parada where entrega_rota_id = new.id and tipo = 'coleta';
    select max(concluida_em) into v_ultima_entrega
      from rota_parada where entrega_rota_id = new.id and tipo = 'entrega';

    v_ganho_total := v_taxa_total + coalesce(new.bonus_deslocamento, 0) + coalesce(new.valor_tempo_espera, 0);

    if new.aceita_em is not null and v_ultima_entrega is not null then
      v_tempo_seg := extract(epoch from (v_ultima_entrega - new.aceita_em));
      if v_tempo_seg > 0 then
        v_remuneracao := round((v_ganho_total / (v_tempo_seg / 3600.0))::numeric, 2);
      end if;
    end if;

    insert into entrega_metrica (
      entrega_rota_id, entregador_id, tipo_perfil, qtd_grupos, qtd_bancas_total,
      peso_total_kg, trecho_a_pe_km_total, trecho_ate_entrega_km_total,
      taxa_cobrada_total, aceita_em, primeira_coleta_em, ultima_entrega_em,
      tempo_total_seg, remuneracao_por_hora
    ) values (
      new.id, new.entregador_id, new.tipo_perfil, v_qtd_grupos, v_qtd_bancas,
      new.peso_total, v_trecho_a_pe, v_trecho_entrega,
      v_ganho_total, new.aceita_em, v_primeira_coleta, v_ultima_entrega,
      v_tempo_seg, v_remuneracao
    )
    on conflict (entrega_rota_id) do nothing;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_registrar_metrica_rota on entrega_rota;
create trigger trg_registrar_metrica_rota
after update on entrega_rota
for each row execute function registrar_metrica_rota();

create or replace function acumular_tempo_espera()
returns trigger as $$
declare
  v_espera_seg int;
  v_valor_min numeric;
begin
  if new.status = 'concluida' and old.status is distinct from 'concluida'
     and new.chegou_em is not null then

    v_espera_seg := extract(epoch from (new.concluida_em - new.chegou_em));
    if v_espera_seg > 0 then
      select valor_minuto_espera into v_valor_min from piso_regulatorio_config where id = 1;

      update entrega_rota
        set tempo_espera_total_seg = coalesce(tempo_espera_total_seg, 0) + v_espera_seg,
            valor_tempo_espera = coalesce(valor_tempo_espera, 0) + round((v_espera_seg / 60.0) * v_valor_min, 2)
        where id = new.entrega_rota_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_acumular_tempo_espera on rota_parada;
create trigger trg_acumular_tempo_espera
after update on rota_parada
for each row execute function acumular_tempo_espera();

create or replace function flagar_divergencia_geolocalizacao()
returns trigger as $$
begin
  if new.divergencia_m is not null and new.divergencia_m > 150
     and (old.divergencia_m is null or old.divergencia_m <= 150) then
    insert into entregador_flag_revisao (entregador_id, motivo, detalhe)
    select er.entregador_id, 'divergencia_geolocalizacao',
           jsonb_build_object('rota_parada_id', new.id, 'divergencia_m', new.divergencia_m)
    from entrega_rota er where er.id = new.entrega_rota_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_flagar_divergencia on rota_parada;
create trigger trg_flagar_divergencia
after update on rota_parada
for each row execute function flagar_divergencia_geolocalizacao();

create or replace function verificar_saiu_para_entrega()
returns trigger as $$
declare
  v_pedido_grupo_id uuid;
  v_pendentes int;
  v_entrega_parada_id uuid;
  v_consumidor_id uuid;
begin
  if new.tipo = 'coleta' and new.status = 'concluida' and old.status is distinct from 'concluida' then
    select p.pedido_grupo_id into v_pedido_grupo_id from pedido p where p.id = new.pedido_id;

    select count(*) into v_pendentes
      from rota_parada rp
      join pedido p on p.id = rp.pedido_id
      where rp.entrega_rota_id = new.entrega_rota_id
        and rp.tipo = 'coleta'
        and p.pedido_grupo_id = v_pedido_grupo_id
        and rp.status != 'concluida';

    if v_pendentes = 0 then
      select id into v_entrega_parada_id
        from rota_parada
        where entrega_rota_id = new.entrega_rota_id
          and tipo = 'entrega'
          and pedido_grupo_id = v_pedido_grupo_id
        limit 1;

      if v_entrega_parada_id is not null then
        update rota_parada set notificado_a_caminho = true
          where id = v_entrega_parada_id and notificado_a_caminho = false;

        if found then
          select consumidor_id into v_consumidor_id from pedido_grupo where id = v_pedido_grupo_id;
          insert into notificacao (destinatario_tipo, destinatario_id, evento, payload)
          values ('consumidor', v_consumidor_id, 'saiu_entrega',
            jsonb_build_object('pedido_grupo_id', v_pedido_grupo_id));
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_verificar_saiu_para_entrega on rota_parada;
create trigger trg_verificar_saiu_para_entrega
after update on rota_parada
for each row execute function verificar_saiu_para_entrega();

-- ---------------------------------------------------------------------
-- 16. ÍNDICES
-- ---------------------------------------------------------------------
create index if not exists idx_pedido_grupo_status on pedido_grupo(status);
create index if not exists idx_pedido_grupo_expira on pedido_grupo(expira_em) where status = 'aguardando_pagamentos';
create index if not exists idx_pedido_pedido_grupo on pedido(pedido_grupo_id);
create index if not exists idx_pedido_status_coleta on pedido(status_coleta);
create index if not exists idx_rota_parada_rota on rota_parada(entrega_rota_id, ordem);
create index if not exists idx_rota_parada_notificacao on rota_parada(entrega_rota_id, tipo, status) where tipo = 'entrega';
create index if not exists idx_entrega_rota_status on entrega_rota(status, entregador_id);
create index if not exists idx_feirante_participacao_ocorrencia on feirante_participacao(feira_ocorrencia_id);
create index if not exists idx_avaliacao_avaliado on avaliacao(avaliado_tipo, avaliado_id);
create index if not exists idx_flag_revisao_pendente on entregador_flag_revisao(status) where status = 'aguardando_revisao';
create index if not exists idx_entrega_metrica_perfil on entrega_metrica(tipo_perfil);
create index if not exists idx_notificacao_pendente on notificacao(status) where status = 'pendente';

-- ---------------------------------------------------------------------
-- 17. RLS — não veio nenhuma no módulo original, escrita do zero.
-- Funções SECURITY DEFINER pra qualquer lookup de identidade, mesmo
-- padrão de minhas_tenant_ids() — evita repetir subselect cru em toda
-- policy e mantém o mesmo ponto único de manutenção.
-- ---------------------------------------------------------------------
create or replace function meu_estabelecimento_id()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id from estabelecimentos where auth_user_id = auth.uid();
$$;

-- item 41 (25/08/2026): achado ao vivo, testando painel-feirante.html —
-- "infinite recursion detected in policy for relation 'pedido'" (código
-- 42P17). Causa: a policy de pedido_grupo abaixo fazia subquery direta em
-- `pedido` — mas `pedido` já tem uma policy própria ("consumidor ve
-- pedidos do seu grupo") que faz subquery em `pedido_grupo` — ciclo
-- fechado entre as duas tabelas assim que a policy nova entrou. Função
-- SECURITY DEFINER quebra o ciclo (roda com bypass de RLS por dentro,
-- mesmo motivo de meu_estabelecimento_id() acima não recursar ao
-- consultar estabelecimentos).
create or replace function pedido_grupos_do_meu_estabelecimento()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select pedido_grupo_id from pedido where estabelecimento_id in (select meu_estabelecimento_id());
$$;

create or replace function meu_usuario_id()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id from usuarios where auth_user_id = auth.uid();
$$;

create or replace function meu_entregador_id_feira()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id from entregadores where auth_user_id = auth.uid();
$$;

alter table estabelecimentos enable row level security;
alter table usuarios enable row level security;
alter table produtos enable row level security;
alter table feira enable row level security;
alter table feira_ocorrencia enable row level security;
alter table feira_ocorrencia_excecao enable row level security;
alter table feirante_participacao enable row level security;
alter table feirante_excecoes enable row level security;
alter table pedido_grupo enable row level security;
alter table pedido enable row level security;
alter table pedido_item enable row level security;
alter table pedido_nota enable row level security;
alter table dispatch_config enable row level security;
alter table entrega_rota enable row level security;
alter table entrega_rota_grupo enable row level security;
alter table proposta_consolidacao enable row level security;
alter table rota_parada enable row level security;
alter table entrega_metrica enable row level security;
alter table veiculo_config enable row level security;
alter table veiculo_raio_entrega enable row level security;
alter table piso_regulatorio_config enable row level security;
alter table oferta_recusada enable row level security;
alter table entregador_flag_revisao enable row level security;
alter table notificacao enable row level security;
alter table notificacao_restaurante enable row level security;
alter table notificacao_proximidade_config enable row level security;
alter table notificacao_audio enable row level security;
alter table avaliacao enable row level security;

-- feira/feira_ocorrencia/dispatch_config/veiculo_config/veiculo_raio_entrega/
-- piso_regulatorio_config/notificacao_audio/notificacao_proximidade_config:
-- config compartilhada, sem PII — leitura pública pra qualquer autenticado
-- (mesmo padrão de "qualquer um le horario de funcionamento"), escrita só
-- via service role (nenhuma policy de insert/update/delete)
create policy "autenticado le feiras" on feira for select using (auth.uid() is not null);
create policy "autenticado le ocorrencias de feira" on feira_ocorrencia for select using (auth.uid() is not null);
create policy "autenticado le dispatch config" on dispatch_config for select using (auth.uid() is not null);
create policy "autenticado le veiculo config" on veiculo_config for select using (auth.uid() is not null);
create policy "autenticado le veiculo raio entrega" on veiculo_raio_entrega for select using (auth.uid() is not null);
create policy "autenticado le piso regulatorio" on piso_regulatorio_config for select using (auth.uid() is not null);
create policy "autenticado le notificacao audio" on notificacao_audio for select using (auth.uid() is not null);

-- estabelecimentos: feirante vê/edita o próprio; entregador vê os das
-- próprias coletas (join até entrega_rota via entregadores, sem ciclo —
-- estabelecimentos não tem policy nenhuma que subselect de volta em rota_parada/pedido)
create policy "feirante ve e edita seu estabelecimento" on estabelecimentos for all using (
  auth_user_id = auth.uid());
create policy "autenticado cria seu proprio estabelecimento" on estabelecimentos for insert with check (
  auth_user_id = auth.uid());
create policy "entregador ve estabelecimentos das suas coletas" on estabelecimentos for select using (
  id in (
    select p.estabelecimento_id from pedido p
    join rota_parada rp on rp.pedido_id = p.id
    join entrega_rota er on er.id = rp.entrega_rota_id
    where er.entregador_id in (select meu_entregador_id_feira())
  ));

-- produtos: feirante gerencia os do seu estabelecimento; leitura pública
-- (necessária pro checkout do consumidor, mesmo antes de ele existir)
create policy "qualquer um le produtos ativos" on produtos for select using (ativo = true);
create policy "feirante gerencia produtos do seu estabelecimento" on produtos for all using (
  estabelecimento_id in (select meu_estabelecimento_id()));

-- usuarios: consumidor vê/edita o próprio
create policy "usuario ve e edita seu proprio perfil" on usuarios for all using (
  auth_user_id = auth.uid());
create policy "autenticado cria seu proprio perfil de usuario" on usuarios for insert with check (
  auth_user_id = auth.uid());
-- item 41 (25/08/2026): mesmo achado da policy de pedido_grupo acima —
-- feirante precisa ver nome/telefone do cliente dos PRÓPRIOS pedidos (pra
-- separar o pedido certo, e falar com o cliente se precisar, ver
-- clarificação do usuário: "cliente paga direto pro feirante via
-- WhatsApp"). Sem policy nenhuma antes, o join sempre voltava null.
create policy "feirante ve cliente dos seus pedidos" on usuarios for select using (
  id in (select consumidor_id from pedido_grupo where id in (select pedido_grupos_do_meu_estabelecimento())));

-- feirante_participacao / feirante_excecoes: feirante gerencia a própria
create policy "feirante gerencia sua participacao" on feirante_participacao for all using (
  estabelecimento_id in (select meu_estabelecimento_id()));
create policy "feirante gerencia suas excecoes" on feirante_excecoes for all using (
  estabelecimento_id in (select meu_estabelecimento_id()));

-- pedido_grupo: consumidor vê/cria o próprio; entregador vê o da rota dele
create policy "consumidor ve seus pedidos grupo" on pedido_grupo for select using (
  consumidor_id in (select meu_usuario_id()));
create policy "consumidor cria seu pedido grupo" on pedido_grupo for insert with check (
  consumidor_id in (select meu_usuario_id()));
create policy "entregador ve pedido grupo da sua rota" on pedido_grupo for select using (
  entregador_id in (select meu_entregador_id_feira()));
-- item 41 (25/08/2026): achado ao vivo, testando painel-feirante.html —
-- faltava o feirante conseguir ver o pedido_grupo (endereço/nome do
-- cliente) dos PRÓPRIOS pedidos. Sem isso o join pedido->pedido_grupo
-- sempre voltava null pro feirante, mesmo o pedido sendo dele.
create policy "feirante ve pedido grupo dos seus pedidos" on pedido_grupo for select using (
  id in (select pedido_grupos_do_meu_estabelecimento()));

-- pedido: feirante vê/atualiza os do seu estabelecimento (confirma pagamento,
-- finaliza separação); consumidor vê os do próprio grupo; entregador vê os
-- das paradas da própria rota
create policy "feirante ve e atualiza seus pedidos" on pedido for all using (
  estabelecimento_id in (select meu_estabelecimento_id()));
create policy "consumidor ve pedidos do seu grupo" on pedido for select using (
  pedido_grupo_id in (select id from pedido_grupo where consumidor_id in (select meu_usuario_id())));
create policy "entregador ve pedidos da sua rota" on pedido for select using (
  id in (
    select rp.pedido_id from rota_parada rp
    join entrega_rota er on er.id = rp.entrega_rota_id
    where er.entregador_id in (select meu_entregador_id_feira())
  ));

-- pedido_item: segue a visibilidade do pedido pai
create policy "quem ve o pedido ve os itens" on pedido_item for select using (
  pedido_id in (
    select id from pedido where
      estabelecimento_id in (select meu_estabelecimento_id())
      or pedido_grupo_id in (select id from pedido_grupo where consumidor_id in (select meu_usuario_id()))
  ));
create policy "consumidor cria itens do proprio pedido" on pedido_item for insert with check (
  pedido_id in (
    select p.id from pedido p join pedido_grupo pg on pg.id = p.pedido_grupo_id
    where pg.consumidor_id in (select meu_usuario_id())
  ));

-- pedido_nota: feirante (gerou) e entregador (confere na coleta) veem
create policy "feirante ve nota dos seus pedidos" on pedido_nota for select using (
  pedido_id in (select id from pedido where estabelecimento_id in (select meu_estabelecimento_id())));
create policy "entregador ve nota das suas coletas" on pedido_nota for select using (
  pedido_id in (
    select rp.pedido_id from rota_parada rp
    join entrega_rota er on er.id = rp.entrega_rota_id
    where er.entregador_id in (select meu_entregador_id_feira())
  ));

-- entrega_rota / entrega_rota_grupo / rota_parada: só o próprio entregador
create policy "entregador ve e atualiza sua rota" on entrega_rota for all using (
  entregador_id in (select meu_entregador_id_feira()));
create policy "entregador ve grupos da sua rota" on entrega_rota_grupo for select using (
  entrega_rota_id in (select id from entrega_rota where entregador_id in (select meu_entregador_id_feira())));
-- só SELECT/UPDATE (status pendente->aceita/recusada) pro entregador — o
-- INSERT da proposta em si só acontece via routeManager.js (service role);
-- o "for all" aqui cobre o que o entregador de fato precisa fazer (ler e
-- responder), sem abrir insert direto pra ele.
create policy "entregador ve e responde suas propostas de consolidacao" on proposta_consolidacao for all using (
  entregador_id in (select meu_entregador_id_feira()));
create policy "entregador ve e atualiza paradas da sua rota" on rota_parada for all using (
  entrega_rota_id in (select id from entrega_rota where entregador_id in (select meu_entregador_id_feira())));

-- entrega_metrica / extrato: só o próprio entregador
create policy "entregador ve suas proprias metricas" on entrega_metrica for select using (
  entregador_id in (select meu_entregador_id_feira()));

-- oferta_recusada / entregador_flag_revisao: sem SELECT pra ninguém além do
-- service role — dados sensíveis de análise agregada / revisão humana, não
-- expostos a app cliente nenhum (mesmo padrão de desenvolvedores_admin).
-- Achado (rewrite de app-entregador.html, 22/08/2026): faltava INSERT pro
-- próprio entregador registrar a recusa (botão "Recusar" da oferta de
-- feira) — sem policy nenhuma, RLS bloqueava de cara. Write-only de
-- propósito: ele registra a recusa, mas não lê o histórico de volta (seria
-- a mesma classe de dado sensível de análise agregada).
create policy "entregador registra sua propria recusa" on oferta_recusada for insert with check (
  entregador_id in (select meu_entregador_id_feira()));

-- ------------------------------------------------------------
-- Failover de feira ao recusar (sessão de 22/08/2026) — achado real,
-- levantado pelo usuário: o módulo original nunca endereçou "o que
-- acontece quando o entregador atribuído recusa" (oferta_recusada era só
-- log de análise agregada, não sinal de redespacho). Mesmo princípio do
-- failover real do restaurante (dispatch-engine): próximo mais próximo
-- dentro do MESMO raio, nunca relaxa, excluindo quem já recusou — mas
-- aqui como RPC síncrona chamada pelo próprio client no momento da
-- recusa, não um processo Node rodando (dispatch-engine/ não existe pra
-- feira ainda). Isso resolve o caminho de RECUSA EXPLÍCITA hoje, sem
-- precisar de nenhum serviço novo — mas não resolve TIMEOUT (entregador
-- que nunca responde): esse caminho segue precisando de um processo vivo
-- checando `now() - aberta_em > timeout`, que não existe ainda (mesma
-- pendência já documentada de "nenhum cron do módulo feira está
-- rodando"). Ver "Pendências reais" no CLAUDE.md — registrado
-- explicitamente pra não virar surpresa quando uma rota ficar "presa" por
-- falta de resposta, sem ninguém ter recusado nada.
--
-- Exclusão reaproveita oferta_recusada (não cria tabela nova) — os dados
-- já são exatamente os necessários (entregador_id, entrega_rota_id). Ler
-- de volta aqui não viola o princípio "nunca pontuar" do PL 2479/25: não
-- estamos avaliando o entregador, só evitando reoferecer a MESMA rota
-- pra quem specifically já disse não a ela.
--
-- SECURITY DEFINER necessário: reatribuir entrega_rota.entregador_id pra
-- OUTRO entregador não passaria pelo WITH CHECK da policy "entregador ve
-- e atualiza sua rota" (o entregador_id resultante não é mais o do
-- chamador). Guard explícito dentro da função: só quem JÁ registrou sua
-- própria recusa pra essa rota específica pode disparar o redespacho —
-- não dá pra um entregador qualquer chamar isso pra sequestrar a rota de
-- outro.
-- ------------------------------------------------------------
create or replace function redespachar_apos_recusa_feira(p_entrega_rota_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lat double precision;
  v_lng double precision;
  v_novo_entregador_id uuid;
begin
  if not exists (
    select 1 from oferta_recusada
    where entrega_rota_id = p_entrega_rota_id
      and entregador_id in (select meu_entregador_id_feira())
  ) then
    raise exception 'só quem recusou esta rota pode disparar o redespacho' using errcode = '42501';
  end if;

  select rp.latitude, rp.longitude into v_lat, v_lng
  from rota_parada rp
  where rp.entrega_rota_id = p_entrega_rota_id and rp.tipo = 'coleta'
  order by rp.ordem asc
  limit 1;

  if v_lat is null then
    return null; -- rota sem parada de coleta — não deveria acontecer
  end if;

  select e.id into v_novo_entregador_id
  from entregadores e
  join veiculo_config vc on vc.tipo_veiculo = e.tipo_veiculo
  where e.status = 'disponivel'
    and e.aceita_feira = true
    and e.id <> (select entregador_id from entrega_rota where id = p_entrega_rota_id)
    and e.id not in (
      select entregador_id from oferta_recusada where entrega_rota_id = p_entrega_rota_id
    )
    and calcular_distancia_km(e.lat, e.lng, v_lat, v_lng) <= vc.raio_coleta_km
  order by point(e.lng, e.lat) <-> point(v_lng, v_lat)
  limit 1;

  if v_novo_entregador_id is not null then
    update entrega_rota
    set entregador_id = v_novo_entregador_id
    where id = p_entrega_rota_id and status = 'em_montagem';
  end if;

  return v_novo_entregador_id;
end;
$$;

-- notificacao: cada destinatário vê só a própria (campo destinatario_id
-- aponta pra usuarios/estabelecimentos/entregadores dependendo do tipo —
-- 3 condições, uma por tipo, nenhum ciclo)
create policy "destinatario ve suas proprias notificacoes" on notificacao for select using (
  (destinatario_tipo = 'consumidor' and destinatario_id in (select meu_usuario_id()))
  or (destinatario_tipo = 'feirante' and destinatario_id in (select meu_estabelecimento_id()))
  or (destinatario_tipo = 'entregador' and destinatario_id in (select meu_entregador_id_feira()))
);

-- notificacao_restaurante: só a loja do pedido em questão (visibilidade/
-- debug — quem escreve é sempre enfileirar_notificacao_restaurante(),
-- SECURITY DEFINER, não RLS de INSERT pra ninguém).
create policy "loja ve notificacoes dos seus pedidos" on notificacao_restaurante for select using (
  pedido_id in (select id from pedidos where tenant_id in
    (select tenant_id from usuarios_loja where auth_user_id = auth.uid()))
);

-- avaliacao: quem avaliou e quem foi avaliado veem; só o autor cria a própria
create policy "avaliador ve suas avaliacoes" on avaliacao for select using (
  (avaliador_tipo = 'consumidor' and avaliador_id in (select meu_usuario_id()))
  or (avaliador_tipo = 'feirante' and avaliador_id in (select meu_estabelecimento_id()))
  or (avaliador_tipo = 'entregador' and avaliador_id in (select meu_entregador_id_feira()))
);
create policy "avaliado ve avaliacoes recebidas" on avaliacao for select using (
  (avaliado_tipo = 'feirante' and avaliado_id in (select meu_estabelecimento_id()))
  or (avaliado_tipo = 'entregador' and avaliado_id in (select meu_entregador_id_feira()))
);
create policy "consumidor cria avaliacao do seu pedido" on avaliacao for insert with check (
  avaliador_tipo = 'consumidor' and avaliador_id in (select meu_usuario_id())
  and pedido_grupo_id in (select id from pedido_grupo where consumidor_id in (select meu_usuario_id()))
);

-- achado (rewrite de app-entregador.html, 22/08/2026): faltava a policy do
-- entregador avaliar o feirante depois da rota (TelaAvaliacao em
-- FeiraApp.jsx) — só existia a do consumidor. Escopada ao próprio
-- pedido_grupo que passou pela rota dele (não dá pra avaliar um grupo
-- qualquer que nunca visitou).
create policy "entregador cria avaliacao da sua rota" on avaliacao for insert with check (
  avaliador_tipo = 'entregador' and avaliador_id in (select meu_entregador_id_feira())
  and pedido_grupo_id in (
    select erg.pedido_grupo_id from entrega_rota_grupo erg
    join entrega_rota er on er.id = erg.entrega_rota_id
    where er.entregador_id in (select meu_entregador_id_feira())
  )
);
