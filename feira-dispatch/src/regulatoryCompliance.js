'use strict';

/**
 * PL 2479/25 (governo federal, em tramitação): piso de R$10 até 4km +
 * R$2,50/km excedente. Ainda não é lei, mas construir em conformidade
 * agora evita retrabalho quando (se) aprovar — e já é um piso mais justo
 * que o R$6 fixo que tínhamos antes.
 *
 * Este módulo NÃO substitui o feeCalculator.js (que calcula por
 * componentes reais: manuseio + km a pé + km moto) — ele funciona como
 * uma trava final: pega o total calculado e garante que nunca fica
 * abaixo do que a regulação propõe pra mesma distância total.
 */

const PISO_REGULATORIO_PADRAO = {
  valorBase: 10.0,
  kmBase: 4.0,
  valorKmAdicional: 2.5,
  valorMinutoEspera: 0.6,
};

/** Piso de referência pra uma distância total (trecho a pé + trecho até o cliente). */
function calcularPisoRegulatorio(distanciaTotalKm, config = {}) {
  const cfg = { ...PISO_REGULATORIO_PADRAO, ...config };
  const excedente = Math.max(distanciaTotalKm - cfg.kmBase, 0);
  return Number((cfg.valorBase + excedente * cfg.valorKmAdicional).toFixed(2));
}

/**
 * Aplica o piso regulatório sobre o resultado do feeCalculator —
 * se a taxa calculada por componentes reais ficar abaixo do piso de
 * referência, sobe pra ele. Nunca desce (o cliente nunca paga menos
 * por causa dessa trava, só potencialmente mais, e sempre em favor
 * do entregador).
 */
function aplicarPisoRegulatorio(resultadoTaxaJusta, config = {}) {
  const distanciaTotal =
    resultadoTaxaJusta.detalhamento.trechoAPeKm + resultadoTaxaJusta.detalhamento.trechoAteEntregaKm;
  const piso = calcularPisoRegulatorio(distanciaTotal, config);

  const taxaAjustada = Math.max(resultadoTaxaJusta.taxaFinal, piso);

  return {
    ...resultadoTaxaJusta,
    taxaFinal: Number(taxaAjustada.toFixed(2)),
    detalhamento: {
      ...resultadoTaxaJusta.detalhamento,
      pisoRegulatorio: piso,
      aplicouPisoRegulatorio: taxaAjustada > resultadoTaxaJusta.taxaFinal,
    },
  };
}

/** Compensação por tempo de espera parado (feirante demorando, cliente demorando). */
function calcularCompensacaoEspera(segundosEspera, config = {}) {
  const cfg = { ...PISO_REGULATORIO_PADRAO, ...config };
  const minutos = segundosEspera / 60;
  return Number((minutos * cfg.valorMinutoEspera).toFixed(2));
}

module.exports = {
  calcularPisoRegulatorio,
  aplicarPisoRegulatorio,
  calcularCompensacaoEspera,
  PISO_REGULATORIO_PADRAO,
};
