# Cobertura de testes — GiroCerto

Última rodada completa: 90/90 passou, contra o Supabase hospedado real (`ntmxkwzhumiqspxijuln`),
dados de teste limpos ao final (0 tenants/usuários residuais confirmados).

Legenda: ✅ testado nesta suíte (`tests/`) · 🔁 já testado antes desta sessão (script avulso,
não versionado — ver `CLAUDE.md`) · ⏸ pendência documentada (depende de feature inexistente)

## Onboarding e cadastro
| Item | Status | Nota |
|---|---|---|
| Cadastro de loja (id client-side, vínculo dono) | ✅ `onboarding.test.js` | |
| Bloqueio de segundo auto-vínculo no mesmo tenant | ✅ `onboarding.test.js` | já coberto antes (🔁) e reconfirmado |
| Cadastro de entregador — moto | ✅ `onboarding.test.js` | |
| Cadastro de entregador — bicicleta, menor de 18 com responsável | ✅ `onboarding.test.js` | banco não tem CHECK de faixa etária (15–18 = só bicicleta), é só convenção documentada em comentário — não é falha, é limitação real registrada pelo teste |
| Aprovação manual (`aprovado_por`, `aprovado_em`) | ✅ `onboarding.test.js` | loja não tem UPDATE em `entregadores` via RLS (by design, "aprovação passa pelo backend") — só testável via service role |
| Reprovação manual com `motivo_reprovacao` | ✅ `onboarding.test.js` | |
| Reprovação automática por documento vencido | ⏸ | Não existe trigger/função/job que faça isso hoje — confirmado por grep em `db/schema.sql` e nos mockups. Simplesmente não é uma feature implementada, não dá pra testar sem inventá-la. |

## Ciclo de vida do pedido
| Item | Status | Nota |
|---|---|---|
| Todos os valores de `origem` | ✅ `pedido.test.js` | |
| Ciclo `recebido → em_preparo → pronto → a_caminho → entregue` | ✅ `pedido.test.js` | |
| Caminho de `cancelado` | ✅ `pedido.test.js` | |
| `forma_pagamento='pix'`, `pago_antecipado` true/false | ✅ `pedido.test.js` | |
| `valor_troco` (coluna gerada) | ✅ `pedido.test.js` | testado com `troco_para` preenchido e vazio |
| `tentativas_contato` (ligação/mensagem, todos resultados) | ✅ `pedido.test.js` | insert só via service role hoje (não há policy client-side de insert em `tentativas_contato`) |
| `motivo_cancelamento='cliente_nao_localizado'` + `valor_reembolsado` | ✅ `pedido.test.js` | os *campos* aceitam e persistem o valor certo; o *cálculo* de `valor_reembolsado` a partir de `percentual_reembolso_sem_contato` não existe como função/trigger — é responsabilidade de um backend que ainda não existe, então só testamos que o campo guarda o valor passado, não que o sistema calcula sozinho |
| `avaliacao_entrega`/`avaliacao_comentario` via link de rastreio | ⏸ | Link público de rastreio é TODO explícito em `CLAUDE.md` (fora de escopo, decisão consciente) — não há como testar sem inventar a feature |
| `item_retorna_loja` true/false | ✅ `pedido.test.js` | |

## Despacho e rotas
| Item | Status | Nota |
|---|---|---|
| `tentativas_despacho` com os 3 resultados + failover simulado | ✅ `despacho.test.js` | "failover completo até esgotar entregadores disponíveis" é simulado manualmente (insere as 3 tentativas em sequência) — não existe motor de despacho real que faça isso sozinho, então o *orquestrador* automático é pendência ⏸, só o *dado* de cada tentativa é testável |
| Rota com múltiplos pedidos e `ordem_na_rota` variando | ✅ `despacho.test.js` | |
| Todos os valores de `rotas_entrega.status`, incluindo `cancelada` | ✅ `despacho.test.js` | só testa que o CHECK constraint aceita cada valor — a *lógica de negócio* de quando cada transição deveria acontecer não existe (motor de despacho) |
| `codigo_retirada` sob concorrência (retry) | ✅ `despacho.test.js` | reconfirmado após os fixes do ultrareview — 20 inserts concorrentes, 0 colisões |
| **Achado real corrigido nesta rodada**: `tentativas_despacho.entregador_id` sem `ON DELETE CASCADE` | ✅ corrigido em `db/schema.sql` + migration | apagar um tenant travava com FK violation assim que algum entregador tivesse uma tentativa de despacho registrada — não pego pelos ultrareviews porque nenhum teste anterior tinha populado essa tabela antes de tentar limpar dados via cascade de `tenants` |

## Financeiro
| Item | Status | Nota |
|---|---|---|
| `repasses` em `frequencia_repasse` por_entrega/fim_de_turno | ✅ `financeiro.test.js` | o *branching* automático (decidir quando pagar) não existe — é motor de repasse futuro; testamos que o dado persiste certo em cada modo |
| `valor_por_minuto_espera_excedente` quando excede tolerância | ✅ `financeiro.test.js` | cálculo feito manualmente no teste (replica a fórmula) e comparado — não existe função SQL que calcule isso sozinha hoje |
| `valor_por_km_adicional` além do `km_minimo_incluso` | ✅ `financeiro.test.js` | mesma observação — fórmula replicada no teste, não há função no banco |
| `tipo_vinculo='fixo'` (diária/mensal) com `valor_fixo` | ✅ `financeiro.test.js` | |

## Segurança
| Item | Status | Nota |
|---|---|---|
| XSS (escapeHtml nos 6 pontos) | ✅ `seguranca.test.js` | verificação estática (grep dos 2 mockups) + teste unitário da função com payload adversarial — não dá pra testar XSS de verdade sem browser, decisão documentada |
| Reatribuição de `rota_id` (WITH CHECK) | ✅ `seguranca.test.js` | reconfirmado |
| `alertas_seguranca` UPDATE policy pra loja | ✅ `seguranca.test.js` | reconfirmado |
| Fluxo completo `desvio_rota` até `acionado_190` | ✅ `seguranca.test.js` | |
| Fluxo completo `sos_manual` até `falso_alarme` | ✅ `seguranca.test.js` | |
| Bloqueio de fadiga (`bloqueado_ate`) | ✅ `seguranca.test.js` | **achado**: o bloqueio só é respeitado no client (`iniciarTurno()` em `app-entregador.html`) — um insert direto em `turnos` via RLS não é impedido pelo banco mesmo com `bloqueado_ate` no futuro. Não é um bug dos fixes desta sessão (nunca foi essa a promessa do schema), mas é uma lacuna real de enforcement server-side, documentada aqui pela primeira vez |
| Fluxo de pausa/retomada ("Continuar") | ✅ `seguranca.test.js` | reconfirmado: pausar grava `teve_pausa=true`, Continuar volta `status='disponivel'` |

## Avaliações e reputação
| Item | Status | Nota |
|---|---|---|
| `selo_entrega_justa` nos limites exatos (9 vs 10, 3.9 vs 4.0) | ✅ `reputacao.test.js` | ambos os limites confirmados corretos (inclusive `>=4.0`) |
| **Achado real, não corrigido — decisão de produto pendente**: a view não escopa por tenant sob RLS | ✅ testado, ⏸ não corrigido | `selo_entrega_justa` não declara `security_invoker = true`, então roda com o privilégio de quem criou a view (bypassa RLS) em vez de quem consulta. Resultado: qualquer dono autenticado, de qualquer tenant, consegue ver o selo (nome + agregado de nota) de **qualquer outro tenant**, não só o próprio. Dado exposto não é sensível (sem PII/financeiro), o que pode até ser intencional (um selo público faz sentido como vitrine) — mas nada no schema/README declara essa exposição como proposital. Fica como decisão de produto em aberto, não corrigido unilateralmente nesta rodada. |

## LGPD
| Item | Status | Nota |
|---|---|---|
| `dados_anonimizados_em` marcado, dados sensíveis não somem sozinhos | ✅ `lgpd.test.js` | confirma a pendência já documentada em `CLAUDE.md`: marcar o campo não aciona nenhuma anonimização automática (não existe trigger/job) |
| `repasses`/entregas continuam íntegros após "exclusão" | ✅ `lgpd.test.js` | |

## Integrações
| Item | Status | Nota |
|---|---|---|
| CRUD de `integracoes`, só dono | ✅ `integracoes.test.js` | funcionário bloqueado por RLS de papel, antes mesmo de qualquer PIN |
| `set_pin_integracoes`/`verificar_pin_integracoes`/`tem_pin_integracoes` | ✅ `integracoes.test.js` | tentativa certa e errada, e funcionário nunca tem PIN próprio |

---

## Resumo do que já estava coberto antes desta sessão (não repetido aqui)
Documentado em `CLAUDE.md` (item 5): constraints/defaults, RLS multi-tenant básico, A1
(prazo de verificação), A2 (retry de código), `selo_entrega_justa` em casos gerais (não os
limites exatos — isso é novo aqui), funções de PIN (básico — o fluxo completo certo/errado
é novo aqui), cenário de carga (3 tenants/45 pedidos concorrentes), isolamento de Realtime.
E no item 7: os 3 achados do ultrareview round 2.

## Pendências reais (não testáveis sem inventar a feature)
- Reprovação automática por documento vencido (não existe job/trigger).
- Link público de rastreio + avaliação do cliente (TODO explícito, fora de escopo).
- Motor de despacho automático de verdade (failover automático, cálculo de `valor_reembolsado`,
  fórmulas de espera excedente/km adicional como função de banco) — hoje tudo isso é ou manual
  ou simulado no teste replicando a fórmula esperada.
- `bloqueado_ate` só é enforced no client, não no banco — registrado como lacuna real, não
  corrigido nesta rodada (decisão pendente: vale um CHECK/trigger em `turnos`?).
