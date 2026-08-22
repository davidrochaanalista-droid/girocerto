'use strict';

const { encontrarMelhorInsercao } = require('./insertionEngine');
const { agruparParadasMesmoLocal } = require('./stopGrouping');
const { priorizarOfertaJusta } = require('./fairRotation');
const { enviarPushBuzinaEntregador } = require('./notifications');

/**
 * routeManager depende de um cliente Supabase já configurado, injetado
 * na criação (evita acoplar este módulo a uma instância global).
 *
 * const { createRouteManager } = require('./routeManager');
 * const routeManager = createRouteManager(supabaseClient);
 *
 * FIX aplicado nesta cópia (integração GiroCerto, 22/08/2026): toda
 * referência a `entregadores.latitude`/`.longitude` corrigida pra
 * `entregadores.lat`/`.lng` — nome real da coluna na tabela compartilhada
 * (confirmado contra o banco hospedado antes de aplicar; o módulo
 * original assumia latitude/longitude, que não existe). `estabelecimentos`
 * é tabela NOVA criada especificamente pra este módulo — mantém
 * latitude/longitude como o módulo original definiu, sem fix nenhum ali.
 */
function createRouteManager(supabase) {
  /** Busca configuração de dispatch (peso máx, paradas máx, detour máx) por perfil. */
  async function buscarConfig(tipoPerfil) {
    const { data, error } = await supabase
      .from('dispatch_config')
      .select('*')
      .eq('tipo_perfil', tipoPerfil)
      .single();

    if (error) throw error;

    return {
      // limite efetivo já desconta a margem de segurança (peso é autodeclarado
      // pelo feirante — a folga absorve erro de estimativa sem estourar o
      // limite físico real que o entregador carrega)
      pesoMaxKg: Number(data.peso_max_kg) - Number(data.margem_seguranca_kg),
      pesoMaxKgFisico: Number(data.peso_max_kg),
      maxParadas: data.max_paradas,
      maxDetourPct: Number(data.max_detour_pct),
      maxEsperaMontagemSeg: data.max_espera_montagem_seg,
    };
  }

  /** Monta o objeto PedidoParaDispatch a partir de um pedido_grupo pronto_para_coleta.
   *
   * FIX aplicado nesta cópia (integração GiroCerto, achado real ao rodar
   * o despacho de verdade pela primeira vez, 22/08/2026): o módulo
   * original tentava embutir `pedido_grupo_com_peso(peso_total)` via
   * select aninhado do PostgREST — isso só funciona pra tabelas com FK
   * real; `pedido_grupo_com_peso` é uma VIEW, sem relacionamento que o
   * PostgREST consiga detectar sozinho (erro real: "Could not find a
   * relationship between 'pedido_grupo' and 'pedido_grupo_com_peso'").
   * Corrigido buscando a view numa query separada, mesmo padrão já usado
   * logo abaixo pra `feira_ocorrencia`. */
  async function montarPedidoParaDispatch(pedidoGrupoId) {
    const { data: grupo, error: errGrupo } = await supabase
      .from('pedido_grupo')
      .select(
        `id, feira_ocorrencia_id, latitude_entrega, longitude_entrega,
         pedido:pedido(id, estabelecimento_id, estabelecimentos(latitude, longitude))`
      )
      .eq('id', pedidoGrupoId)
      .single();

    if (errGrupo) throw errGrupo;

    const { data: pesoGrupo } = await supabase
      .from('pedido_grupo_com_peso')
      .select('peso_total')
      .eq('pedido_grupo_id', pedidoGrupoId)
      .maybeSingle();

    const { data: feiraOcorrencia } = await supabase
      .from('feira_ocorrencia')
      .select('feira_id')
      .eq('id', grupo.feira_ocorrencia_id)
      .single();

    // busca posição real da banca (feirante_participacao), com fallback
    // pro endereço cadastral se ainda não foi marcada no mapa
    const estabelecimentoIds = grupo.pedido.map((p) => p.estabelecimento_id);
    const { data: participacoes } = await supabase
      .from('feirante_participacao')
      .select('estabelecimento_id, latitude_banca, longitude_banca')
      .eq('feira_ocorrencia_id', grupo.feira_ocorrencia_id)
      .in('estabelecimento_id', estabelecimentoIds);

    const posicaoBancaPorId = new Map(
      (participacoes || []).map((p) => [p.estabelecimento_id, p])
    );

    const paradasColeta = grupo.pedido.map((p) => {
      const banca = posicaoBancaPorId.get(p.estabelecimento_id);
      return {
        pedidoId: p.id,
        pedidoGrupoId: grupo.id,
        latitude: banca?.latitude_banca ?? p.estabelecimentos.latitude,
        longitude: banca?.longitude_banca ?? p.estabelecimentos.longitude,
      };
    });

    return {
      pedidoGrupoId: grupo.id,
      tipoPerfil: feiraOcorrencia ? 'feira' : 'restaurante',
      pesoTotal: pesoGrupo?.peso_total ?? 0,
      paradasColeta,
      paradaEntrega: {
        pedidoGrupoId: grupo.id,
        latitude: grupo.latitude_entrega,
        longitude: grupo.longitude_entrega,
      },
    };
  }

  /** Busca rotas 'em_montagem' OU 'em_rota' de entregadores dentro de um raio (km).
   *
   * FIX (achado real, 22/08/2026): antes só considerava 'em_montagem' — uma
   * vez que o entregador aceitava a rota (status vira 'em_rota'), ela saía
   * da consolidação, e um pedido novo que devia ser inserido "no caminho"
   * acabava abrindo uma 2ª rota separada pro MESMO entregador (via
   * buscar_entregador_mais_proximo, que não o excluía por engano — ver
   * fix em aceitar_rota()). Paradas já 'concluida' continuam fora da
   * reotimização (filtro abaixo só pega 'pendente'), então isso nunca
   * reordena uma coleta/entrega que já aconteceu. */
  async function buscarRotasCandidatas(tipoPerfil, raioKm = 8) {
    const { data: rotas, error } = await supabase
      .from('entrega_rota')
      .select(
        `id, entregador_id, tipo_perfil, peso_total, status,
         entregadores(lat, lng, tipo_veiculo),
         rota_parada(id, tipo, pedido_id, pedido_grupo_id, latitude, longitude, ordem, status)`
      )
      .in('status', ['em_montagem', 'em_rota'])
      .in('tipo_perfil', [tipoPerfil, 'misto']);

    if (error) throw error;

    return (rotas || [])
      .filter((r) => r.entregadores) // entregador precisa ter posição conhecida
      .map((r) => ({
        entregaRotaId: r.id,
        entregadorId: r.entregador_id,
        statusRota: r.status,
        tipoPerfil: r.tipo_perfil,
        tipoVeiculo: r.entregadores.tipo_veiculo,
        pesoTotalAtual: Number(r.peso_total),
        posicaoEntregador: {
          latitude: r.entregadores.lat,
          longitude: r.entregadores.lng,
        },
        paradasAtuais: (r.rota_parada || [])
          .filter((p) => p.status === 'pendente')
          .sort((a, b) => a.ordem - b.ordem)
          .map((p) => ({
            id: p.id,
            tipo: p.tipo,
            pedidoId: p.pedido_id,
            pedidoGrupoId: p.pedido_grupo_id,
            latitude: p.latitude,
            longitude: p.longitude,
          })),
      }));
  }

  /** Persiste a sequência otimizada de paradas para uma rota (substitui as pendentes). */
  async function salvarSequencia(entregaRotaId, sequencia) {
    await supabase
      .from('rota_parada')
      .delete()
      .eq('entrega_rota_id', entregaRotaId)
      .eq('status', 'pendente');

    const linhas = sequencia.map((p, idx) => ({
      entrega_rota_id: entregaRotaId,
      tipo: p.tipo,
      pedido_id: p.tipo === 'coleta' ? p.pedidoId : null,
      pedido_grupo_id: p.tipo === 'entrega' ? p.pedidoGrupoId : null,
      latitude: p.latitude,
      longitude: p.longitude,
      ordem: idx,
      status: 'pendente',
    }));

    const { error } = await supabase.from('rota_parada').insert(linhas);
    if (error) throw error;
  }

  /** Dispara o push de buzina pro entregador — fire-and-forget (planejamento
   * FCM, 22/08/2026): busca o token na hora em vez de propagar por todo
   * lado, e nunca deixa uma falha de push interromper o despacho em si
   * (a oferta real já está no banco, chega via Realtime/polling de
   * qualquer forma). */
  async function notificarEntregadorPush(entregadorId) {
    try {
      const { data: entregador } = await supabase
        .from('entregadores')
        .select('push_token, push_plataforma')
        .eq('id', entregadorId)
        .single();
      if (entregador?.push_token) {
        await enviarPushBuzinaEntregador(entregador.push_token, entregador.push_plataforma);
      }
    } catch (err) {
      console.error('[push] falha ao notificar entregador (não bloqueia o despacho):', err.message);
    }
  }

  /** Cria uma proposta de consolidação numa rota JÁ 'em_rota' (aceita pelo
   * entregador), em vez de inserir direto — achado real, 22/08/2026: o
   * entregador nunca ficava sabendo de uma parada nova adicionada à força
   * numa rota que ele já tinha aceito. Peso/paradas da rota só refletem
   * o pedido depois que ele aceitar a proposta (aceitar_proposta_consolidacao
   * RPC) — uma proposta pendente não reserva capacidade. */
  async function criarPropostaConsolidacao(pedido, rota, sequenciaResultante) {
    const paradasNovas = [
      ...pedido.paradasColeta.map((c) => ({
        tipo: 'coleta', pedidoId: c.pedidoId, latitude: c.latitude, longitude: c.longitude,
      })),
      { tipo: 'entrega', pedidoGrupoId: pedido.pedidoGrupoId, latitude: pedido.paradaEntrega.latitude, longitude: pedido.paradaEntrega.longitude },
    ];

    const { data: proposta, error } = await supabase
      .from('proposta_consolidacao')
      .insert({
        entrega_rota_id: rota.entregaRotaId,
        pedido_grupo_id: pedido.pedidoGrupoId,
        entregador_id: rota.entregadorId,
        paradas_novas: paradasNovas,
        paradas_resultado: sequenciaResultante,
        peso_grupo: pedido.pesoTotal,
      })
      .select()
      .single();
    if (error) throw error;

    notificarEntregadorPush(rota.entregadorId); // fire-and-forget, ver comentário na função

    return proposta.id;
  }

  /** Abre uma rota nova. Se `entregadorIdForcado` for informado (rodízio
   * justo pra bike), usa esse entregador direto; senão busca o mais
   * próximo disponível dentro do raio do veículo dele. */
  async function abrirRotaNova(pedido, entregadorIdForcado = null) {
    let entregadorId = entregadorIdForcado;

    if (!entregadorId) {
      // FIX (achado real ao rodar o despacho de verdade, 22/08/2026):
      // buscar_entregador_mais_proximo() é `returns table(...)` — o
      // PostgREST devolve um ARRAY de linhas via RPC, não um objeto único
      // (o módulo original tratava `entregador.id` como se já fosse o
      // objeto, sempre `undefined`, o que inseria entregador_id=null e
      // quebrava a constraint NOT NULL de entrega_rota).
      const { data: entregadores, error: errEnt } = await supabase.rpc(
        'buscar_entregador_mais_proximo',
        { p_latitude: pedido.paradasColeta[0].latitude, p_longitude: pedido.paradasColeta[0].longitude }
      );
      if (errEnt) throw errEnt;
      const entregador = entregadores?.[0];
      if (!entregador) return null; // nenhum entregador disponível
      entregadorId = entregador.id;
    }

    const { data: rota, error } = await supabase
      .from('entrega_rota')
      .insert({ entregador_id: entregadorId, tipo_perfil: pedido.tipoPerfil, status: 'em_montagem' })
      .select()
      .single();
    if (error) throw error;

    await supabase
      .from('entrega_rota_grupo')
      .insert({ entrega_rota_id: rota.id, pedido_grupo_id: pedido.pedidoGrupoId });

    const paradas = [
      ...pedido.paradasColeta.map((c) => ({ ...c, tipo: 'coleta' })),
      { ...pedido.paradaEntrega, tipo: 'entrega' },
    ];
    await salvarSequencia(rota.id, paradas);

    notificarEntregadorPush(entregadorId); // fire-and-forget, ver comentário na função

    return rota.id;
  }

  /** Busca entregadores de bicicleta disponíveis (status 'disponivel') e SEM rota em montagem —
   * candidatos a receber oferta prioritária antes de o pedido ser oferecido pra consolidação em moto.
   *
   * FIX aplicado (bug real do módulo original): a checagem de "rota já em
   * andamento" filtrava `entrega_rota.tipo_veiculo`, coluna que não existe
   * nessa tabela (só `entregadores.tipo_veiculo` existe) — a query original
   * sempre voltava vazia/erro, então NENHUMA bike era considerada ocupada,
   * mesmo já estando numa rota. Corrigido fazendo o join até `entregadores`
   * pra checar o tipo de veículo do dono da rota, não da rota em si. */
  async function buscarBikesOciosas() {
    const { data: bikes, error } = await supabase
      .from('entregadores')
      .select('id, lat, lng')
      .eq('status', 'disponivel')
      .eq('tipo_veiculo', 'bicicleta')
      .eq('aceita_feira', true);
    if (error) throw error;

    // exclui bikes que já têm uma rota em_montagem em andamento
    const { data: rotasAtivas } = await supabase
      .from('entrega_rota')
      .select('entregador_id, entregadores(tipo_veiculo)')
      .eq('status', 'em_montagem');
    const ocupadas = new Set(
      (rotasAtivas || [])
        .filter((r) => r.entregadores?.tipo_veiculo === 'bicicleta')
        .map((r) => r.entregador_id)
    );

    return (bikes || [])
      .filter((b) => !ocupadas.has(b.id))
      .map((b) => ({ entregadorId: b.id, latitude: b.lat, longitude: b.lng }));
  }

  /**
   * Ponto de entrada principal: chame para cada pedido_grupo que acabou
   * de virar 'pronto_para_coleta'.
   */
  async function despacharPedido(pedidoGrupoId) {
    const pedido = await montarPedidoParaDispatch(pedidoGrupoId);

    // RODÍZIO JUSTO (achado da ultra-análise): antes de consolidar numa
    // rota de moto já em andamento, checa se existe bike ociosa elegível
    // dentro do raio dela — evita o padrão documentado de bike ficar
    // sem corrida porque o sistema sempre prefere "encaixar" na moto.
    const bikesOciosas = await buscarBikesOciosas();
    const decisaoJusta = priorizarOfertaJusta(pedido, bikesOciosas);

    if (decisaoJusta.estrategia === 'ofertar_bike_ociosa') {
      const novaRotaId = await abrirRotaNova(pedido, decisaoJusta.destino.entregadorId);
      return { entregaRotaId: novaRotaId, acao: 'ofertado_bike_ociosa_prioritaria' };
    }

    const config = await buscarConfig(pedido.tipoPerfil);
    const candidatas = await buscarRotasCandidatas(pedido.tipoPerfil);

    const melhor = encontrarMelhorInsercao(pedido, candidatas, config);

    if (melhor) {
      const { rota } = melhor;

      // FIX (achado real, 22/08/2026): rota 'em_rota' já foi ACEITA pelo
      // entregador — inserir direto tirava a decisão dele. Vira uma
      // proposta (aceitar/recusar), não um commit imediato. Rota ainda
      // 'em_montagem' continua com o comportamento antigo: o entregador
      // vê o lote inteiro consolidado numa única oferta antes de aceitar.
      if (rota.statusRota === 'em_rota') {
        const propostaId = await criarPropostaConsolidacao(pedido, rota, melhor.resultado.sequenciaResultante);
        return { entregaRotaId: rota.entregaRotaId, acao: 'proposta_consolidacao_criada', propostaId };
      }

      // insert atômico via função Postgres com advisory lock — evita
      // que dois pedidos ficando prontos ao mesmo tempo estourem o
      // peso da mesma rota antes de qualquer um confirmar
      const { data: resultado, error } = await supabase.rpc(
        'inserir_grupo_em_rota_atomico',
        { p_entrega_rota_id: rota.entregaRotaId, p_pedido_grupo_id: pedido.pedidoGrupoId }
      );
      if (error) throw error;

      if (!resultado.sucesso) {
        // outra inserção concorrente já ocupou o espaço de peso —
        // recalcula do zero em vez de falhar (rota pode ter mudado)
        return despacharPedido(pedidoGrupoId);
      }

      await salvarSequencia(rota.entregaRotaId, melhor.resultado.sequenciaResultante);

      return { entregaRotaId: rota.entregaRotaId, acao: 'inserido_em_rota_existente' };
    }

    const novaRotaId = await abrirRotaNova(pedido);
    return { entregaRotaId: novaRotaId, acao: 'rota_nova' };
  }

  /**
   * Job periódico: fecha rotas 'em_montagem' que estouraram o tempo máximo
   * de espera, mesmo sem estar cheias. Rodar via cron a cada ~30s.
   */
  async function fecharRotasExpiradas() {
    const { data: rotas, error } = await supabase
      .from('entrega_rota')
      .select('id, tipo_perfil, aberta_em')
      .eq('status', 'em_montagem');

    if (error) throw error;

    const configsPorPerfil = {};
    const agora = Date.now();
    const fechadas = [];

    for (const rota of rotas || []) {
      if (!configsPorPerfil[rota.tipo_perfil]) {
        configsPorPerfil[rota.tipo_perfil] = await buscarConfig(rota.tipo_perfil);
      }
      const config = configsPorPerfil[rota.tipo_perfil];
      const idadeSeg = (agora - new Date(rota.aberta_em).getTime()) / 1000;

      if (idadeSeg >= config.maxEsperaMontagemSeg) {
        await supabase
          .from('entrega_rota')
          .update({ status: 'em_rota', fechada_em: new Date().toISOString() })
          .eq('id', rota.id);
        fechadas.push(rota.id);
      }
    }

    return fechadas;
  }

  /**
   * Retorna a sequência de paradas de uma rota já agrupada por local
   * físico — bancas visitadas por mais de um cliente (ex: Maria e
   * Flávia comprando na mesma banca B) viram UMA parada consolidada
   * com os tickets de cada pedido, em vez de duas visitas separadas
   * à mesma banca.
   */
  async function buscarParadasAgrupadas(entregaRotaId) {
    const { data: paradasRaw, error } = await supabase
      .from('rota_parada')
      .select(
        `id, tipo, pedido_id, pedido_grupo_id, latitude, longitude, ordem, status,
         pedido:pedido_id (
           estabelecimento_id,
           estabelecimentos ( id, nome ),
           pedido_nota ( codigo_curto, nome_cliente )
         )`
      )
      .eq('entrega_rota_id', entregaRotaId)
      .order('ordem', { ascending: true });

    if (error) throw error;

    const paradasEnriquecidas = (paradasRaw || []).map((p) => ({
      id: p.id,
      tipo: p.tipo,
      pedidoId: p.pedido_id,
      pedidoGrupoId: p.pedido_grupo_id,
      latitude: p.latitude,
      longitude: p.longitude,
      local: p.pedido?.estabelecimentos?.nome,
      codigoTicket: p.pedido?.pedido_nota?.[0]?.codigo_curto,
      clienteNome: p.pedido?.pedido_nota?.[0]?.nome_cliente,
      status: p.status,
    }));

    return agruparParadasMesmoLocal(paradasEnriquecidas);
  }

  return {
    despacharPedido,
    fecharRotasExpiradas,
    montarPedidoParaDispatch,
    buscarConfig,
    buscarParadasAgrupadas,
  };
}

module.exports = { createRouteManager };
