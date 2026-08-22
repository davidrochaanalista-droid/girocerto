'use strict';

const { raioEntregaMaximoDaFrota } = require('./vehicleRules');

/**
 * Validações a rodar no momento do checkout, antes de persistir o
 * pedido_grupo definitivo — evita carrinho abaixo do mínimo da feira
 * e evita aceitar pedido que nenhum veículo da frota conseguiria entregar.
 */
function createCheckoutValidator(supabase) {
  async function validarValorMinimo(feiraOcorrenciaId, valorTotalProdutos) {
    const { data, error } = await supabase
      .from('feira_ocorrencia')
      .select('feira_id, feira:feira_id(valor_minimo_pedido, nome)')
      .eq('id', feiraOcorrenciaId)
      .single();

    if (error) throw error;

    const minimo = Number(data.feira.valor_minimo_pedido);

    if (valorTotalProdutos < minimo) {
      return {
        valido: false,
        minimo,
        atual: valorTotalProdutos,
        faltam: Number((minimo - valorTotalProdutos).toFixed(2)),
        mensagem: `Pedido abaixo do mínimo de ${data.feira.nome} (mínimo: R$${minimo.toFixed(
          2
        )}, faltam R$${(minimo - valorTotalProdutos).toFixed(2)})`,
      };
    }

    return { valido: true, minimo, atual: valorTotalProdutos };
  }

  /**
   * Rejeita o pedido se a distância até o endereço de entrega excede o
   * que QUALQUER veículo da frota consegue cobrir (hoje, moto: 8km
   * feira / 6km restaurante — o maior raio disponível). Não adianta
   * aceitar o pedido no checkout se nenhum entregador vai conseguir
   * pegar a corrida depois.
   */
  function validarAlcanceMaximo(distanciaEntregaKm, tipoPerfil) {
    const raioMaximo = raioEntregaMaximoDaFrota(tipoPerfil);
    if (distanciaEntregaKm > raioMaximo) {
      return {
        valido: false,
        raioMaximo,
        distanciaEntregaKm,
        mensagem: `Endereço a ${distanciaEntregaKm.toFixed(
          2
        )}km está fora da área de entrega (máximo ${raioMaximo}km para ${tipoPerfil})`,
      };
    }
    return { valido: true, raioMaximo, distanciaEntregaKm };
  }

  return { validarValorMinimo, validarAlcanceMaximo };
}

module.exports = { createCheckoutValidator };
