'use strict';

/**
 * Regras confirmadas:
 *   Moto:      coleta até 1,5km · entrega até 8km (feira) / 6km (restaurante) · até 15kg
 *   Bicicleta: coleta até 0,8km · entrega até 2km (ambos os perfis)          · até 5kg
 */
const REGRAS_VEICULO = {
  moto: {
    raioColetaKm: 1.5,
    pesoMaxKg: 15,
    raioEntregaKm: { feira: 8, restaurante: 6, misto: 6 },
  },
  bicicleta: {
    raioColetaKm: 0.8,
    pesoMaxKg: 5,
    raioEntregaKm: { feira: 2, restaurante: 2, misto: 2 },
  },
};

function regrasDoVeiculo(tipoVeiculo) {
  const regra = REGRAS_VEICULO[tipoVeiculo];
  if (!regra) throw new Error(`Tipo de veículo desconhecido: ${tipoVeiculo}`);
  return regra;
}

/** Distância máxima de entrega que QUALQUER veículo da frota suporta —
 * usado no checkout pra rejeitar pedido que nenhum entregador conseguiria
 * atender, independente de quem pegar a corrida depois. */
function raioEntregaMaximoDaFrota(tipoPerfil) {
  return Math.max(...Object.values(REGRAS_VEICULO).map((r) => r.raioEntregaKm[tipoPerfil] ?? 0));
}

/**
 * Valida se um entregador específico (pelo veículo) pode atender essa
 * combinação de distância até a coleta e distância até a entrega.
 */
function validarAlcanceVeiculo({ tipoVeiculo, tipoPerfil, distanciaColetaKm, distanciaEntregaKm, pesoKg }) {
  const regra = regrasDoVeiculo(tipoVeiculo);
  const raioEntrega = regra.raioEntregaKm[tipoPerfil] ?? regra.raioEntregaKm.misto;

  const motivos = [];
  if (distanciaColetaKm > regra.raioColetaKm) {
    motivos.push(
      `coleta a ${distanciaColetaKm.toFixed(2)}km excede o raio de ${regra.raioColetaKm}km do ${tipoVeiculo}`
    );
  }
  if (distanciaEntregaKm > raioEntrega) {
    motivos.push(
      `entrega a ${distanciaEntregaKm.toFixed(2)}km excede o raio de ${raioEntrega}km do ${tipoVeiculo} (${tipoPerfil})`
    );
  }
  if (pesoKg > regra.pesoMaxKg) {
    motivos.push(`peso de ${pesoKg}kg excede o máximo de ${regra.pesoMaxKg}kg do ${tipoVeiculo}`);
  }

  return { valido: motivos.length === 0, motivos };
}

module.exports = { REGRAS_VEICULO, regrasDoVeiculo, raioEntregaMaximoDaFrota, validarAlcanceVeiculo };
