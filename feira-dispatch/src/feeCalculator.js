'use strict';

const { otimizarRota } = require('./routeOptimizer');
const { distanciaKm } = require('./geo');

/**
 * Sem ponto de coleta único na feira, o entregador anda A PÉ entre as
 * bancas escolhidas pelo cliente, depois pega a moto/bike até o endereço
 * de entrega. Uma taxa fixa "por parada" é injusta pros dois lados:
 * bancas vizinhas pagam caro demais, bancas espalhadas pagam barato
 * demais. Este módulo calcula a taxa a partir da distância REAL.
 *
 * Componentes da taxa:
 *   1. base_deslocamento  — cobre ir até a feira e o esforço mínimo da corrida
 *   2. trecho_a_pe        — km andados dentro da feira entre bancas (taxa mais
 *                           alta por km, porque é mais lento e mais cansativo
 *                           que andar de moto/bike)
 *   3. trecho_ate_entrega — km da última banca até o endereço do cliente
 *                           (taxa de moto/bike, mais rápida)
 *   4. manuseio_por_banca — valor fixo por banca, independente da distância:
 *                           compensa o tempo de esperar o Pix, conferir o
 *                           ticket, cumprimentar o feirante — que existe
 *                           mesmo se as bancas forem vizinhas
 */

const CONFIG_PADRAO = {
  // baseDeslocamento removido daqui de propósito: não dá pra calcular
  // distância real até a feira no checkout (não se sabe ainda qual
  // entregador vai pegar a corrida). Esse componente virou um bônus
  // calculado com posição real no momento do aceite — ver arrivalBonus.js.
  // O cliente paga só pelo que é sempre real: manuseio + km reais.
  valorKmAPe: 2.5, // R$/km andado dentro da feira
  valorKmMoto: 2.5, // R$/km até o endereço de entrega — alinhado ao adicional do PL 2479/25 (R$2,50/km), antes estava em R$1,80
  manuseioPorBanca: 1.2, // R$ por banca visitada, fixo
  taxaMinima: 6.0, // piso — nunca cobra menos que isso, mesmo pra 1 banca pertinho
};

/**
 * @param {Array} bancas - [{ estabelecimentoId, latitude, longitude }]
 *   `latitude/longitude` já devem vir resolvidos (banca real, com fallback
 *   pro endereço cadastral se a posição exata não tiver sido marcada).
 * @param {{latitude:number, longitude:number}} enderecoEntrega
 * @param {Object} [config] - sobrescreve CONFIG_PADRAO parcialmente
 */
function calcularTaxaJusta(bancas, enderecoEntrega, config = {}) {
  const cfg = { ...CONFIG_PADRAO, ...config };

  if (!bancas || bancas.length === 0) {
    throw new Error('calcularTaxaJusta: pelo menos uma banca é necessária');
  }

  // ordena as bancas pela rota mais curta entre elas (nearest neighbor + 2-opt
  // já implementado no routeOptimizer), partindo da primeira banca da lista
  const paradasColeta = bancas.map((b, idx) => ({
    id: `banca-${idx}`,
    tipo: 'coleta',
    pedidoId: b.estabelecimentoId,
    pedidoGrupoId: 'calculo-taxa',
    latitude: b.latitude,
    longitude: b.longitude,
  }));

  const paradaEntrega = {
    id: 'entrega',
    tipo: 'entrega',
    pedidoGrupoId: 'calculo-taxa',
    latitude: enderecoEntrega.latitude,
    longitude: enderecoEntrega.longitude,
  };

  const { sequencia } = otimizarRota(
    [...paradasColeta, paradaEntrega],
    { latitude: bancas[0].latitude, longitude: bancas[0].longitude }
  );

  // soma as distâncias coleta->coleta (trecho a pé dentro da feira)
  let trechoAPeKm = 0;
  let trechoAteEntregaKm = 0;

  for (let i = 0; i < sequencia.length - 1; i++) {
    const atual = sequencia[i];
    const proximo = sequencia[i + 1];
    const d = distanciaKm(atual, proximo);

    if (atual.tipo === 'coleta' && proximo.tipo === 'coleta') {
      trechoAPeKm += d;
    } else if (proximo.tipo === 'entrega') {
      trechoAteEntregaKm += d;
    }
  }

  const custoAPe = trechoAPeKm * cfg.valorKmAPe;
  const custoMoto = trechoAteEntregaKm * cfg.valorKmMoto;
  const custoManuseio = bancas.length * cfg.manuseioPorBanca;

  const totalCalculado = custoAPe + custoMoto + custoManuseio;
  const taxaFinal = Math.max(totalCalculado, cfg.taxaMinima);

  return {
    taxaFinal: Number(taxaFinal.toFixed(2)),
    detalhamento: {
      trechoAPeKm: Number(trechoAPeKm.toFixed(3)),
      custoAPe: Number(custoAPe.toFixed(2)),
      trechoAteEntregaKm: Number(trechoAteEntregaKm.toFixed(3)),
      custoMoto: Number(custoMoto.toFixed(2)),
      qtdBancas: bancas.length,
      custoManuseio: Number(custoManuseio.toFixed(2)),
      aplicouPisoMinimo: totalCalculado < cfg.taxaMinima,
    },
    sequenciaColeta: sequencia.filter((p) => p.tipo === 'coleta').map((p) => p.pedidoId),
  };
}

module.exports = { calcularTaxaJusta, CONFIG_PADRAO };
