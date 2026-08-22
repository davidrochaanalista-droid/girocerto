'use strict';

const { validarAlcanceVeiculo, raioEntregaMaximoDaFrota } = require('../vehicleRules');
const { calcularTaxaJusta } = require('../feeCalculator');
const { calcularBonusChegada } = require('../arrivalBonus');
const { createCheckoutValidator } = require('../checkout');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALHOU:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// =======================================================================
// 1. Raios de coleta — moto até 1,5km, bicicleta até 0,8km
// =======================================================================
console.log('--- Raio de coleta ---');

const dentroMoto = validarAlcanceVeiculo({
  tipoVeiculo: 'moto', tipoPerfil: 'feira',
  distanciaColetaKm: 1.2, distanciaEntregaKm: 3, pesoKg: 5,
});
assert(dentroMoto.valido, 'moto aceita coleta a 1,2km (dentro do limite de 1,5km)');

const foraMoto = validarAlcanceVeiculo({
  tipoVeiculo: 'moto', tipoPerfil: 'feira',
  distanciaColetaKm: 1.8, distanciaEntregaKm: 3, pesoKg: 5,
});
assert(!foraMoto.valido, 'moto rejeita coleta a 1,8km (acima do limite de 1,5km)');
console.log('  motivo:', foraMoto.motivos[0]);

const dentroBike = validarAlcanceVeiculo({
  tipoVeiculo: 'bicicleta', tipoPerfil: 'feira',
  distanciaColetaKm: 0.6, distanciaEntregaKm: 1.5, pesoKg: 3,
});
assert(dentroBike.valido, 'bicicleta aceita coleta a 0,6km (dentro do limite de 0,8km)');

const foraBike = validarAlcanceVeiculo({
  tipoVeiculo: 'bicicleta', tipoPerfil: 'feira',
  distanciaColetaKm: 1.0, distanciaEntregaKm: 1.5, pesoKg: 3,
});
assert(!foraBike.valido, 'bicicleta rejeita coleta a 1,0km (acima do limite de 0,8km)');

// =======================================================================
// 2. Raios de entrega — moto: 8km feira / 6km restaurante | bike: 2km
// =======================================================================
console.log('\n--- Raio de entrega ---');

const motoFeiraOk = validarAlcanceVeiculo({
  tipoVeiculo: 'moto', tipoPerfil: 'feira', distanciaColetaKm: 1, distanciaEntregaKm: 7.5, pesoKg: 5,
});
assert(motoFeiraOk.valido, 'moto entrega feira a 7,5km está dentro do limite de 8km');

const motoFeiraFora = validarAlcanceVeiculo({
  tipoVeiculo: 'moto', tipoPerfil: 'feira', distanciaColetaKm: 1, distanciaEntregaKm: 8.5, pesoKg: 5,
});
assert(!motoFeiraFora.valido, 'moto entrega feira a 8,5km excede o limite de 8km');

const motoRestauranteFora = validarAlcanceVeiculo({
  tipoVeiculo: 'moto', tipoPerfil: 'restaurante', distanciaColetaKm: 1, distanciaEntregaKm: 6.5, pesoKg: 5,
});
assert(
  !motoRestauranteFora.valido,
  'moto entrega RESTAURANTE a 6,5km excede o limite de 6km (mais apertado que feira, mesma moto)'
);

const bikeEntregaFora = validarAlcanceVeiculo({
  tipoVeiculo: 'bicicleta', tipoPerfil: 'feira', distanciaColetaKm: 0.5, distanciaEntregaKm: 2.5, pesoKg: 3,
});
assert(!bikeEntregaFora.valido, 'bicicleta rejeita entrega a 2,5km (acima do limite de 2km)');

// =======================================================================
// 3. Peso máximo diferenciado — moto 15kg, bicicleta 5kg
// =======================================================================
console.log('\n--- Peso máximo por veículo ---');

const bikePesada = validarAlcanceVeiculo({
  tipoVeiculo: 'bicicleta', tipoPerfil: 'feira', distanciaColetaKm: 0.3, distanciaEntregaKm: 1, pesoKg: 8,
});
assert(!bikePesada.valido, 'bicicleta rejeita 8kg (acima do limite de 5kg dela)');

const motoComMesmoPeso = validarAlcanceVeiculo({
  tipoVeiculo: 'moto', tipoPerfil: 'feira', distanciaColetaKm: 0.3, distanciaEntregaKm: 1, pesoKg: 8,
});
assert(motoComMesmoPeso.valido, 'moto aceita os mesmos 8kg sem problema (limite de 15kg)');

// =======================================================================
// 4. Checkout: rejeita endereço fora do alcance de QUALQUER veículo da frota
// =======================================================================
console.log('\n--- Validação no checkout (raio máximo da frota) ---');
const checkoutValidator = createCheckoutValidator({});

const dentroDaFrota = checkoutValidator.validarAlcanceMaximo(7, 'feira');
assert(dentroDaFrota.valido, '7km está dentro do raio máximo da frota pra feira (moto cobre até 8km)');

const foraDaFrota = checkoutValidator.validarAlcanceMaximo(10, 'feira');
assert(
  !foraDaFrota.valido,
  '10km está fora do raio máximo de QUALQUER veículo da frota — pedido rejeitado no checkout, antes de gerar rota'
);
console.log('  mensagem:', foraDaFrota.mensagem);

// =======================================================================
// 5. As duas taxas juntas — deslocamento (bônus, plataforma) + entrega
// (cliente) — confirmando que ambas continuam sendo cobradas, como pedido
// =======================================================================
console.log('\n--- As duas taxas cobradas juntas ---');
const banca = { latitude: -23.5000, longitude: -46.6200 };
const enderecoCliente = { latitude: -23.5080, longitude: -46.6260 };
const posicaoEntregadorMoto = { latitude: -23.4900, longitude: -46.6100 };

const taxaEntrega = calcularTaxaJusta([{ estabelecimentoId: 'banca-1', ...banca }], enderecoCliente);
const taxaDeslocamento = calcularBonusChegada(posicaoEntregadorMoto, banca);

const ganhoTotalEntregador = taxaEntrega.taxaFinal + taxaDeslocamento.bonus;

console.log(`Taxa de entrega (paga pelo cliente): R$${taxaEntrega.taxaFinal.toFixed(2)}`);
console.log(`Taxa de deslocamento até a feira (paga pela plataforma): R$${taxaDeslocamento.bonus.toFixed(2)}`);
console.log(`GANHO TOTAL DO ENTREGADOR: R$${ganhoTotalEntregador.toFixed(2)}`);

assert(taxaEntrega.taxaFinal > 0, 'taxa de entrega calculada e cobrada');
assert(taxaDeslocamento.bonus > 0, 'taxa de deslocamento calculada e cobrada');
assert(
  ganhoTotalEntregador === Number((taxaEntrega.taxaFinal + taxaDeslocamento.bonus).toFixed(2)),
  'as duas taxas se somam corretamente no ganho final do entregador'
);

console.log('\nTestes de regras por veículo concluídos.');
