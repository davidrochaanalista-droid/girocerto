// Vagas de entregador (item 119, 18/09/2026, pedido direto do usuário) —
// loja publica vaga de vínculo fixo (local, dia da semana, período,
// diária, taxa opcional), qualquer entregador logado vê vagas abertas de
// qualquer loja e pode aceitar. Aceitar cria (ou reaproveita) o vínculo
// `entregadores` com a loja, força tipo_vinculo='fixo', e registra o
// turno específico em `entregador_turno_fixo` -- tudo isso a partir do
// momento em que aceita, atômico (2 entregadores não conseguem aceitar a
// mesma vaga).
const crypto = require('crypto');
const { newPgClient, createAuthUser, signInAs, criarEntregador, makeReporter, cleanup } = require('./lib/helpers');

async function run() {
  const r = makeReporter('vagas_entregador');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Vagas')`, [tenantId]);
    tenantIds.push(tenantId);

    const dono = await createAuthUser('dono.vagas');
    authUserIds.push(dono.id);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, dono.id]);
    const sessDono = await signInAs(dono.email);

    const outroTenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1,'Loja Teste Vagas Outra')`, [outroTenantId]);
    tenantIds.push(outroTenantId);
    const outroDono = await createAuthUser('outro.dono.vagas');
    authUserIds.push(outroDono.id);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Outro Dono','dono')`, [outroTenantId, outroDono.id]);
    const sessOutroDono = await signInAs(outroDono.email);

    console.log('\n=== loja publica vaga (RLS de insert/select) ===');
    let vagaId;
    {
      const { data: vaga, error } = await sessDono.from('vagas_entregador').insert({
        tenant_id: tenantId, local: 'Rua das Vagas, 123', dia_semana: 1, periodo: 'manha',
        horario_inicio: '08:00', horario_fim: '12:00', valor_diaria: 90, taxa_entrega: 3.5,
      }).select().single();
      r.check('dono consegue publicar vaga da própria loja', !error && !!vaga, error || vaga);
      vagaId = vaga?.id;

      const { error: errOutro } = await sessOutroDono.from('vagas_entregador').insert({
        tenant_id: tenantId, local: 'Tentativa de outra loja', dia_semana: 2, periodo: 'tarde', valor_diaria: 50,
      });
      r.check('dono de OUTRA loja não consegue publicar vaga pra esse tenant (RLS bloqueia)', !!errOutro, errOutro);
    }

    console.log('\n=== entregador enxerga vaga aberta de qualquer loja ===');
    const uEntregador = await createAuthUser('entregador.vagas');
    authUserIds.push(uEntregador.id);
    // entregador SEM nenhum vínculo com nenhuma loja ainda -- só o cadastro
    // de pessoa, pra provar que aceitar_vaga_entregador cria o vínculo do zero.
    await pg.query(`insert into pessoas_entregadoras (auth_user_id, nome) values ($1,'Entregador Vagas')`, [uEntregador.id]);
    const sessEntregador = await signInAs(uEntregador.email);
    {
      const { data: vagasVisiveis, error } = await sessEntregador.from('vagas_entregador').select('*').eq('id', vagaId);
      r.check('entregador sem vínculo nenhum ainda consegue ver a vaga aberta (RLS de select ampla)', !error && vagasVisiveis?.length === 1, { error, vagasVisiveis });
    }

    console.log('\n=== aceitar vaga: cria vínculo do zero, força fixo, cria turno ===');
    {
      const { data: entregadorId, error } = await sessEntregador.rpc('aceitar_vaga_entregador', { p_vaga_id: vagaId });
      r.check('aceitar_vaga_entregador() roda sem erro e devolve o id do vínculo', !error && !!entregadorId, error || entregadorId);

      const { rows: [vinculo] } = await pg.query(`select tenant_id, tipo_vinculo, valor_fixo, periodicidade_fixo from entregadores where id = $1`, [entregadorId]);
      r.check('vínculo criado na loja certa, já como fixo, com a diária da vaga', vinculo && vinculo.tenant_id === tenantId && vinculo.tipo_vinculo === 'fixo' && Number(vinculo.valor_fixo) === 90 && vinculo.periodicidade_fixo === 'diaria', vinculo);

      const { rows: [turno] } = await pg.query(`select dia_semana, periodo, valor_diaria, taxa_entrega, ativo, vaga_id from entregador_turno_fixo where entregador_id = $1`, [entregadorId]);
      r.check('turno fixo registrado com dia/período/valores certos, ativo, ligado à vaga', turno && turno.dia_semana === 1 && turno.periodo === 'manha' && Number(turno.valor_diaria) === 90 && Number(turno.taxa_entrega) === 3.5 && turno.ativo === true && turno.vaga_id === vagaId, turno);

      const { rows: [vagaAtualizada] } = await pg.query(`select status, entregador_id, preenchida_em from vagas_entregador where id = $1`, [vagaId]);
      r.check('vaga vira preenchida, com o entregador certo e preenchida_em setado', vagaAtualizada.status === 'preenchida' && vagaAtualizada.entregador_id === entregadorId && !!vagaAtualizada.preenchida_em, vagaAtualizada);
    }

    console.log('\n=== vaga já preenchida não pode ser aceita de novo ===');
    {
      const uSegundo = await createAuthUser('segundo.entregador.vagas');
      authUserIds.push(uSegundo.id);
      await pg.query(`insert into pessoas_entregadoras (auth_user_id, nome) values ($1,'Segundo Entregador')`, [uSegundo.id]);
      const sessSegundo = await signInAs(uSegundo.email);

      const { error: errDuplo } = await sessSegundo.rpc('aceitar_vaga_entregador', { p_vaga_id: vagaId });
      r.check('segundo entregador NÃO consegue aceitar vaga já preenchida', !!errDuplo, errDuplo);

      const { data: vagasAbertasDepois } = await sessSegundo.from('vagas_entregador').select('id').eq('status', 'aberta').eq('id', vagaId);
      r.check('vaga preenchida some da listagem de abertas', (vagasAbertasDepois || []).length === 0, vagasAbertasDepois);
    }

    console.log('\n=== entregador já fixo em outro turno no mesmo dia/período não pode aceitar outra vaga colidente ===');
    {
      const { data: vaga2, error: errPublicar2 } = await sessDono.from('vagas_entregador').insert({
        tenant_id: tenantId, local: 'Outra vaga, mesmo dia/período', dia_semana: 1, periodo: 'manha', valor_diaria: 70,
      }).select().single();
      r.check('loja publica uma 2ª vaga (mesmo dia/período, propositalmente)', !errPublicar2 && !!vaga2, errPublicar2);

      // o mesmo entregador da primeira vaga (já fixo segunda de manhã) tenta
      // aceitar essa outra vaga que colide no dia_semana+periodo.
      const { error: errColisao } = await sessEntregador.rpc('aceitar_vaga_entregador', { p_vaga_id: vaga2.id });
      r.check('entregador que já tem turno fixo nesse dia/período NÃO consegue aceitar outra vaga colidente', !!errColisao, errColisao);
    }

    console.log('\n=== turno fixo: RLS (entregador vê o seu, loja vê o dos seus, ninguém mais vê) ===');
    {
      const { data: turnoDoEntregador, error: e1 } = await sessEntregador.from('entregador_turno_fixo').select('*');
      r.check('entregador vê o próprio turno fixo', !e1 && turnoDoEntregador?.length >= 1, { e1, turnoDoEntregador });

      const { data: turnoParaLoja, error: e2 } = await sessDono.from('entregador_turno_fixo').select('*');
      r.check('loja vê o turno fixo do entregador vinculado a ela', !e2 && turnoParaLoja?.length >= 1, { e2, turnoParaLoja });

      const { data: turnoParaOutraLoja } = await sessOutroDono.from('entregador_turno_fixo').select('*');
      r.check('OUTRA loja (sem esse entregador) não vê o turno', (turnoParaOutraLoja || []).length === 0, turnoParaOutraLoja);
    }

    return r.summary();
  } finally {
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
