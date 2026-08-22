'use strict';

const { distanciaKm, distanciaTotalRota } = require('./geo');

/**
 * Parada esperada no formato:
 * {
 *   id, tipo: 'coleta' | 'entrega',
 *   pedidoId, pedidoGrupoId,
 *   latitude, longitude
 * }
 *
 * Regra de precedência: para cada pedidoId, a parada 'coleta' precisa
 * aparecer antes de QUALQUER 'entrega' do pedido_grupo ao qual pertence
 * (não dá pra entregar o que ainda não foi coletado).
 */

/** Mapa pedidoGrupoId -> lista de pedidoIds que precisam ser coletados antes. */
function construirDependencias(paradas) {
  const dependencias = new Map(); // pedidoGrupoId -> Set(pedidoId ainda não coletado)
  for (const p of paradas) {
    if (p.tipo === 'coleta') {
      if (!dependencias.has(p.pedidoGrupoId)) dependencias.set(p.pedidoGrupoId, new Set());
      dependencias.get(p.pedidoGrupoId).add(p.pedidoId);
    }
  }
  return dependencias;
}

/** Verifica se uma sequência respeita a precedência coleta->entrega. */
function sequenciaValida(sequencia) {
  const coletados = new Set();
  for (const p of sequencia) {
    if (p.tipo === 'coleta') {
      coletados.add(p.pedidoId);
    } else {
      // toda coleta do mesmo pedido_grupo precisa ter sido feita antes
      const irmaos = sequencia.filter(
        (x) => x.tipo === 'coleta' && x.pedidoGrupoId === p.pedidoGrupoId
      );
      for (const irmao of irmaos) {
        if (!coletados.has(irmao.pedidoId)) return false;
      }
    }
  }
  return true;
}

/** Nearest neighbor guloso respeitando precedência básica (coletas primeiro quando empatam). */
function nearestNeighbor(paradas, posicaoInicial) {
  const restantes = [...paradas];
  const sequencia = [];
  let atual = posicaoInicial;
  const coletados = new Set();

  while (restantes.length > 0) {
    // candidatos elegíveis agora: coletas sempre elegíveis;
    // entregas só se todas as coletas do mesmo pedido_grupo já saíram da lista
    const elegiveis = restantes.filter((p) => {
      if (p.tipo === 'coleta') return true;
      const pendentesDoGrupo = restantes.some(
        (x) => x.tipo === 'coleta' && x.pedidoGrupoId === p.pedidoGrupoId
      );
      return !pendentesDoGrupo;
    });

    const pool = elegiveis.length > 0 ? elegiveis : restantes;

    let melhor = pool[0];
    let melhorDist = distanciaKm(atual, melhor);
    for (const cand of pool.slice(1)) {
      const d = distanciaKm(atual, cand);
      if (d < melhorDist) {
        melhor = cand;
        melhorDist = d;
      }
    }

    sequencia.push(melhor);
    if (melhor.tipo === 'coleta') coletados.add(melhor.pedidoId);
    atual = melhor;
    restantes.splice(restantes.indexOf(melhor), 1);
  }

  return sequencia;
}

/** 2-opt: tenta trocar pares de arestas se reduzir distância total, descartando trocas inválidas. */
function twoOpt(sequenciaInicial, posicaoInicial, maxIteracoes = 200) {
  let sequencia = [...sequenciaInicial];
  let melhorou = true;
  let iteracoes = 0;

  while (melhorou && iteracoes < maxIteracoes) {
    melhorou = false;
    iteracoes++;

    for (let i = 0; i < sequencia.length - 1; i++) {
      for (let j = i + 1; j < sequencia.length; j++) {
        const candidata = [
          ...sequencia.slice(0, i),
          ...sequencia.slice(i, j + 1).reverse(),
          ...sequencia.slice(j + 1),
        ];

        if (!sequenciaValida(candidata)) continue;

        const distAtual = distanciaTotalRota(sequencia, posicaoInicial);
        const distCandidata = distanciaTotalRota(candidata, posicaoInicial);

        if (distCandidata < distAtual - 1e-6) {
          sequencia = candidata;
          melhorou = true;
        }
      }
    }
  }

  return sequencia;
}

/**
 * Otimiza a sequência completa de paradas de uma rota.
 * @param {Array} paradas - paradas de coleta e entrega
 * @param {{latitude:number, longitude:number}} posicaoInicial - posição atual do entregador
 * @returns {{sequencia: Array, distanciaKm: number}}
 */
function otimizarRota(paradas, posicaoInicial) {
  if (paradas.length === 0) {
    return { sequencia: [], distanciaKm: 0 };
  }

  let sequencia = nearestNeighbor(paradas, posicaoInicial);
  sequencia = twoOpt(sequencia, posicaoInicial);

  return {
    sequencia,
    distanciaKm: distanciaTotalRota(sequencia, posicaoInicial),
  };
}

module.exports = { otimizarRota, sequenciaValida, construirDependencias };
