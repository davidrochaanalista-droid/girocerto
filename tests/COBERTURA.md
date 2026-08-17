# Cobertura de testes — GiroCerto

Última rodada completa: 122/122 passou, contra o Supabase hospedado real (`ntmxkwzhumiqspxijuln`)
e contra o `dispatch-engine/` real rodando como subprocesso, dados de teste limpos ao final
(0 tenants/usuários residuais confirmados).

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
| Reprovação automática por documento vencido | ✅ `onboarding.test.js` | **corrigido** (15/08/2026): `verificar_documentos_vencidos()` via `pg_cron` (hora em hora) reprova CNH/CRLV vencidos — mesmo quem já estava `aprovado`. Bicicleta não é afetada (sem `cnh_validade`/`crlv_validade`). Aviso prévio (`cnh_alerta_enviado_em`/`crlv_alerta_enviado_em`) dispara 15 dias antes, não repete, e reseta ao renovar o documento. Entrega do aviso ao entregador é só banner in-app (`app-entregador.html`) — WhatsApp/push real depende de `integracoes.whatsapp_*`, que não existe ainda. |

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
| `tentativas_despacho` com os 3 resultados (dado bruto, RLS) | ✅ `despacho.test.js` | testa o schema/RLS com tentativas inseridas manualmente |
| Rota com múltiplos pedidos e `ordem_na_rota` variando | ✅ `despacho.test.js` | |
| Todos os valores de `rotas_entrega.status`, incluindo `cancelada` | ✅ `despacho.test.js` | testa que o CHECK constraint aceita cada valor |
| `codigo_retirada` sob concorrência (retry) | ✅ `despacho.test.js` | reconfirmado após os fixes do ultrareview — 20 inserts concorrentes, 0 colisões |
| **Achado real corrigido**: `tentativas_despacho.entregador_id` sem `ON DELETE CASCADE` | ✅ corrigido em `db/schema.sql` + migration | apagar um tenant travava com FK violation assim que algum entregador tivesse uma tentativa de despacho registrada |
| **Motor de despacho REAL** (sessão de go-to-market, 15/08/2026): busca de entregador disponível por raio, criação automática de `tentativas_despacho`, timeout, failover por recusa E por timeout, atribuição de rota ao aceitar, reconciliação de startup | ✅ `despacho_motor.test.js` | Sobe `dispatch-engine/` de verdade como subprocesso (não mock) e dirige um ciclo completo real: pedido pronto → LISTEN/NOTIFY → oferta criada → aceite via RLS → rota atribuída → confirmar retirada (`iniciada_em` populado de verdade) → confirmar entrega → rota concluída + entregador liberado (trigger `concluir_rota_ao_entregar`). Também testa failover por recusa explícita e reconciliação após derrubar/subir o processo com um pedido órfão. |
| UI de oferta de entrega + confirmar retirada em `app-entregador.html` | ✅ `despacho_motor.test.js` (escreve via as MESMAS policies RLS que a UI usa) | modal "nova entrega disponível" via Realtime em `tentativas_despacho` (adicionada à publication), aceitar/recusar, banner de confirmar retirada quando `rota.status='a_caminho_da_loja'` |
| **Corrigido**: `clicarContinuar()` sempre resetava `entregadores.status` pra `'disponivel'`, mesmo pausando no meio de uma entrega — achado de consequência do motor de despacho real (virou risco ativo, não mais teórico) | ✅ `despacho_motor.test.js` | `pausar_entregador()`/`retomar_entregador()` (funções SQL, atômicas — evitam corrida com o motor de despacho escrevendo `status` no mesmo instante) guardam `status_antes_pausa` e restauram o valor certo. Testado contra o motor real: entregador pausado em `em_rota` NÃO recebe nova `tentativas_despacho` mesmo com pedido pronto no mesmo tenant; ao retomar, volta pra `em_rota`, não `disponivel`. |

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
| Bloqueio de fadiga (`bloqueado_ate`) | ✅ `seguranca.test.js` | **corrigido** (15/08/2026): antes só era respeitado no client; agora `turnos` tem policy dedicada de INSERT que rejeita quando `bloqueado_ate` está no futuro. UPDATE de turno existente (pausar/finalizar) não é afetado — só abrir turno NOVO trava. Testado com bloqueado (rejeitado), bloqueio expirado (passa) e nunca bloqueado (passa). |
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

## Go-to-market (sessão de 15/08/2026 — "implemente tudo que for necessário")
| Item | Status | Nota |
|---|---|---|
| Credenciais Supabase reais nas 3 páginas (`cadastro-loja.html`, `painel-loja.html`, `app-entregador.html`) | ✅ manual, confirmado por grep | anon/publishable key embutida (segura por design, RLS é a fronteira real) — nunca service_role/DATABASE_URL |
| `TENANT_ID` hardcoded em `app-entregador.html` | ✅ | agora vem de `?loja=<uuid>` na URL + fallback `localStorage`; link gerado e copiável em `painel-loja.html` (aba Entregadores) |
| `tenants.lat`/`lng` (pré-requisito descoberto, não pedido original) | ✅ testado indiretamente via `despacho_motor.test.js` (geofiltro real) | captura via geolocalização do navegador (sem provedor terceiro), botão em `painel-loja.html` |
| Pix — confirmado decorativo, isolado, não fingido | ✅ confirmado por grep completo, documentado inline nos 2 pontos de contato | ver "Pendência isolada — Pix" abaixo |

## Pendência isolada — Pix (decisão externa necessária, não implementado de propósito)
Confirmado por grep completo do projeto (não suposição): **nenhuma chamada de API de
pagamento existe em lugar nenhum**. `qr-placeholder` em `app-entregador.html` é só HTML/CSS
decorativo; `salvarIntegracoes()` em `painel-loja.html` só grava a chave digitada em
`integracoes.pix_provider_api_key`, sem nunca chamá-la. `confirmarEntrega()` **não depende**
de `pedidos.pago=true` — o fluxo de entrega já é 100% independente de pagamento hoje, então
nenhuma mudança de código é necessária no resto do sistema pra ligar isso depois.

O que falta decidir (fora do escopo técnico, decisão de produto/negócio):
1. Qual provedor usar (`integracoes.pix_provider` já aceita `mercado_pago`/`asaas`/`stone`/`outro`).
2. Contratar a conta/API key com o provedor escolhido.
3. Decidir onde a geração do QR Code e o recebimento do webhook de confirmação rodam —
   `dispatch-engine/` é o candidato natural (já é o serviço com service_role key), mas isso
   não foi construído.

Isolado em 2 pontos comentados no código (não espalhado): o cartão de pagamento em
`app-entregador.html` (comentário completo com os 3 itens acima) e a seção de Integrações em
`painel-loja.html`.

## 2ª rodada de `/ultrareview` — 15 achados no `dispatch-engine/` novo, todos corrigidos
Rodada de revisão pedida logo depois do motor de despacho + UI de oferta ficarem prontos.
15 achados reais, a maioria races de concorrência no código novo — todos verificados
manualmente contra o código antes de corrigir (2 dos 15 nem eram bugs no comportamento
principal, eram sobre teste/robustez), e todos corrigidos e testados de novo contra o
`dispatch-engine/` real.

| # | Achado | Correção |
|---|---|---|
| 1 | RLS bloqueava o modal de oferta de ler a rota/pedido ANTES do aceite — feature nova ficaria 100% muda em produção real (só não foi pega antes porque os testes escreviam o aceite direto, sem passar pela leitura real) | 2 policies novas (`rotas_entrega` e `pedidos`) usando uma função `SECURITY DEFINER` nova (`rotas_com_tentativa_para_mim()`) — **e essa correção causou uma recursão infinita de RLS (42P17) que só apareceu ao rodar de verdade**, corrigida trocando o subselect cru pela mesma função |
| 2, 3 | `bloqueado_ate` (fix da sessão anterior) tinha 2 bypasses: update direto limpando o próprio campo, ou reativando um turno finalizado via update | 2 triggers novos (`proteger_bloqueado_ate`, `proteger_reativacao_turno_bloqueado`) |
| 4 | Trigger de conclusão de rota (desta mesma sessão) resetava `status='disponivel'` mesmo se o entregador tivesse pausado no meio da entrega — mesma classe de bug que o fix do item anterior corrigiu, só que num lugar diferente | guard `and status <> 'pausado'` no UPDATE |
| 5 | Reconciliação de startup não reconstruía quem já tinha sido tentado por rota — reofereceria pra quem já recusou, depois de um restart | `reconstruirTentadosPorRota()` lê o histórico real de `tentativas_despacho` na subida |
| 6, 8 | 2 races de "ler depois escrever" (não atômico) no aceite e no timeout — resposta real podia ser sobrescrita | UPDATE...WHERE com checagem de linhas afetadas em vez de SELECT prévio |
| 7 | `error` e `end` do listener podiam agendar reconexão duplicada — 2 processos escutando ao mesmo tempo, todo evento processado 2x | flag `reconectando` trava reconexão dupla |
| 9 | Duas chamadas concorrentes podiam criar 2 rotas pro mesmo pedido | UPDATE...WHERE atômico reivindicando o pedido pra rota; quem perde descarta a rota órfã |
| 10 | `tentadosPorRota`/`timersPorRota` vazavam memória quando uma rota esgotava os candidatos | limpeza explícita no caminho "sem candidato" |
| 11 | Mesmo entregador podia receber 2 ofertas simultâneas (status continua 'disponivel' até aceitar) | exclui quem tem qualquer tentativa com `resultado` null, não só nessa rota |
| 12 | `confirmarRetirada()` fazia 2 updates separados — mesma classe de corrida que as RPCs de pausar/retomar foram criadas pra evitar | nova RPC `confirmar_retirada_rota()`, atômica |
| 13 | `confirmarEntrega()` sem checagem de erro/null — `TypeError` se o pedido fosse reatribuído no meio do fluxo | checagem de erro/null antes de usar o dado |
| 14 | `recusarOferta()` não checava erro — falha de rede deixava a oferta "recusada" só na tela, sem escrever no banco | alerta de erro, igual `aceitarOferta()` já tinha |
| 15 | `tests/seguranca.test.js` testava pausar/retomar com `.update()` direto — não exercitava as RPCs reais que a produção usa | teste reescrito pra chamar as RPCs de verdade + cenário do achado #4 |

Testes novos: `tests/despacho_motor.test.js` ganhou 2 casos (leitura da oferta via RLS,
exclusão de entregador com oferta pendente); `tests/seguranca.test.js` ganhou o teste de
pausar/retomar reescrito + 3 casos de bypass de `bloqueado_ate`. Suíte: 114 → **120/120**.

### Auditoria pós-correção: outros testes com o mesmo problema do achado #1?
Pedido explícito do usuário depois do achado #1 (RLS bloqueando um caminho que os testes
nunca exercitavam de verdade): revisar a suíte inteira em busca do mesmo padrão —
teste passando porque testa um caminho DIFERENTE do que a produção realmente percorre.

- **Achado**: `config_fadiga_do_meu_tenant()` (RPC chamada por `app-entregador.html`) nunca
  tinha sido testada via `.rpc()` em lugar nenhum da suíte. Corrigido: novo teste em
  `tests/seguranca.test.js`, com valores de tenant DE PROPÓSITO diferentes do fallback
  hardcoded do client (8.0/8.0) — um teste com valores default não pegaria a RPC quebrada
  caindo no fallback silencioso.
- **Achado relacionado (mesma categoria, indo mais fundo)**: o teste original do achado #1
  confirmava que a LEITURA via RLS funcionava, mas nunca confirmava que o Realtime de
  verdade ENTREGA o evento que dispara `mostrarOferta()` no client — só testava o resultado
  final, não o mecanismo de entrega. **Nenhum teste da suíte inteira assinava um canal
  Realtime de verdade** (confirmado por `grep -rl ".channel(" tests/*.test.js` — vazio).
  Corrigido: `tests/despacho_motor.test.js` agora assina o canal real (WebSocket) ANTES do
  pedido virar `'pronto'`, do mesmo jeito que `iniciarEscutaDeOfertas()` faz, e confirma que
  o evento chega.
- **Outras RPCs conferidas e já corretas**: `pausar_entregador`/`retomar_entregador`/
  `confirmar_retirada_rota` (corrigidas no achado #15) e `tem_pin_integracoes`/
  `set_pin_integracoes`/`verificar_pin_integracoes` (já estavam certas em
  `integracoes.test.js`, checado agora pra confirmar).
- **Pendência registrada, não corrigida agora** (escopo do pedido era "revisar
  rapidamente", não uma expansão completa): o gap de "nenhum teste assina Realtime de
  verdade" é mais amplo que só `tentativas_despacho` — `localizacoes_entregador` e
  `alertas_seguranca` também nunca tiveram sua entrega via Realtime testada na suíte
  versionada (só via script avulso, em sessão anterior, não preservado). Ver
  `CLAUDE.md`.

Suíte: 120 → **122/122**.

---

## Resumo do que já estava coberto antes desta sessão (não repetido aqui)
Documentado em `CLAUDE.md` (item 5): constraints/defaults, RLS multi-tenant básico, A1
(prazo de verificação), A2 (retry de código), `selo_entrega_justa` em casos gerais (não os
limites exatos — isso é novo aqui), funções de PIN (básico — o fluxo completo certo/errado
é novo aqui), cenário de carga (3 tenants/45 pedidos concorrentes), isolamento de Realtime.
E no item 7: os 3 achados do ultrareview round 2.

## Pendências reais (não testáveis sem inventar a feature ou sem decisão externa)
- Link público de rastreio + avaliação do cliente — ainda TODO explícito. O motor de despacho
  real agora existe, mas a página pública em si (token por pedido, sem enumeração) não foi
  construída nesta rodada — não fazia parte do escopo desta sessão específica.
- Integração real de Pix — ver "Pendência isolada — Pix" acima. Decisão de produto (provedor),
  não decisão técnica.
- Entrega real do aviso de documento vencendo (WhatsApp/push) — hoje só banner in-app; depende
  de `integracoes.whatsapp_*`, que não tem nenhuma chamada de API implementada ainda.
- `dispatch-engine/` não está deployado no Railway ainda — código pronto e testado localmente
  (real, contra o Supabase hospedado), mas o deploy em si (criar o serviço no Railway, configurar
  as env vars) é uma ação fora do que dá pra fazer nesta sessão (requer acesso à conta Railway).
- Estado de failover/timeout do motor de despacho vive em memória do processo — não sobrevive a
  restart no meio de uma janela de espera (a reconciliação de startup cobre o caso comum, ver
  `dispatch-engine/README.md`).

## Resolvidas nesta rodada (15/08/2026)
- Reprovação automática por documento vencido — ver seção Onboarding acima.
- `bloqueado_ate` enforced no banco, não só client — ver seção Segurança acima.
- Motor de despacho real, completo — ver seção Despacho e rotas acima.
- UI de oferta de entrega + confirmar retirada — ver seção Despacho e rotas acima.
- `TENANT_ID` hardcoded, credenciais placeholder, localização da loja — ver seção Go-to-market acima.
- Pix confirmado e isolado (não corrigido — decisão externa) — ver seção acima.
- `clicarContinuar()` preservando status anterior à pausa — ver seção Despacho e rotas acima.
