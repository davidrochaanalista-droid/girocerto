// Onboarding: cadastro de loja, cadastro de entregador (moto e bicicleta,
// incluindo menor de idade com responsável), aprovação/reprovação manual.
// Reprovação automática por documento vencido NÃO é testada aqui — não existe
// nenhum trigger/função no schema nem lógica no app que implemente isso hoje
// (confirmado por grep em db/schema.sql e mockups/app-entregador.html); ver
// tests/COBERTURA.md.
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup } = require('./lib/helpers');

async function run() {
  const r = makeReporter('onboarding');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    console.log('\n=== Cadastro completo de loja (id gerado no cliente, insert em tenants + usuarios_loja dono) ===');
    {
      const donoUser = await createAuthUser('dono.onboarding');
      authUserIds.push(donoUser.id);
      const sess = await signInAs(donoUser.email);

      // mesmo padrão do cadastro-loja.html real: id gerado no cliente (crypto.randomUUID())
      // pra evitar o bug de snapshot MVCC documentado no CLAUDE.md (.insert().select() falha).
      const tenantId = crypto.randomUUID();
      const { error: eTenant } = await sess.from('tenants').insert({
        id: tenantId,
        nome: 'Loja Teste Onboarding',
        proprietario_nome: 'Fulano de Tal',
        proprietario_cpf: '00000000000',
        cnpj: '00000000000100',
        segmento: 'hamburgueria',
        tempo_preparo_padrao_min: 20,
        consentimento_lgpd_aceito_em: new Date().toISOString(),
      });
      r.check('insert em tenants (6 passos simulados: dados loja+proprietário+segmento) funciona com id client-side', !eTenant, eTenant);

      const { error: eVinculo } = await sess.from('usuarios_loja').insert({
        tenant_id: tenantId, auth_user_id: donoUser.id, nome: 'Fulano', papel: 'dono',
      });
      r.check('vínculo usuarios_loja como dono (primeiro vínculo do tenant) funciona', !eVinculo, eVinculo);
      if (!eTenant) tenantIds.push(tenantId);

      // segundo dono tentando se auto-vincular ao MESMO tenant deve falhar (RLS: só o primeiro vínculo)
      const outroUser = await createAuthUser('dono2.onboarding');
      authUserIds.push(outroUser.id);
      const sess2 = await signInAs(outroUser.email);
      const { error: eVinculo2, data: dVinculo2 } = await sess2.from('usuarios_loja')
        .insert({ tenant_id: tenantId, auth_user_id: outroUser.id, nome: 'Intruso', papel: 'dono' })
        .select('id');
      r.check('segundo auto-vínculo no mesmo tenant é bloqueado (tenant_ja_tem_usuario)', !!eVinculo2 || !dVinculo2 || dVinculo2.length === 0, { eVinculo2, dVinculo2 });
    }

    console.log('\n=== Cadastro completo de entregador — MOTO ===');
    let motoId;
    {
      const motoUser = await createAuthUser('moto.onboarding');
      authUserIds.push(motoUser.id);
      const sess = await signInAs(motoUser.email);
      const tenantId = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1, 'Loja pra Entregador Moto')`, [tenantId]);
      tenantIds.push(tenantId);

      const { data, error } = await sess.from('entregadores').insert({
        tenant_id: tenantId, auth_user_id: motoUser.id, nome: 'Motoboy Moto',
        tipo_veiculo: 'moto', data_nascimento: '1990-01-01',
        cpf: '11111111111', cnh_numero: '123456789', cnh_validade: '2030-01-01',
        crlv_validade: '2030-01-01', placa: 'ABC1D23',
        status_verificacao: 'em_avaliacao',
      }).select('id').single();
      r.check('cadastro de entregador moto (CNH/CRLV/placa) funciona', !error && data, error);
      motoId = data && data.id;
    }

    console.log('\n=== Cadastro completo de entregador — BICICLETA, menor de 18 com responsável ===');
    {
      const bikeUser = await createAuthUser('bike.onboarding');
      authUserIds.push(bikeUser.id);
      const sess = await signInAs(bikeUser.email);
      const tenantId = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1, 'Loja pra Entregador Bike')`, [tenantId]);
      tenantIds.push(tenantId);

      const dataNascMenor = new Date();
      dataNascMenor.setFullYear(dataNascMenor.getFullYear() - 16); // 16 anos

      const { data, error } = await sess.from('entregadores').insert({
        tenant_id: tenantId, auth_user_id: bikeUser.id, nome: 'Entregador Bike Menor',
        tipo_veiculo: 'bicicleta', data_nascimento: dataNascMenor.toISOString().slice(0, 10),
        rg_numero: '222222222', foto_rg_url: 'https://exemplo/rg.jpg',
        foto_rg_segurando_url: 'https://exemplo/selfie.jpg', foto_bicicleta_url: 'https://exemplo/bike.jpg',
        responsavel_nome: 'Responsável Legal', responsavel_documento_foto_url: 'https://exemplo/resp.jpg',
        status_verificacao: 'em_avaliacao',
      }).select('id').single();
      r.check('cadastro de entregador bicicleta menor de 18 com dados do responsável funciona', !error && data, error);
      r.check(
        'NOTA: banco não tem CHECK/trigger de faixa etária (15–18 = só bicicleta) — só documentado em comentário, não é enforced. Não é falha do teste, é limitação real.',
        true
      );
    }

    console.log('\n=== Aprovação/reprovação manual — loja NÃO consegue via RLS direto (by design), service role consegue ===');
    if (motoId) {
      const donoUser = await createAuthUser('dono.aprova');
      authUserIds.push(donoUser.id);
      const { data: tRow } = await pg.query(`select tenant_id from entregadores where id = $1`, [motoId]).then(r2 => ({ data: r2.rows[0] }));
      const { rows: usuarioLojaRows } = await pg.query(
        `insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono Aprova','dono') returning id`,
        [tRow.tenant_id, donoUser.id]
      );
      const usuarioLojaId = usuarioLojaRows[0].id; // aprovado_por referencia usuarios_loja(id), NÃO auth.users(id)
      const sessDono = await signInAs(donoUser.email);

      const { error: eAprovaCliente, data: dAprovaCliente } = await sessDono.from('entregadores')
        .update({ status_verificacao: 'aprovado', aprovado_em: new Date().toISOString() })
        .eq('id', motoId).select('id');
      r.check(
        'loja NÃO tem policy de UPDATE em entregadores (comentário no schema: "aprovação passa pelo backend") — update via RLS não afeta linhas',
        (!dAprovaCliente || dAprovaCliente.length === 0),
        { eAprovaCliente, dAprovaCliente }
      );

      const { error: eAprovaAdmin } = await admin.from('entregadores')
        .update({ status_verificacao: 'aprovado', aprovado_em: new Date().toISOString(), aprovado_por: usuarioLojaId })
        .eq('id', motoId);
      const { data: check1 } = await admin.from('entregadores').select('status_verificacao, aprovado_em, aprovado_por').eq('id', motoId).single();
      r.check('aprovação via service role (como o backend real faria) funciona, com aprovado_por = usuarios_loja.id (não auth.users.id)', !eAprovaAdmin && check1.status_verificacao === 'aprovado' && check1.aprovado_por === usuarioLojaId, check1);

      const { error: eReprova } = await admin.from('entregadores')
        .update({ status_verificacao: 'reprovado', motivo_reprovacao: 'cnh_vencida' })
        .eq('id', motoId);
      const { data: check2 } = await admin.from('entregadores').select('status_verificacao, motivo_reprovacao').eq('id', motoId).single();
      r.check('reprovação manual via service role com motivo_reprovacao funciona', !eReprova && check2.status_verificacao === 'reprovado' && check2.motivo_reprovacao === 'cnh_vencida', check2);
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
