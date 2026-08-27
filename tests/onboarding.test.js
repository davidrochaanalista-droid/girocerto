// Onboarding: cadastro de loja, cadastro de entregador (moto e bicicleta,
// incluindo menor de idade com responsável), aprovação/reprovação manual.
// Reprovação automática por documento vencido NÃO é testada aqui — não existe
// nenhum trigger/função no schema nem lógica no app que implemente isso hoje
// (confirmado por grep em db/schema.sql e mockups/app-entregador.html); ver
// tests/COBERTURA.md.
const crypto = require('crypto');
const { newPgClient, admin, createAuthUser, signInAs, makeReporter, cleanup, criarEntregador } = require('./lib/helpers');

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

      // item 52: identidade (pessoas_entregadoras) e vínculo com a loja (entregadores)
      // agora são 2 inserts separados — não existe mockup de auto-cadastro ainda
      // (grep confirma), então exercitamos a mecânica de RLS diretamente, nos 2 passos.
      const { data, error } = await sess.from('pessoas_entregadoras').insert({
        auth_user_id: motoUser.id, nome: 'Motoboy Moto',
        tipo_veiculo: 'moto', data_nascimento: '1990-01-01',
        cpf: '11111111111', cnh_numero: '123456789', cnh_validade: '2030-01-01',
        crlv_validade: '2030-01-01', placa: 'ABC1D23',
        status_verificacao: 'em_avaliacao',
      }).select('id').single();
      r.check('cadastro de pessoa entregadora moto (CNH/CRLV/placa) funciona', !error && data, error);
      motoId = data && data.id;

      if (motoId) {
        const { error: eVinculoMoto } = await sess.from('entregadores').insert({ tenant_id: tenantId, pessoa_id: motoId });
        r.check('vínculo com a loja (entregadores) criado junto, via RLS', !eVinculoMoto, eVinculoMoto);
      }
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

      const { data, error } = await sess.from('pessoas_entregadoras').insert({
        auth_user_id: bikeUser.id, nome: 'Entregador Bike Menor',
        tipo_veiculo: 'bicicleta', data_nascimento: dataNascMenor.toISOString().slice(0, 10),
        rg_numero: '222222222', foto_rg_url: 'https://exemplo/rg.jpg',
        foto_rg_segurando_url: 'https://exemplo/selfie.jpg', foto_bicicleta_url: 'https://exemplo/bike.jpg',
        responsavel_nome: 'Responsável Legal', responsavel_documento_foto_url: 'https://exemplo/resp.jpg',
        status_verificacao: 'em_avaliacao',
      }).select('id').single();
      r.check('cadastro de entregador bicicleta menor de 18 com dados do responsável funciona', !error && data, error);
      if (data) {
        const { error: eVinculoBike } = await sess.from('entregadores').insert({ tenant_id: tenantId, pessoa_id: data.id });
        r.check('vínculo com a loja (entregadores) criado junto, via RLS (bike)', !eVinculoBike, eVinculoBike);
      }
      r.check(
        'NOTA: banco não tem CHECK/trigger de faixa etária (15–18 = só bicicleta) — só documentado em comentário, não é enforced. Não é falha do teste, é limitação real.',
        true
      );
    }

    console.log('\n=== Aprovação/reprovação manual — loja NÃO consegue via RLS direto (by design), service role consegue ===');
    if (motoId) {
      const donoUser = await createAuthUser('dono.aprova');
      authUserIds.push(donoUser.id);
      // item 52: motoId agora é o id da PESSOA — tenant_id vem do vínculo (entregadores) via pessoa_id
      const { data: tRow } = await pg.query(`select tenant_id from entregadores where pessoa_id = $1`, [motoId]).then(r2 => ({ data: r2.rows[0] }));
      const { rows: usuarioLojaRows } = await pg.query(
        `insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono Aprova','dono') returning id`,
        [tRow.tenant_id, donoUser.id]
      );
      const usuarioLojaId = usuarioLojaRows[0].id; // aprovado_por referencia usuarios_loja(id), NÃO auth.users(id)
      const sessDono = await signInAs(donoUser.email);

      const { error: eAprovaCliente, data: dAprovaCliente } = await sessDono.from('pessoas_entregadoras')
        .update({ status_verificacao: 'aprovado', aprovado_em: new Date().toISOString() })
        .eq('id', motoId).select('id');
      r.check(
        'loja NÃO tem policy de UPDATE em pessoas_entregadoras (comentário no schema: "aprovação passa pelo backend") — update via RLS não afeta linhas',
        (!dAprovaCliente || dAprovaCliente.length === 0),
        { eAprovaCliente, dAprovaCliente }
      );

      const { error: eAprovaAdmin } = await admin.from('pessoas_entregadoras')
        .update({ status_verificacao: 'aprovado', aprovado_em: new Date().toISOString(), aprovado_por: usuarioLojaId })
        .eq('id', motoId);
      const { data: check1 } = await admin.from('pessoas_entregadoras').select('status_verificacao, aprovado_em, aprovado_por').eq('id', motoId).single();
      r.check('aprovação via service role (como o backend real faria) funciona, com aprovado_por = usuarios_loja.id (não auth.users.id)', !eAprovaAdmin && check1.status_verificacao === 'aprovado' && check1.aprovado_por === usuarioLojaId, check1);

      const { error: eReprova } = await admin.from('pessoas_entregadoras')
        .update({ status_verificacao: 'reprovado', motivo_reprovacao: 'cnh_vencida' })
        .eq('id', motoId);
      const { data: check2 } = await admin.from('pessoas_entregadoras').select('status_verificacao, motivo_reprovacao').eq('id', motoId).single();
      r.check('reprovação manual via service role com motivo_reprovacao funciona', !eReprova && check2.status_verificacao === 'reprovado' && check2.motivo_reprovacao === 'cnh_vencida', check2);
    }

    console.log('\n=== Aprovação/reprovação por admin da plataforma (aprovar_entregador_teste / reprovar_entregador_teste) — sessão de 23/08/2026, corrigido depois de assumir por engano que era a loja quem aprova ===');
    {
      // tenant + dono comum (NÃO é admin) — usado só pra provar que loja
      // continua sem conseguir aprovar/reprovar, mesmo sendo dono da própria loja
      const tenantA = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1, 'Loja A - Aprovacao Admin')`, [tenantA]);
      tenantIds.push(tenantA);
      const donoA = await createAuthUser('donoA.aprovacaoadmin');
      authUserIds.push(donoA.id);
      await pg.query(
        `insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono A','dono')`,
        [tenantA, donoA.id]
      );
      const sessDonoA = await signInAs(donoA.email);

      // conta admin de teste — allowlist desenvolvedores_admin, mesma
      // mecânica de painel-dev.html/painel-admin.html. FK auth_user_id ->
      // auth.users(id) on delete cascade, então o cleanup padrão (deleta o
      // auth user) já limpa essa linha sozinho, sem passo extra.
      const admUser = await createAuthUser('admin.aprovacao');
      authUserIds.push(admUser.id);
      await pg.query(`insert into desenvolvedores_admin (auth_user_id) values ($1)`, [admUser.id]);
      const sessAdmin = await signInAs(admUser.email);

      // entregador 1 — vai ser aprovado. Tenant qualquer, sem relação de
      // posse nenhuma com o admin (admin aprova de QUALQUER loja).
      const entU1 = await createAuthUser('ent1.aprovacaoadmin');
      authUserIds.push(entU1.id);
      // item 52: aprovar/reprovar_entregador_teste agora tomam p_pessoa_id (status_verificacao é da pessoa)
      const { pessoaId: ent1Id } = await criarEntregador(pg, tenantA, entU1.id, {
        nome: 'Entregador Pra Aprovar', tipo_veiculo: 'moto', status_verificacao: 'em_avaliacao', verificacao_enviada_em: new Date().toISOString(),
      });

      const { error: eLojaTentaAprovar } = await sessDonoA.rpc('aprovar_entregador_teste', { p_pessoa_id: ent1Id });
      r.check('loja (dono da própria loja, mas não é admin) NÃO consegue aprovar (42501)', !!eLojaTentaAprovar && eLojaTentaAprovar.code === '42501', eLojaTentaAprovar);

      const { rows: checkNaoMudou } = await pg.query(`select status_verificacao from pessoas_entregadoras where id = $1`, [ent1Id]);
      r.check('tentativa da loja bloqueada não alterou status_verificacao', checkNaoMudou[0].status_verificacao === 'em_avaliacao', checkNaoMudou[0]);

      const { error: eAdminAprova } = await sessAdmin.rpc('aprovar_entregador_teste', { p_pessoa_id: ent1Id });
      const { rows: check1 } = await pg.query(`select status_verificacao, aprovado_por, aprovado_em from pessoas_entregadoras where id = $1`, [ent1Id]);
      r.check(
        'admin da plataforma aprova entregador de QUALQUER tenant (sem relação de posse) — aprovado_por fica NULL de propósito (admin não é usuarios_loja)',
        !eAdminAprova && check1[0].status_verificacao === 'aprovado' && check1[0].aprovado_por === null && check1[0].aprovado_em !== null,
        { eAdminAprova, check1: check1[0] }
      );

      // entregador 2 — vai ser reprovado
      const entU2 = await createAuthUser('ent2.aprovacaoadmin');
      authUserIds.push(entU2.id);
      const { pessoaId: ent2Id } = await criarEntregador(pg, tenantA, entU2.id, {
        nome: 'Entregador Pra Reprovar', tipo_veiculo: 'bicicleta', status_verificacao: 'em_avaliacao', verificacao_enviada_em: new Date().toISOString(),
      });

      const { error: eLojaTentaReprovar } = await sessDonoA.rpc('reprovar_entregador_teste', { p_pessoa_id: ent2Id, p_motivo: 'documento_ilegivel' });
      r.check('loja também NÃO consegue reprovar (42501)', !!eLojaTentaReprovar && eLojaTentaReprovar.code === '42501', eLojaTentaReprovar);

      const { error: eAdminReprova } = await sessAdmin.rpc('reprovar_entregador_teste', { p_pessoa_id: ent2Id, p_motivo: 'documento_ilegivel' });
      const { rows: check2 } = await pg.query(`select status_verificacao, motivo_reprovacao, aprovado_por from pessoas_entregadoras where id = $1`, [ent2Id]);
      r.check(
        'admin reprova com motivo — motivo_reprovacao gravado certo, aprovado_por continua NULL',
        !eAdminReprova && check2[0].status_verificacao === 'reprovado' && check2[0].motivo_reprovacao === 'documento_ilegivel' && check2[0].aprovado_por === null,
        { eAdminReprova, check2: check2[0] }
      );

      // entregador 3 — tenta se autoaprovar (reconfirma que reverter a
      // extensão do trigger pra loja não reabriu esse bypass)
      const entU3 = await createAuthUser('ent3.autoaprovacaoadmin');
      authUserIds.push(entU3.id);
      const { pessoaId: ent3Id } = await criarEntregador(pg, tenantA, entU3.id, {
        nome: 'Entregador Tenta Autoaprovar', tipo_veiculo: 'moto', status_verificacao: 'em_avaliacao', verificacao_enviada_em: new Date().toISOString(),
      });
      const sessEnt3 = await signInAs(entU3.email);

      const { error: eAutoaprova } = await sessEnt3.from('pessoas_entregadoras')
        .update({ status_verificacao: 'aprovado', aprovado_em: new Date().toISOString() })
        .eq('id', ent3Id);
      const { rows: check3 } = await pg.query(`select status_verificacao from pessoas_entregadoras where id = $1`, [ent3Id]);
      r.check(
        'entregador continua sem conseguir se autoaprovar via update direto (trigger bloqueia)',
        !!eAutoaprova && check3[0].status_verificacao === 'em_avaliacao',
        { eAutoaprova, check3: check3[0] }
      );
    }

    console.log('\n=== Reprovação automática por documento vencido (verificar_documentos_vencidos) ===');
    {
      const tenantDoc = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1, 'Loja Doc Vencido')`, [tenantDoc]);
      tenantIds.push(tenantDoc);
      const hoje = new Date();
      const passado = (dias) => new Date(hoje.getTime() - dias * 86400000).toISOString().slice(0, 10);
      const futuro = (dias) => new Date(hoje.getTime() + dias * 86400000).toISOString().slice(0, 10);

      // item 52: cnh_validade/crlv_validade/status_verificacao/cnh_alerta_enviado_em
      // são todos da PESSOA agora — verificar_documentos_vencidos() opera em pessoas_entregadoras.

      // CNH vencida, já 'aprovado' antes (não só em_avaliacao) — deve ser reprovado mesmo assim
      const uCnh = await createAuthUser('cnh.vencida');
      authUserIds.push(uCnh.id);
      const { pessoaId: eCnhId } = await criarEntregador(pg, tenantDoc, uCnh.id, { nome: 'CNH Vencida', tipo_veiculo: 'moto', cnh_validade: passado(1), status_verificacao: 'aprovado' });

      // CRLV vencido
      const uCrlv = await createAuthUser('crlv.vencido');
      authUserIds.push(uCrlv.id);
      const { pessoaId: eCrlvId } = await criarEntregador(pg, tenantDoc, uCrlv.id, { nome: 'CRLV Vencido', tipo_veiculo: 'moto', crlv_validade: passado(1), status_verificacao: 'aprovado' });

      // bicicleta não tem cnh/crlv_validade — não deve ser afetada mesmo rodando a função
      const uBike = await createAuthUser('bike.docverif');
      authUserIds.push(uBike.id);
      const { pessoaId: eBikeId } = await criarEntregador(pg, tenantDoc, uBike.id, { nome: 'Bike Doc', tipo_veiculo: 'bicicleta', status_verificacao: 'aprovado' });

      // aviso prévio: CNH vence em 7 dias (dentro da janela de 15), ainda não avisado
      const uAviso = await createAuthUser('cnh.aviso');
      authUserIds.push(uAviso.id);
      const { pessoaId: eAvisoId } = await criarEntregador(pg, tenantDoc, uAviso.id, { nome: 'CNH Aviso', tipo_veiculo: 'moto', cnh_validade: futuro(7), status_verificacao: 'aprovado' });

      // fora da janela de aviso (30 dias) — não deve disparar aviso ainda
      const uFora = await createAuthUser('cnh.fora');
      authUserIds.push(uFora.id);
      const { pessoaId: eForaId } = await criarEntregador(pg, tenantDoc, uFora.id, { nome: 'CNH Fora Janela', tipo_veiculo: 'moto', cnh_validade: futuro(30), status_verificacao: 'aprovado' });

      await pg.query(`select verificar_documentos_vencidos()`);

      const { rows: checkCnh } = await pg.query(`select status_verificacao, motivo_reprovacao from pessoas_entregadoras where id = $1`, [eCnhId]);
      r.check('CNH vencida reprova automaticamente (mesmo já estando aprovado antes)', checkCnh[0].status_verificacao === 'reprovado' && checkCnh[0].motivo_reprovacao === 'cnh_vencida', checkCnh[0]);

      const { rows: checkCrlv } = await pg.query(`select status_verificacao, motivo_reprovacao from pessoas_entregadoras where id = $1`, [eCrlvId]);
      r.check('CRLV vencido reprova automaticamente', checkCrlv[0].status_verificacao === 'reprovado' && checkCrlv[0].motivo_reprovacao === 'crlv_vencido', checkCrlv[0]);

      const { rows: checkBike } = await pg.query(`select status_verificacao from pessoas_entregadoras where id = $1`, [eBikeId]);
      r.check('bicicleta (sem cnh/crlv_validade) não é afetada pela reprovação automática', checkBike[0].status_verificacao === 'aprovado', checkBike[0]);

      const { rows: checkAviso1 } = await pg.query(`select cnh_alerta_enviado_em, status_verificacao from pessoas_entregadoras where id = $1`, [eAvisoId]);
      r.check('CNH vencendo em 7 dias (dentro da janela de 15) dispara aviso prévio, sem reprovar', checkAviso1[0].cnh_alerta_enviado_em !== null && checkAviso1[0].status_verificacao === 'aprovado', checkAviso1[0]);

      const { rows: checkFora } = await pg.query(`select cnh_alerta_enviado_em from pessoas_entregadoras where id = $1`, [eForaId]);
      r.check('CNH vencendo em 30 dias (fora da janela de 15) NÃO dispara aviso ainda', checkFora[0].cnh_alerta_enviado_em === null, checkFora[0]);

      // não repete o aviso numa segunda rodada da função
      const primeiroAviso = checkAviso1[0].cnh_alerta_enviado_em;
      await new Promise((res) => setTimeout(res, 1100)); // garante timestamp diferente se repetisse
      await pg.query(`select verificar_documentos_vencidos()`);
      const { rows: checkAviso2 } = await pg.query(`select cnh_alerta_enviado_em from pessoas_entregadoras where id = $1`, [eAvisoId]);
      r.check('aviso prévio NÃO repete numa segunda rodada (cnh_alerta_enviado_em não muda)', checkAviso2[0].cnh_alerta_enviado_em.getTime() === primeiroAviso.getTime(), { primeiroAviso, segundo: checkAviso2[0].cnh_alerta_enviado_em });

      // renovar a CNH (mudar a validade) reseta o aviso, pra poder avisar de novo no próximo vencimento
      await pg.query(`update pessoas_entregadoras set cnh_validade = $1 where id = $2`, [futuro(200), eAvisoId]);
      const { rows: checkReset } = await pg.query(`select cnh_alerta_enviado_em from pessoas_entregadoras where id = $1`, [eAvisoId]);
      r.check('renovar cnh_validade reseta cnh_alerta_enviado_em pra null (trigger de reset)', checkReset[0].cnh_alerta_enviado_em === null, checkReset[0]);
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
