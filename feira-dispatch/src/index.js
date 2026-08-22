'use strict';

/**
 * Exemplo de integração com Express + Supabase.
 * Adapte os imports de supabaseClient para o seu projeto GiroCerto.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createRouteManager } = require('./routeManager');
const { createCheckoutValidator } = require('./checkout');
const { createNotificationWorker, enviarWhatsappCloudAPI, enviarPushVoz } = require('./notifications');
const { calcularTaxaJusta } = require('./feeCalculator');
const { calcularBonusChegada } = require('./arrivalBonus');
const { distanciaKm } = require('./geo');
const { aplicarPisoRegulatorio, calcularCompensacaoEspera } = require('./regulatoryCompliance');
const { priorizarOfertaJusta } = require('./fairRotation');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role: triggers e RPC precisam de privilégio elevado
);

const routeManager = createRouteManager(supabase);
const checkoutValidator = createCheckoutValidator(supabase);
const notificationWorker = createNotificationWorker(supabase, {
  enviarWhatsapp: enviarWhatsappCloudAPI,
  enviarPushVoz,
});

/**
 * Chame este endpoint (ou a função diretamente) sempre que um
 * pedido_grupo mudar para status = 'pronto_para_coleta'.
 * Em produção, prefira disparar via LISTEN/NOTIFY no Postgres
 * (mesmo padrão já usado no dispatch engine do GiroCerto) em vez de
 * esperar o front-end chamar este endpoint.
 */
router.post('/dispatch/pedido/:pedidoGrupoId', async (req, res) => {
  try {
    const resultado = await routeManager.despacharPedido(req.params.pedidoGrupoId);
    res.json(resultado);
  } catch (err) {
    console.error('[dispatch] erro ao despachar pedido:', err);
    res.status(500).json({ error: 'Falha ao despachar pedido', detalhe: err.message });
  }
});

/**
 * Cron job — configure para rodar a cada 30s (ex: node-cron, ou um
 * worker separado no Railway). Fecha rotas 'em_montagem' que já
 * esperaram tempo demais, mesmo sem estar cheias.
 */
router.post('/dispatch/fechar-expiradas', async (_req, res) => {
  try {
    const fechadas = await routeManager.fecharRotasExpiradas();
    res.json({ rotas_fechadas: fechadas });
  } catch (err) {
    console.error('[dispatch] erro ao fechar rotas expiradas:', err);
    res.status(500).json({ error: 'Falha ao fechar rotas expiradas', detalhe: err.message });
  }
});

/**
 * Cria o pedido_grupo definitivo após validar valor mínimo e calcular a
 * taxa justa — persiste trecho_a_pe_km/trecho_ate_entrega_km/qtd_bancas
 * junto, pra dar base à métrica real depois que a rota terminar
 * (ver migration 005 e view analise_piso_minimo).
 */
router.post('/checkout/criar-pedido-grupo', async (req, res) => {
  try {
    const { consumidorId, feiraOcorrenciaId, estabelecimentoIds, enderecoEntrega, itensPorBanca } =
      req.body;

    const { data: participacoes, error: errPart } = await supabase
      .from('feirante_participacao')
      .select(
        'estabelecimento_id, latitude_banca, longitude_banca, estabelecimentos(latitude, longitude, chave_pix)'
      )
      .in('estabelecimento_id', estabelecimentoIds);
    if (errPart) throw errPart;

    const bancas = participacoes.map((p) => ({
      estabelecimentoId: p.estabelecimento_id,
      latitude: p.latitude_banca ?? p.estabelecimentos.latitude,
      longitude: p.longitude_banca ?? p.estabelecimentos.longitude,
    }));

    const valorTotalProdutos = Object.values(itensPorBanca).reduce(
      (soma, itens) => soma + itens.reduce((s, i) => s + i.quantidade * i.precoUnitario, 0),
      0
    );

    const validacaoMinimo = await checkoutValidator.validarValorMinimo(
      feiraOcorrenciaId,
      valorTotalProdutos
    );
    if (!validacaoMinimo.valido) return res.status(422).json(validacaoMinimo);

    const taxa = aplicarPisoRegulatorio(calcularTaxaJusta(bancas, enderecoEntrega));

    // rejeita se a distância até o endereço exceder o que QUALQUER
    // veículo da frota conseguiria cobrir — não adianta cobrar a taxa
    // se depois nenhum entregador puder pegar a corrida
    const validacaoAlcance = checkoutValidator.validarAlcanceMaximo(
      taxa.detalhamento.trechoAteEntregaKm,
      'feira'
    );
    if (!validacaoAlcance.valido) return res.status(422).json(validacaoAlcance);

    const { data: grupo, error: errGrupo } = await supabase
      .from('pedido_grupo')
      .insert({
        consumidor_id: consumidorId,
        feira_ocorrencia_id: feiraOcorrenciaId,
        taxa_entrega: taxa.taxaFinal,
        qtd_paradas: bancas.length,
        qtd_bancas: bancas.length,
        trecho_a_pe_km: taxa.detalhamento.trechoAPeKm,
        trecho_ate_entrega_km: taxa.detalhamento.trechoAteEntregaKm,
        endereco_entrega: enderecoEntrega.endereco || '',
        latitude_entrega: enderecoEntrega.latitude,
        longitude_entrega: enderecoEntrega.longitude,
      })
      .select()
      .single();
    if (errGrupo) throw errGrupo;

    const pedidosCriados = [];
    for (const participacao of participacoes) {
      const itens = itensPorBanca[participacao.estabelecimento_id] || [];
      const valorBanca = itens.reduce((s, i) => s + i.quantidade * i.precoUnitario, 0);

      const { data: pedido, error: errPedido } = await supabase
        .from('pedido')
        .insert({
          pedido_grupo_id: grupo.id,
          estabelecimento_id: participacao.estabelecimento_id,
          valor_produtos: valorBanca,
          chave_pix_feirante: participacao.estabelecimentos.chave_pix,
        })
        .select()
        .single();
      if (errPedido) throw errPedido;

      if (itens.length > 0) {
        await supabase.from('pedido_item').insert(
          itens.map((i) => ({
            pedido_id: pedido.id,
            produto_id: i.produtoId,
            quantidade: i.quantidade,
            preco_unitario: i.precoUnitario,
            peso_unitario: i.pesoUnitario || 0,
          }))
        );
      }
      pedidosCriados.push(pedido);
    }

    res.status(201).json({ pedidoGrupo: grupo, pedidos: pedidosCriados, taxa: taxa.detalhamento });
  } catch (err) {
    console.error('[checkout] erro ao criar pedido_grupo:', err);
    res.status(500).json({ error: 'Falha ao criar pedido', detalhe: err.message });
  }
});

/**
 * Aceitar corrida — grava o momento real (aceita_em) E calcula a taxa
 * de deslocamento até a feira com a posição REAL do entregador nesse
 * instante (a segunda taxa, paga pela plataforma — ver arrivalBonus.js).
 */
router.post('/rota/:entregaRotaId/aceitar', async (req, res) => {
  try {
    const { latitude, longitude } = req.body; // posição atual do entregador

    const { data: primeiraParada, error: errParada } = await supabase
      .from('rota_parada')
      .select('latitude, longitude')
      .eq('entrega_rota_id', req.params.entregaRotaId)
      .eq('tipo', 'coleta')
      .order('ordem', { ascending: true })
      .limit(1)
      .single();
    if (errParada) throw errParada;

    const bonus = calcularBonusChegada(
      { latitude, longitude },
      { latitude: primeiraParada.latitude, longitude: primeiraParada.longitude }
    );

    const { error } = await supabase.rpc('aceitar_rota', {
      p_entrega_rota_id: req.params.entregaRotaId,
      p_distancia_ate_feira_km: bonus.distanciaKm,
      p_bonus_deslocamento: bonus.bonus,
    });
    if (error) throw error;

    res.json({ aceito: true, taxaDeslocamento: bonus });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao aceitar rota', detalhe: err.message });
  }
});

/**
 * Calcula a taxa de entrega ANTES do consumidor confirmar o carrinho,
 * a partir da posição real de cada banca escolhida (sem depender de
 * ponto de coleta único). Chame ao montar o resumo do carrinho.
 */
router.post('/checkout/calcular-taxa', async (req, res) => {
  try {
    const { estabelecimentoIds, enderecoEntrega } = req.body;

    const { data: participacoes, error } = await supabase
      .from('feirante_participacao')
      .select(
        'estabelecimento_id, latitude_banca, longitude_banca, estabelecimentos(latitude, longitude)'
      )
      .in('estabelecimento_id', estabelecimentoIds);
    if (error) throw error;

    const bancas = participacoes.map((p) => ({
      estabelecimentoId: p.estabelecimento_id,
      // usa a posição marcada da banca; sem isso, cai no endereço cadastral
      // do feirante como aproximação (menos preciso, mas nunca bloqueia o fluxo)
      latitude: p.latitude_banca ?? p.estabelecimentos.latitude,
      longitude: p.longitude_banca ?? p.estabelecimentos.longitude,
    }));

    const resultado = aplicarPisoRegulatorio(calcularTaxaJusta(bancas, enderecoEntrega));
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao calcular taxa de entrega', detalhe: err.message });
  }
});

/**
 * Validação de valor mínimo — chame no checkout, antes de criar os
 * registros de `pedido`. Retorna 422 se o carrinho estiver abaixo
 * do mínimo configurado pra feira.
 */
router.post('/checkout/validar-minimo', async (req, res) => {
  try {
    const { feiraOcorrenciaId, valorTotalProdutos } = req.body;
    const resultado = await checkoutValidator.validarValorMinimo(
      feiraOcorrenciaId,
      valorTotalProdutos
    );
    if (!resultado.valido) return res.status(422).json(resultado);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao validar valor mínimo', detalhe: err.message });
  }
});

/**
 * Expira pedidos pendentes há mais tempo que o permitido e libera
 * grupos PARCIALMENTE (quem já confirmou não fica travado esperando
 * quem nunca respondeu). Rode em cron a cada 1-2 min.
 */
router.post('/dispatch/expirar-pendentes', async (_req, res) => {
  try {
    const { data, error } = await supabase.rpc('expirar_pedidos_pendentes');
    if (error) throw error;
    res.json({ processados: data });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao expirar pedidos pendentes', detalhe: err.message });
  }
});

/**
 * Worker de notificações — consome a fila e envia via WhatsApp/push.
 * Rode em cron curto (ex: a cada 15s) ou como worker dedicado no Railway.
 */
router.post('/notificacoes/processar', async (_req, res) => {
  try {
    const resultado = await notificationWorker.processarLote();
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao processar notificações', detalhe: err.message });
  }
});

/**
 * Registrar avaliação (consumidor avalia feirante/entregador, ou
 * vice-versa) após a entrega concluir.
 */
router.post('/avaliacao', async (req, res) => {
  try {
    const { pedidoGrupoId, avaliadorTipo, avaliadorId, avaliadoTipo, avaliadoId, nota, comentario } =
      req.body;

    const { data, error } = await supabase
      .from('avaliacao')
      .insert({
        pedido_grupo_id: pedidoGrupoId,
        avaliador_tipo: avaliadorTipo,
        avaliador_id: avaliadorId,
        avaliado_tipo: avaliadoTipo,
        avaliado_id: avaliadoId,
        nota,
        comentario,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao registrar avaliação', detalhe: err.message });
  }
});

/**
 * Retorna a rota já agrupada por local físico — bancas com mais de um
 * pedido (clientes diferentes comprando na mesma banca) aparecem como
 * UMA parada consolidada com múltiplos tickets, não como visitas
 * repetidas ao mesmo lugar. É isso que o app do entregador consome.
 */
router.get('/rota/:entregaRotaId/paradas', async (req, res) => {
  try {
    const paradas = await routeManager.buscarParadasAgrupadas(req.params.entregaRotaId);
    res.json({ paradas });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar paradas da rota', detalhe: err.message });
  }
});

/**
 * Confirma a coleta de UM pedido específico dentro de uma parada
 * consolidada (banca visitada por mais de um cliente) — usa pedido_id
 * em vez de rota_parada_id, porque na tela o entregador confere cada
 * ticket individualmente dentro da mesma visita física.
 */
router.post('/rota/pedido/:pedidoId/confirmar-coleta', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    const { data: parada, error: errBusca } = await supabase
      .from('rota_parada')
      .select('id, latitude, longitude')
      .eq('pedido_id', req.params.pedidoId)
      .eq('tipo', 'coleta')
      .single();
    if (errBusca) throw errBusca;

    const { data: divergencia } = await supabase.rpc('calcular_divergencia_m', {
      lat1: parada.latitude,
      lng1: parada.longitude,
      lat2: latitude,
      lng2: longitude,
    });

    const { data, error } = await supabase
      .from('rota_parada')
      .update({
        latitude_confirmada: latitude,
        longitude_confirmada: longitude,
        divergencia_m: divergencia,
        status: 'concluida',
        concluida_em: new Date().toISOString(),
      })
      .eq('id', parada.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ ...data, alerta_divergencia: divergencia > 150 });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao confirmar coleta do pedido', detalhe: err.message });
  }
});

/**
 * Confirmação de posição na coleta/entrega — registra divergência de
 * geolocalização sem bloquear o fluxo (ver migration 003, item 4).
 */
router.post('/rota/parada/:paradaId/concluir', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    const { data: parada, error: errBusca } = await supabase
      .from('rota_parada')
      .select('latitude, longitude')
      .eq('id', req.params.paradaId)
      .single();
    if (errBusca) throw errBusca;

    const { data: divergencia, error: errCalc } = await supabase.rpc('calcular_divergencia_m', {
      lat1: parada.latitude,
      lng1: parada.longitude,
      lat2: latitude,
      lng2: longitude,
    });
    if (errCalc) throw errCalc;

    const { data, error } = await supabase
      .from('rota_parada')
      .update({
        latitude_confirmada: latitude,
        longitude_confirmada: longitude,
        divergencia_m: divergencia,
        status: 'concluida',
        concluida_em: new Date().toISOString(),
      })
      .eq('id', req.params.paradaId)
      .select()
      .single();
    if (error) throw error;

    res.json({ ...data, alerta_divergencia: divergencia > 150 });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao concluir parada', detalhe: err.message });
  }
});

/**
 * Registra o token de push do app nativo do consumidor — necessário
 * pra habilitar o canal push_voz (áudio automático mesmo com celular
 * bloqueado). Sem isso, o sistema sempre cai pro WhatsApp de texto.
 */
router.post('/usuario/:usuarioId/push-token', async (req, res) => {
  try {
    const { pushToken, plataforma } = req.body; // plataforma: 'android' | 'ios'
    const { error } = await supabase
      .from('usuarios')
      .update({ push_token: pushToken, push_plataforma: plataforma })
      .eq('id', req.params.usuarioId);
    if (error) throw error;
    res.json({ registrado: true });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao registrar push token', detalhe: err.message });
  }
});

/**
 * Atualiza a posição do entregador em tempo real e checa proximidade
 * com entregas pendentes — o app deve chamar isso a cada 15-30s
 * enquanto a rota estiver 'em_rota'. Dispara automaticamente a
 * notificação "vá até a portaria" quando cruzar o raio configurado
 * (padrão 400m, dentro da faixa 300-500m).
 */
router.post('/entregador/:entregadorId/localizacao', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    const { error: errUpdate } = await supabase.rpc('atualizar_localizacao_entregador', {
      p_entregador_id: req.params.entregadorId,
      p_latitude: latitude,
      p_longitude: longitude,
    });
    if (errUpdate) throw errUpdate;

    const { data: proximidades, error: errProx } = await supabase.rpc(
      'verificar_proximidade_entregas',
      { p_entregador_id: req.params.entregadorId }
    );
    if (errProx) throw errProx;

    res.json({ atualizado: true, notificacoesDisparadas: proximidades || [] });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao atualizar localização', detalhe: err.message });
  }
});

/**
 * Registra que o entregador chegou na parada (antes de concluir) — é o
 * marco pra medir tempo de espera parado, remunerado a R$0,60/min
 * (ver migration 007, alinhado ao PL 2479/25).
 */
router.post('/rota/parada/:paradaId/chegou', async (req, res) => {
  try {
    const { error } = await supabase.rpc('registrar_chegada_parada', {
      p_parada_id: req.params.paradaId,
    });
    if (error) throw error;
    res.json({ registrado: true, em: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao registrar chegada', detalhe: err.message });
  }
});

/**
 * Registra recusa de oferta — APENAS para análise agregada de
 * precificação. Nunca usar pra pontuar, despriorizar ou suspender o
 * entregador (exigência de transparência do PL 2479/25: recusar
 * pedido mal remunerado não pode gerar punição).
 */
router.post('/rota/:entregaRotaId/recusar', async (req, res) => {
  try {
    const { entregadorId, taxaOfertada, distanciaKm: dist, tempoEstimadoMin } = req.body;

    const { error } = await supabase.from('oferta_recusada').insert({
      entregador_id: entregadorId,
      entrega_rota_id: req.params.entregaRotaId,
      taxa_ofertada: taxaOfertada,
      distancia_km: dist,
      tempo_estimado_min: tempoEstimadoMin,
    });
    if (error) throw error;

    res.json({ registrado: true, aviso: 'Recusar não afeta seu cadastro ou prioridade futura.' });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao registrar recusa', detalhe: err.message });
  }
});

/**
 * Lista flags pendentes de revisão HUMANA (divergência de geolocalização,
 * etc.) — nunca suspende conta automaticamente. Um operador humano
 * decide o desfecho via /entregador/flag/:id/revisar.
 */
router.get('/entregador/flags-pendentes', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('entregador_flag_revisao')
      .select('*')
      .eq('status', 'aguardando_revisao')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ flags: data });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar flags pendentes', detalhe: err.message });
  }
});

router.post('/entregador/flag/:flagId/revisar', async (req, res) => {
  try {
    const { revisadoPor, decisao } = req.body; // revisado_sem_acao | revisado_com_advertencia | revisado_com_suspensao
    const { data, error } = await supabase
      .from('entregador_flag_revisao')
      .update({ status: decisao, revisado_por: revisadoPor, revisado_em: new Date().toISOString() })
      .eq('id', req.params.flagId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao revisar flag', detalhe: err.message });
  }
});

/**
 * Extrato do entregador — histórico de ganhos com timestamp, visível
 * pra ele mesmo (achado recorrente na pesquisa: falta de transparência
 * sobre pagamento é a reclamação mais repetida contra apps do setor).
 */
router.get('/entregador/:entregadorId/extrato', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('extrato_entregador')
      .select('*')
      .eq('entregador_id', req.params.entregadorId)
      .order('concluida_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ extrato: data });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar extrato', detalhe: err.message });
  }
});

/**
 * Exemplo de cron standalone (node-cron), caso prefira rodar fora do Express:
 *
 * const cron = require('node-cron');
 * cron.schedule('*\/30 * * * * *', () => routeManager.fecharRotasExpiradas().catch(console.error));
 * cron.schedule('*\/2 * * * *', () => supabase.rpc('expirar_pedidos_pendentes').catch(console.error));
 * cron.schedule('*\/15 * * * * *', () => notificationWorker.processarLote().catch(console.error));
 */

module.exports = router;
